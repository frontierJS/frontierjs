/*
 * test/run.test.ts — the rules `run()` owns that no app drive reaches.
 *
 * The session is stubbed over the `Session` interface, and ONLY for this: every
 * claim about what a real app answers is `basecamp`'s `verify:mcp`, which runs
 * the bin as a process against a real `/mcp`. What is asked here is the global
 * flags, the tenant header and the exit codes — decided before a call is made,
 * over a tool list taken from the captured fixture rather than written here —
 * and profiles, whose file is the one thing here with a permission to get wrong.
 */

import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir }                  from 'node:os'
import { join }                    from 'node:path'
import { run, EXIT, type Session } from '../src/client/run.ts'
import type { ToolListing }        from '../src/client/argv.ts'
import { fileStore, configPath, type ProfileFile, type ProfileStore } from '../src/client/profiles.ts'
import { cacheKey, fileCache, type CachedTools, type ToolCache } from '../src/client/cache.ts'
import { loadRoutes, checkRoutes, type Route } from '../src/client/routes.ts'

const TOOLS: ToolListing[] = JSON.parse(readFileSync(new URL('./fixtures/tools/basecamp-owner.json', import.meta.url), 'utf8')).tools

// One tool with a `workspace` column of its own, since no real model has one yet
// and the rule exists for the day one does.
const WITH_WORKSPACE: ToolListing = {
  name: 'sites_find',
  inputSchema: { type: 'object', properties: {
    query:      { type: 'object', properties: { workspace: { type: 'string' } } },
    directives: { type: 'object', properties: { limit: { type: 'integer' } } },
  } },
}

function harness(extra: Partial<Parameters<typeof run>[1]> = {}) {
  const seen: { headers?: Record<string, string>; call?: [string, unknown] } = {}
  const out: string[] = [], err: string[] = []
  const session: Session = {
    listTools: async () => [...TOOLS, WITH_WORKSPACE],
    callTool:  async (name, args) => { seen.call = [name, args]; return { text: JSON.stringify({ kind: 'list', data: [] }) } },
    close:     async () => {},
  }
  const opts = {
    url: 'http://app.test/mcp', token: 'fjs_key', tenantHeader: 'x-workspace-id',
    out: (t: string) => out.push(t), err: (t: string) => err.push(t),
    connect: async (_: URL, headers: Record<string, string>) => { seen.headers = headers; return session },
    ...extra,
  }
  return { seen, out, err, go: (argv: string[]) => run(argv, opts) }
}

describe('the tenant and the credential travel on the connection', () => {

  test('the key is the Bearer, and --workspace before the command names the tenant', async () => {
    const h = harness()
    expect(await h.go(['--workspace', 'w1', 'servers', 'find'])).toBe(EXIT.ok)
    expect(h.seen.headers).toEqual({ authorization: 'Bearer fjs_key', 'x-workspace-id': 'w1' })
    expect(h.seen.call).toEqual(['servers_find', {}])
  })

  test('--workspace after the command is the tenant too, and is not sent as a filter', async () => {
    const h = harness()
    expect(await h.go(['servers', 'find', '--workspace', 'w2', '--limit', '3'])).toBe(EXIT.ok)
    expect(h.seen.headers?.['x-workspace-id']).toBe('w2')
    expect(h.seen.call).toEqual(['servers_find', { directives: { limit: 3 } }])
  })

  test('a command with its own --workspace refuses the late one rather than guessing which was meant', async () => {
    const h = harness()
    expect(await h.go(['sites', 'find', '--workspace', 'w2'])).toBe(EXIT.usage)
    expect(h.err.join()).toMatch(/has a --workspace of its own; put the tenant before the command/)
    expect(h.seen.call).toBeUndefined()
  })

  test('--workspace with no configured tenant header is refused before anything is sent', async () => {
    const h = harness({ tenantHeader: undefined })
    expect(await h.go(['--workspace', 'w1', 'servers', 'find'])).toBe(EXIT.usage)
    expect(h.seen.headers).toBeUndefined()
  })
})

describe('exit codes', () => {

  test('usage is 2: an unknown option before the command, and a command not in the list', async () => {
    expect(await harness().go(['--verbose', 'servers', 'find'])).toBe(EXIT.usage)
    const h = harness()
    expect(await h.go(['servers', 'explode'])).toBe(EXIT.usage)
    expect(h.err.join()).toMatch(/'servers explode' is not offered at your standing, or does not exist/)
  })

  test('a refusal from the app is 1, and --json carries it in the envelope', async () => {
    const refusing = { listTools: async () => TOOLS, close: async () => {},
      callTool: async () => ({ isError: true, text: 'This API key needs the \'servers:write\' scope' }) }
    const h2 = harness({ connect: async () => refusing })
    expect(await h2.go(['servers', 'reboot', 's1', '--json'])).toBe(EXIT.refused)
    expect(JSON.parse(h2.out[0])).toEqual({ ok: false, error: { message: 'This API key needs the \'servers:write\' scope' } })
  })

  test('an app that cannot be reached is 3', async () => {
    const h = harness({ connect: async () => { throw new Error('ECONNREFUSED') } })
    expect(await h.go(['servers', 'find'])).toBe(EXIT.unreachable)
    expect(h.err.join()).toMatch(/could not reach http:\/\/app\.test\/mcp/)
  })
})

// ─── profiles ────────────────────────────────────────────────────────────────


function memory(initial: ProfileFile = { profiles: {} }): ProfileStore & { file: ProfileFile } {
  const m = { where: '(memory)', file: structuredClone(initial),
    read() { return structuredClone(m.file) }, write(f: ProfileFile) { m.file = structuredClone(f) } }
  return m
}

// An app that reads a good key as the owner and anything else as nobody — which
// is what junction does with a Bearer it cannot verify.
function app(goodKey: string) {
  const seen: Array<Record<string, string>> = []
  const connect = async (_: URL, headers: Record<string, string>): Promise<Session> => {
    seen.push(headers)
    const signedIn = headers.authorization === `Bearer ${goodKey}`
    return {
      listTools: async () => signedIn ? TOOLS : TOOLS.slice(0, 3),
      callTool:  async () => ({ text: JSON.stringify({ kind: 'list', data: [] }) }),
      close:     async () => {},
    }
  }
  return { seen, connect }
}

describe('profiles', () => {
  const base = (store: ProfileStore, connect: RunOptionsConnect, extra = {}) => {
    const out: string[] = [], err: string[] = []
    return { out, err, go: (argv: string[]) => run(argv, { store, connect, tenantHeader: 'x-workspace-id', out: t => out.push(t), err: t => err.push(t), ...extra }) }
  }

  test('with nothing signed in, a command says how to sign in and exits 2', async () => {
    const h = base(memory(), app('k').connect)
    expect(await h.go(['servers', 'find'])).toBe(EXIT.usage)
    expect(h.err.join()).toMatch(/not signed in — run: login --api-key - --url/)
  })

  test('login saves the key from stdin, and the next run uses it with no environment at all', async () => {
    const store = memory(), a = app('fjs_goodkey_0123')
    const h = base(store, a.connect, { readStdin: () => 'fjs_goodkey_0123\n' })
    expect(await h.go(['--workspace', 'w1', 'login', '--api-key', '-', '--url', 'http://app.test/mcp'])).toBe(EXIT.ok)
    expect(store.file).toEqual({ current: 'default', profiles: { default: { url: 'http://app.test/mcp', token: 'fjs_goodkey_0123', tenant: 'w1' } } })

    a.seen.length = 0
    expect(await base(store, a.connect).go(['servers', 'find'])).toBe(EXIT.ok)
    expect(a.seen[0]).toEqual({ authorization: 'Bearer fjs_goodkey_0123', 'x-workspace-id': 'w1' })
  })

  test('a key the app reads as nobody is refused, and nothing is saved', async () => {
    const store = memory()
    const h = base(store, app('the-real-one').connect)
    expect(await h.go(['login', '--api-key', 'fjs_typo', '--url', 'http://app.test/mcp'])).toBe(EXIT.refused)
    expect(h.err.join()).toMatch(/read this key as nobody/)
    expect(store.file.profiles).toEqual({})
  })

  test('the environment overrides the profile for one run, and the profile is untouched', async () => {
    const store = memory({ current: 'default', profiles: { default: { url: 'http://app.test/mcp', token: 'saved', tenant: 'w1' } } })
    const a = app('from-env')
    expect(await base(store, a.connect, { token: 'from-env', tenant: 'w9' }).go(['servers', 'find'])).toBe(EXIT.ok)
    expect(a.seen[0]).toEqual({ authorization: 'Bearer from-env', 'x-workspace-id': 'w9' })
    expect(store.file.profiles.default.token).toBe('saved')
  })

  test('use switches the tenant, profiles lists without showing the key, logout forgets it', async () => {
    const store = memory({ current: 'default', profiles: { default: { url: 'http://app.test/mcp', token: 'fjs_abcdefghijklmnop' } } })
    const h = base(store, app('x').connect)
    expect(await h.go(['use', 'w2'])).toBe(EXIT.ok)
    expect(store.file.profiles.default.tenant).toBe('w2')

    expect(await h.go(['profiles'])).toBe(EXIT.ok)
    expect(h.out.at(-1)).toMatch(/\* default .* tenant w2 .* key fjs_ab…mnop/)
    expect(h.out.join()).not.toContain('fjs_abcdefghijklmnop')

    expect(await h.go(['logout'])).toBe(EXIT.ok)
    expect(store.file).toEqual({ profiles: {} })
  })

  test('--profile picks a named one, and naming one that does not exist says which', async () => {
    const store = memory({ current: 'a', profiles: { a: { url: 'http://a.test/mcp', token: 'ka' }, b: { url: 'http://b.test/mcp', token: 'kb' } } })
    const urls: string[] = []
    const connect = async (u: URL, hd: Record<string, string>) => { urls.push(`${u.host} ${hd.authorization}`); return app('kb').connect(u, hd) }
    expect(await base(store, connect).go(['--profile', 'b', 'servers', 'find'])).toBe(EXIT.ok)
    expect(urls[0]).toBe('b.test Bearer kb')
    const h = base(store, connect)
    expect(await h.go(['--profile', 'c', 'servers', 'find'])).toBe(EXIT.usage)
    expect(h.err.join()).toMatch(/no profile named 'c'/)
  })

  test('the file is written 0600 under XDG_CONFIG_HOME/<app>/, and replaced whole', () => {
    const dir  = mkdtempSync(join(tmpdir(), 'fjs-profiles-'))
    const path = configPath('shop', { XDG_CONFIG_HOME: dir })
    expect(path).toBe(join(dir, 'shop', 'profiles.json'))
    const s = fileStore(path)
    s.write({ current: 'default', profiles: { default: { url: 'u', token: 't' } } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).profiles.default.token).toBe('t')
    expect(s.read().current).toBe('default')
  })
})

type RunOptionsConnect = NonNullable<Parameters<typeof run>[1]['connect']>

// ─── the cache ───────────────────────────────────────────────────────────────

function memoryCache(): ToolCache & { map: Map<string, CachedTools> } {
  const map = new Map<string, CachedTools>()
  return { map, get: k => map.get(k) ?? null, set: (k, v) => { map.set(k, v) } }
}

/** An app at a build, counting how often the tree is asked for. */
function deployed(build: string | null, tools: ToolListing[] = TOOLS) {
  const state = { build, tools, lists: 0 }
  const connect = async (): Promise<Session> => ({
    build:     () => state.build,
    listTools: async () => { state.lists++; return state.tools },
    callTool:  async () => ({ text: JSON.stringify({ kind: 'list', data: [] }) }),
    close:     async () => {},
  })
  return { state, connect }
}

describe('the command tree is cached per build', () => {
  const go = (cache: ToolCache, connect: RunOptionsConnect, argv: string[], token = 'k1') =>
    run(argv, { url: 'http://app.test/mcp', token, cache, connect, out: () => {}, err: () => {} })

  test('a deployed app is listed once, and the next run answers from the cache', async () => {
    const cache = memoryCache(), app = deployed('b1')
    expect(await go(cache, app.connect, ['servers', 'find'])).toBe(EXIT.ok)
    expect(await go(cache, app.connect, ['servers', 'find'])).toBe(EXIT.ok)
    expect(app.state.lists).toBe(1)
  })

  test('a new build is listed live, and replaces what was kept', async () => {
    const cache = memoryCache(), app = deployed('b1')
    await go(cache, app.connect, ['servers', 'find'])
    app.state.build = 'b2'
    await go(cache, app.connect, ['servers', 'find'])
    expect(app.state.lists).toBe(2)
    expect([...cache.map.values()][0].build).toBe('b2')
  })

  test('an app that states no build is never cached — a dev server changes under its own feet', async () => {
    const cache = memoryCache(), app = deployed(null)
    await go(cache, app.connect, ['servers', 'find'])
    await go(cache, app.connect, ['servers', 'find'])
    expect(app.state.lists).toBe(2)
    expect(cache.map.size).toBe(0)
  })

  test('another key is another list — a cache hit is never a different caller\'s tree', async () => {
    const cache = memoryCache(), app = deployed('b1')
    await go(cache, app.connect, ['servers', 'find'], 'k1')
    await go(cache, app.connect, ['servers', 'find'], 'k2')
    expect(app.state.lists).toBe(2)
    expect(cacheKey('u', 'k1', 'w1')).not.toBe(cacheKey('u', 'k1', 'w2'))
    expect(cacheKey('u', 'secret-key', undefined)).not.toContain('secret-key')
  })

  test('a command missing from a cached tree is asked for live before it is called not offered', async () => {
    const cache = memoryCache()
    const app = deployed('b1', TOOLS.filter(t => t.name !== 'servers_reboot'))
    await go(cache, app.connect, ['servers', 'find'])
    // Promoted without a deploy: the build is the same, the standing is not.
    app.state.tools = TOOLS
    expect(await go(cache, app.connect, ['servers', 'reboot', 's1'])).toBe(EXIT.ok)
    expect(app.state.lists).toBe(2)
  })

  test('on disk it is 0600, holds no key, and an unreadable file is a miss rather than an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-cache-'))
    const c   = fileCache(dir)
    const key = cacheKey('http://app.test/mcp', 'fjs_live_key', undefined)
    c.set(key, { build: 'b1', tools: TOOLS.slice(0, 2) })
    const path = join(dir, `${key}.json`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain('fjs_live_key')
    expect(c.get(key)?.build).toBe('b1')
    writeFileSync(path, '{ half a docum')
    expect(c.get(key)).toBeNull()
  })
})

// ─── routes ──────────────────────────────────────────────────────────────────


const route = (over: Partial<Route>): Route => ({
  service: 'servers', method: 'status', file: 'routes/servers/status.js',
  description: 'test route', uses: ['servers_find'], run: () => {}, ...over,
})

describe('routes', () => {
  const go = (routes: Route[], argv: string[], tools = TOOLS) => {
    const out: string[] = [], err: string[] = [], calls: string[] = []
    const connect = async (): Promise<Session> => ({
      listTools: async () => tools,
      callTool:  async (name) => { calls.push(name); return name === 'servers_reboot'
        ? { isError: true, text: 'refused by the app' }
        : { text: JSON.stringify({ kind: 'list', data: [{ id: 's1' }] }) } },
      close: async () => {},
    })
    return run(argv, { url: 'http://app.test/mcp', routes, connect, out: t => out.push(t), err: t => err.push(t) })
      .then(code => ({ code, out, err, calls }))
  }

  test('a route adds a command, parses its own input, and calls the tool it declared', async () => {
    let seen: unknown
    const r = await go([route({
      input: { type: 'object', properties: { role: { type: 'string', enum: ['build', 'worker'] } } },
      run: async ({ args, call, out }) => { seen = args; out(JSON.stringify(await call('servers_find'))) },
    })], ['servers', 'status', '--role', 'build'])
    expect(r.code).toBe(EXIT.ok)
    expect(seen).toEqual({ role: 'build' })
    expect(r.calls).toEqual(['servers_find'])
  })

  test('a route of a derived command\'s name replaces it', async () => {
    const r = await go([route({ method: 'find', run: ({ out }) => out('the route ran') })], ['servers', 'find'])
    expect(r.out).toEqual(['the route ran'])
    expect(r.calls).toEqual([])
  })

  test('a route whose tool the caller is not offered is not offered either — the same absence as a tool', async () => {
    const r = await go([route({ uses: ['servers_reboot'] })], ['servers', 'status'], TOOLS.filter(t => t.name !== 'servers_reboot'))
    expect(r.code).toBe(EXIT.usage)
    expect(r.err.join()).toMatch(/'servers status' is not offered at your standing/)
  })

  test('a call outside `uses` is refused, and an app refusal inside one exits 1', async () => {
    const outside = await go([route({ run: async ({ call }) => { await call('servers_reboot', { id: 's1' }) } })], ['servers', 'status'])
    expect(outside.code).toBe(EXIT.refused)
    expect(outside.err.join()).toMatch(/calls servers_reboot, which is not in its uses/)
    expect(outside.calls).toEqual([])

    const refused = await go([route({ uses: ['servers_reboot'], run: async ({ call }) => { await call('servers_reboot', { id: 's1' }) } })], ['servers', 'status'])
    expect(refused.code).toBe(EXIT.refused)
    expect(refused.err).toEqual(['refused by the app'])
  })

  test('checkRoutes names a route whose tool is gone, and passes one whose tools all exist', () => {
    expect(checkRoutes([route({})], TOOLS)).toEqual([])
    expect(checkRoutes([route({ uses: ['servers_teleport'] })], TOOLS)[0]).toMatch(/servers status .* uses servers_teleport, which the app no longer offers/)
  })

  test('loadRoutes reads <service>/<method> files, and refuses one at the top of routes/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-routes-'))
    mkdirSync(join(dir, 'servers'))
    writeFileSync(join(dir, 'servers', 'status.js'), "export default { description: 'd', uses: ['servers_find'], run() {} }\n")
    const loaded = await loadRoutes(dir)
    expect(loaded.map(r => `${r.service} ${r.method}`)).toEqual(['servers status'])

    writeFileSync(join(dir, 'stray.js'), 'export default {}\n')
    await expect(loadRoutes(dir)).rejects.toThrow(/a route is <service>\/<method>/)
  })
})

// ─── breadcrumbs ─────────────────────────────────────────────────────────────

describe('breadcrumbs are spelled as this program\'s own command lines', () => {

  const SERVER = { id: 's1', name: 'web-1', status: 'online', workspaceId: 'w 1' }
  const CRUMBS = [
    { kind: 'move',      tool: 'servers_drain',  args: { id: 's1' }, move: 'drain', field: 'status', to: 'draining' },
    { kind: 'belongsTo', tool: 'workspaces_get', args: { id: 'w 1' }, relation: 'workspace' },
    { kind: 'hasMany',   tool: 'volumes_find',   args: { query: { serverId: 's1' } }, relation: 'volumes' },
    { kind: 'hasMany',   tool: 'volumes_find',   args: { query: { nope: 1 } }, relation: 'odd' },
  ] as const

  const answering = () => harness({
    connect: async () => ({
      listTools: async () => TOOLS,
      callTool:  async () => ({ text: JSON.stringify(SERVER), breadcrumbs: CRUMBS as never }),
      close:     async () => {},
    }),
  })

  test('on stderr, after the row: the id positional, a filter as its flag, an unflagged column through --query, and a value quoted when a shell would split it', async () => {
    const h = answering()
    expect(await h.go(['servers', 'get', 's1'])).toBe(EXIT.ok)
    expect(h.out.join('\n')).toContain('web-1')
    expect(h.err).toEqual([
      '· servers drain s1  — drain: status → draining',
      "· workspaces get 'w 1'  — the workspace this points at",
      '· volumes find --serverId s1  — its volumes',
      `· volumes find --query '{"nope":1}'  — its odd`,
    ])
  })

  test('--json carries them in the envelope and prints nothing on stderr; --quiet is the data alone', async () => {
    const j = answering()
    await j.go(['--json', 'servers', 'get', 's1'])
    expect(JSON.parse(j.out[0])).toEqual({ ok: true, data: SERVER, breadcrumbs: CRUMBS })
    expect(j.err).toEqual([])

    const q = answering()
    await q.go(['--quiet', 'servers', 'get', 's1'])
    expect(JSON.parse(q.out[0])).toEqual(SERVER)
    expect(q.err).toEqual([])
  })
})
