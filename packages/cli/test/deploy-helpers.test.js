import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, rmSync, mkdirSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

// ── Temp project dir — fresh per test (unique path so import cache doesn't ──
// return a stale module from a previous test that wrote to the same file).
let TMP

beforeEach(() => {
  TMP = resolve(ROOT, `.tmp-deploy-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(TMP, { recursive: true })
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

// ── Helpers ──────────────────────────────────────────────────────────────────

const writeConfig = (obj) => {
  writeFileSync(
    resolve(TMP, 'frontier.config.js'),
    `export default ${JSON.stringify(obj, null, 2)}\n`
  )
}

// Import after globals are set so module cache is fresh each test
const { loadFrontierConfig } = await import('../core/utils.js')

import { readFileSync } from 'fs'

// Set global.fliRoot so the _module.md script can resolve its dynamic import
// (it does `await import(new URL('file://' + global.fliRoot + '/core/utils.js'))`)
global.fliRoot ??= ROOT

async function loadModuleHelpers() {
  const modulePath = resolve(ROOT, 'commands/deploy/_module.md')
  const src        = readFileSync(modulePath, 'utf8')
  const scriptMatch = src.match(/<script>([\s\S]+?)<\/script>/)
  if (!scriptMatch) throw new Error('No <script> block in _module.md')

  // The script uses `await import(...)` at top level, so we need an async
  // function constructor (the regular `new Function` constructor only builds
  // sync function bodies — top-level await throws SyntaxError).
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
  const fn = new AsyncFunction(`
    ${scriptMatch[1]}
    return { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, deployTargetFor, appIdOf, sshHost, swapContainer, litestreamInstall, aptIdle }
  `)
  return fn()
}

const { resolveTarget, resolveDeployConf, resolveSide, deployConfFor, deployTargetFor, swapContainer, aptIdle } = await loadModuleHelpers()

// ─── loadFrontierConfig ───────────────────────────────────────────────────────

describe('loadFrontierConfig', () => {

  test('returns null when no frontier.config.js exists', async () => {
    const result = await loadFrontierConfig(TMP)
    expect(result).toBeNull()
  })

  test('returns the default export when file exists', async () => {
    writeConfig({ deploy: { server: 'myapp.com', path: '/apps/myapp' } })
    const result = await loadFrontierConfig(TMP)
    expect(result).not.toBeNull()
    expect(result.deploy.server).toBe('myapp.com')
  })

  // FJS-1932: a file that is there and will not load is a refusal, not "no
  // config" -- null here sent a deploy on to defaults after a yellow warning.
  test('refuses, naming the file, when config is malformed', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export default {{{invalid')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js could not be loaded/)
  })

  test('refuses when config has no default export', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export const x = 1\n')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js .*default/)
  })

  test('refuses a default export that is not an object', async () => {
    writeFileSync(resolve(TMP, 'frontier.config.js'), 'export default ["deploy"]\n')
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js .*object/)
  })

  test('refuses an unknown top-level key by name, pointing at its bucket', async () => {
    writeConfig({ deploy: { server: 'myapp.com' }, services: { include: ['User'] } })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/frontier\.config\.js has no key "services".*schema\.lite/)
  })

  test('an env-shaped key points at env', async () => {
    writeConfig({ deploy: { server: 'myapp.com' }, DATABASE_URL: './x.db' })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/no key "DATABASE_URL".*env/)
  })

  test('a junction.config.js key points at junction.config.js', async () => {
    writeConfig({ plugins: ['@frontierjs/auth'] })
    await expect(loadFrontierConfig(TMP)).rejects.toThrow(/no key "plugins".*junction\.config\.js/)
  })

  test('reads nested deploy block correctly', async () => {
    writeConfig({
      deploy: {
        server: 'myapp.com',
        user:   'deploy',
        path:   '/apps/myapp',
        api:    { port: 4000, health: '/ping' },
        web:    { domain: 'myapp.com', keep_releases: 5 },
      }
    })
    const result = await loadFrontierConfig(TMP)
    expect(result.deploy.api.port).toBe(4000)
    expect(result.deploy.web.keep_releases).toBe(5)
  })

  test('reads per-target overrides', async () => {
    writeConfig({
      deploy: {
        server:     'dev.myapp.com',
        path:       '/apps/myapp',
        production: { server: 'prod.myapp.com' },
      }
    })
    const result = await loadFrontierConfig(TMP)
    expect(result.deploy.server).toBe('dev.myapp.com')
    expect(result.deploy.production.server).toBe('prod.myapp.com')
  })

})

// ─── resolveTarget ────────────────────────────────────────────────────────────

describe('resolveTarget', () => {

  const git = (branch) => ({ branch: () => branch })

  test('returns production when --production flag is set', () => {
    expect(resolveTarget({ production: true }, git('main'))).toBe('production')
  })

  test('--production overrides branch', () => {
    expect(resolveTarget({ production: true }, git('staging'))).toBe('production')
  })

  test('returns stage when --stage flag is set', () => {
    expect(resolveTarget({ stage: true }, git('main'))).toBe('stage')
  })

  test('returns stage when branch is "stage"', () => {
    expect(resolveTarget({}, git('stage'))).toBe('stage')
  })

  test('returns stage when branch is "staging"', () => {
    expect(resolveTarget({}, git('staging'))).toBe('stage')
  })

  test('returns dev for any other branch', () => {
    expect(resolveTarget({}, git('main'))).toBe('dev')
    expect(resolveTarget({}, git('feature/foo'))).toBe('dev')
    expect(resolveTarget({}, git(''))).toBe('dev')
  })

  test('returns dev when no flags and no branch', () => {
    expect(resolveTarget({}, { branch: () => '' })).toBe('dev')
  })

  test('handles null git object gracefully', () => {
    expect(resolveTarget({}, null)).toBe('dev')
  })

})

// ─── resolveDeployConf ────────────────────────────────────────────────────────

describe('resolveDeployConf', () => {

  test('returns null when deployConf is null', () => {
    expect(resolveDeployConf(null, 'dev')).toBeNull()
  })

  test('returns null when server is missing', () => {
    expect(resolveDeployConf({ path: '/apps/myapp' }, 'dev')).toBeNull()
  })

  test('returns null when path is missing', () => {
    expect(resolveDeployConf({ server: 'myapp.com' }, 'dev')).toBeNull()
  })

  test('returns resolved values for top-level config', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', user: 'deploy', path: '/apps/myapp' },
      'dev'
    )
    expect(conf).toEqual({ server: 'myapp.com', user: 'deploy', path: '/apps/myapp', host: 'deploy@myapp.com' })
  })

  // An alias in ~/.ssh/config carries its own User; `deploy@myvps` would override it.
  test('no user stated → the bare server, so ssh config supplies the user', () => {
    const conf = resolveDeployConf(
      { server: 'myvps', path: '/apps/myapp' },
      'dev'
    )
    expect(conf.user).toBeNull()
    expect(conf.host).toBe('myvps')
  })

  test('applies target-specific server override', () => {
    const conf = resolveDeployConf(
      { server: 'dev.myapp.com', path: '/apps/myapp', production: { server: 'prod.myapp.com' } },
      'production'
    )
    expect(conf.server).toBe('prod.myapp.com')
    expect(conf.path).toBe('/apps/myapp')   // falls back to top-level
  })

  test('applies target-specific path override', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/dev', production: { path: '/apps/prod' } },
      'production'
    )
    expect(conf.path).toBe('/apps/prod')
    expect(conf.server).toBe('myapp.com')   // falls back to top-level
  })

  test('applies target-specific user override', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/myapp', user: 'dev-user', production: { user: 'prod-user' } },
      'production'
    )
    expect(conf.user).toBe('prod-user')
  })

  test('unknown target falls back to top-level values', () => {
    const conf = resolveDeployConf(
      { server: 'myapp.com', path: '/apps/myapp' },
      'staging'
    )
    expect(conf.server).toBe('myapp.com')
    expect(conf.path).toBe('/apps/myapp')
  })

  test('all three fields overridden for a target', () => {
    const conf = resolveDeployConf({
      server: 'dev.myapp.com', user: 'dev', path: '/apps/dev',
      production: { server: 'prod.myapp.com', user: 'prod', path: '/apps/prod' }
    }, 'production')
    expect(conf).toEqual({ server: 'prod.myapp.com', user: 'prod', path: '/apps/prod', host: 'prod@prod.myapp.com' })
  })

})

// ─── deployConfFor — --server and the placeholder ─────────────────────────────

// ─── deployTargetFor ──────────────────────────────────────────────────────────

describe('deployTargetFor', () => {

  const ctx = () => ({ paths: { get root() { return TMP } }, git: { branch: () => '' }, config: {} })
  const sink = () => { const errors = []; return { errors, log: { error: (m) => errors.push(m) } } }

  test('no app_id refuses by name before anything resolves', async () => {
    writeConfig({ deploy: { server: 'a.com', path: '/apps/x' } })
    const $ = ctx(), { errors, log } = sink()
    expect(await deployTargetFor($, {}, log)).toBeNull()
    expect($.config.abort).toBe(true)
    expect(errors.join('\n')).toContain('deploy.app_id')
  })

  test('a per-target path leaves the app id where the deploy put it', async () => {
    writeConfig({ deploy: { server: 'a.com', path: '/apps/x', app_id: 'x', production: { path: '/apps/x-prod' } } })
    const head = await deployTargetFor(ctx(), { production: true }, sink().log, { side: 'api' })
    expect(head.target).toBe('production')
    expect(head.resolved.path).toBe('/apps/x-prod')
    expect(head.appId).toBe('x')
  })

  test('a side list takes the first that resolves', async () => {
    writeConfig({ deploy: { server: 'a.com', app_id: 'x', web: { path: '/srv/web' } } })
    const head = await deployTargetFor(ctx(), {}, sink().log, { side: ['api', 'web'] })
    expect(head.resolved.path).toBe('/srv/web')
  })
})

describe('deployConfFor', () => {

  const $ = { paths: { get root() { return TMP } } }

  test('--server replaces every server and user, per target and per side', async () => {
    writeConfig({ deploy: {
      server: 'a.com', user: 'deploy', path: '/apps/x',
      api: { server: 'api.a.com', user: 'ops', port: 3000 },
      production: { server: 'prod.a.com', user: 'root', web: { server: 'w.a.com' } },
    } })
    const conf = await deployConfFor($, { server: 'myvps' })
    for (const target of ['dev', 'production']) {
      for (const side of ['api', 'web', 'builder']) {
        const r = resolveSide(conf, target, side)
        expect(r.host).toBe('myvps')
        expect(r.path).toBe('/apps/x')
      }
    }
    expect(conf.api.port).toBe(3000)
  })

  test('--server accepts user@host whole', async () => {
    writeConfig({ deploy: { server: 'a.com', user: 'deploy', path: '/apps/x' } })
    const conf = await deployConfFor($, { server: 'root@1.2.3.4' })
    expect(resolveDeployConf(conf, 'dev').host).toBe('root@1.2.3.4')
  })

  test('the scaffold placeholder resolves to no server, and says why', async () => {
    writeConfig({ deploy: { server: 'your-server.com', path: '/apps/x' } })
    const errors = []
    const conf = await deployConfFor($, {}, { error: (m) => errors.push(m) })
    expect(conf.server).toBeUndefined()
    expect(resolveDeployConf(conf, 'dev')).toBeNull()
    expect(errors[0]).toContain('--server')
  })

  test('--server wins over the placeholder', async () => {
    writeConfig({ deploy: { server: 'your-server.com', path: '/apps/x' } })
    const conf = await deployConfFor($, { server: 'myvps' }, { error: () => { throw new Error('refused') } })
    expect(resolveDeployConf(conf, 'dev').host).toBe('myvps')
  })

})

// ─── dockerfileScripts ────────────────────────────────────────────────────────
//
// `deploy:doctor` requires every script the image's entrypoint runs. It used to
// assert the TEMPLATE's pair — `db:migrate` then `start` — which refuses an app
// whose Dockerfile is correct and different: basecamp migrates at boot inside
// app.ts on purpose, has no `db:migrate`, and was blocked from a deploy that
// works (FJS-417).

describe('dockerfileScripts', () => {
  const parse = async (src) => {
    const { dockerfileScripts } = await import('../core/utils.js')
    return dockerfileScripts(src)
  }

  test('reads the exec form', async () => {
    expect(await parse('CMD ["bun", "run", "start"]')).toEqual(['start'])
  })

  test('reads the shell form, including a chain', async () => {
    expect((await parse('CMD bun run db:migrate && bun run start')).sort())
      .toEqual(['db:migrate', 'start'])
  })

  test('reads the generated template — both scripts, exec form', async () => {
    expect((await parse('CMD ["sh", "-c", "bun run db:migrate && bun run start"]')).sort())
      .toEqual(['db:migrate', 'start'])
  })

  test('a script name with a colon or a dot survives', async () => {
    expect(await parse('ENTRYPOINT ["bun", "run", "db:migrate.prod"]')).toEqual(['db:migrate.prod'])
  })

  test('ENTRYPOINT counts too', async () => {
    expect(await parse('ENTRYPOINT ["bun", "run", "serve"]')).toEqual(['serve'])
  })

  test('a RUN line is not an entrypoint', async () => {
    // A build step has already succeeded by the time an image exists; requiring
    // its script at deploy time fails an image that is sitting there working.
    expect(await parse('RUN bun run build\nCMD ["bun", "run", "start"]')).toEqual(['start'])
  })

  test('a non-bun entrypoint yields nothing rather than guessing', async () => {
    expect(await parse('CMD ["node", "server.js"]')).toEqual([])
  })

  test('duplicates collapse', async () => {
    expect(await parse('CMD bun run start && bun run start')).toEqual(['start'])
  })

  test('an empty or absent Dockerfile is not an error', async () => {
    expect(await parse('')).toEqual([])
    expect(await parse(undefined)).toEqual([])
  })

  // Its CMD runs the entry file itself rather than a script, so a second bun
  // process is not kept alive for the container's life; the doctor requires
  // nothing of its package.json.
  test('basecamp\'s real Dockerfile runs the entry file and asks for no script', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(resolve(ROOT, '../basecamp/deploy/Dockerfile'), 'utf8')
    expect(await parse(src)).toEqual([])
  })
})


// ─── unexecdEntrypoint ────────────────────────────────────────────────────────
// FJS-3943: a chain under sh -c leaves sh as PID 1, which drops SIGTERM.
describe('unexecdEntrypoint', () => {
  const find = async (src) => {
    const { unexecdEntrypoint } = await import('../core/utils.js')
    return unexecdEntrypoint(src)
  }

  test('a chain whose last command is not exec\'d is named', async () => {
    const line = 'CMD ["sh", "-c", "bun run db:migrate && bun run start"]'
    expect(await find(`FROM oven/bun\n${line}\n`)).toBe(line)
    expect(await find('CMD bun run db:migrate && bun run start')).not.toBeNull()
    expect(await find('ENTRYPOINT ["/bin/sh", "-c", "a; b"]')).not.toBeNull()
  })

  test('an exec\'d last command passes', async () => {
    expect(await find('CMD ["sh", "-c", "bun run db:migrate && exec bun run start"]')).toBeNull()
    expect(await find('CMD bun run db:migrate && exec bun run start')).toBeNull()
  })

  test('the exec form with no shell and a lone command are not read', async () => {
    expect(await find('CMD ["bun", "run", "start"]')).toBeNull()
    expect(await find('CMD ["sh", "-c", "bun run start"]')).toBeNull()
    expect(await find('RUN a && b')).toBeNull()
    expect(await find('')).toBeNull()
  })
})

// ─── swapContainer ────────────────────────────────────────────────────────────
//
// The swap and its health check, over a recording ssh exec and the fake daemon
// Outpost's contract table runs against (`FJS-D1866`). The script travels on
// STDIN to `sh -s` (core/machine.js), so what a step actually sends is `input`
// and never the command line; a `docker …` script is handed to the daemon, a
// curl loop answers by the image the App's container is on.
//
// `deployConf` is an option and not a free name: a free one threw after the
// running container had been stopped (`FJS-726`), and nothing but a run of the
// function could see it.

const { CASES, fakeDaemon, imagesOn, dockerOnly, routesOf } = await import('../../outpost/test/fixtures/swap-cases.js')
const edgeModule = await import('../core/edge.js')

const words = (script) => (script.match(/'(?:[^']|'\\'')*'|\S+/g) ?? [])
  .map(w => /^'.*'$/.test(w) ? w.slice(1, -1).replace(/'\\''/g, "'") : w)

// `caddy` is the admin API's config, null for a box Caddy fronts nothing on;
// `dials` collects the API port every write pointed the routes at, and each
// write is a `route <port>` in the daemon's log, where the table states it. `verdict` is
// what the new image's `litestone release --json` answers.
const onBox = ({ before = {}, ids = '', ls = '', inEnv = '', open = '', caddy = null, verdict = null, refuses = [], dry = false } = {}) => {
  const d = fakeDaemon(before, { refuses })
  const commands = []
  const dials = []
  let config = caddy
  const context = {
    config: {},
    paths: { root: ROOT },
    flag: { dry },
    exec: ({ command, input }) => {
      const body = String(input ?? command).replace(/^exec 2>&1\n/, '')
      commands.push(body)
      if (body.includes('id -u fjs-')) return ids
      if (body.includes('ls -1A')) return ls
      if (body.includes('grep -qs')) return inEnv
      if (body.includes('/proc/')) return open
      if (body.startsWith('curl -s -D -')) return config ? `HTTP/1.1 200 OK\netag: "e1"\n\n${JSON.stringify(config)}` : ''
      if (body.includes('/config/')) {
        config = JSON.parse(body.split('\n').slice(1, -1).join('\n'))
        dials.push(Number(/127\.0\.0\.1:(\d+)/.exec(JSON.stringify(config))[1]))
        d.log.push(`route ${dials.at(-1)}`)
        return '\n200'
      }
      if (body.includes('litestone release')) return verdict ? JSON.stringify({ verdict }) : 'bun: command not found'
      if (body.startsWith('docker create')) return 'held1'
      if (/^docker (rm -f held1|volume rm)/.test(body)) return ''
      if (body.includes('curl')) {
        // A start-first's `_next` is published on the port the fake daemon names for it.
        if (d.healthOf(body.includes(':49153') && d.box.has('app_next') ? 'app_next' : 'app').healthy) return 'ok'
        throw new Error('fail')
      }
      if (body.startsWith('docker ')) {
        const r = d.argv(words(body))
        if (r.exitCode !== 0) throw Object.assign(new Error(r.stderr), { status: r.exitCode, stderr: r.stderr, stdout: '' })
        return r.stdout
      }
      return ''
    },
  }
  const go = (opts = {}) => swapContainer(context, {
    host: 'localhost', container: 'app', image: 'img:new', apiPort: 7102,
    dbPath: '/srv/db', envFile: '/srv/.env.production', deployConf: {}, healthPath: '/api/health',
    attempts: 1, intervalS: 0,
    log: { info() {}, success() {}, warn() {}, error() {} },
    ...opts,
  })
  return { d, commands, dials, go, runCmd: () => commands.find(c => c.startsWith('docker run')) }
}

const old = { image: 'img:old', running: true }

describe('swapContainer — the swap Outpost runs', () => {
  const routed = (port) => edgeModule.applyEdge({}, {
    appId: 'app1',
    routes: edgeModule.edgeRoutes({ appId: 'app1', serverPath: '/srv', apiPort: port, web: { domain: 'app.test' }, api: { domain: null } }),
  })
  for (const c of CASES.filter(c => c.swap === 'stop-first')) {
    test(c.case, async () => {
      const t = onBox({ before: c.before, refuses: c.refuses, caddy: c.dials ? routed(c.dials) : null })
      const result = await t.go({ image: c.image, appId: 'app1' })
      expect(t.d.log).toEqual(dockerOnly(c.log))
      expect(imagesOn(t.d.box)).toEqual(c.after)
      expect(result.healthy).toBe(!c.throws)
      if (c.throws) expect(result.reason).toMatch(c.throws)
    })
  }

  test('a docker run line with a value the shell would read reaches the target quoted', async () => {
    const t = onBox()
    await t.go({ deployConf: { logs: { max_size: '10m; rm -rf /' } } })
    expect(t.runCmd()).toContain(`--log-opt 'max-size=10m; rm -rf /'`)
    expect(t.d.box.get('app').image).toBe('img:new')
  })

  // FJS-4019: Outpost's probe, so one release is healthy on both paths alike,
  // and a hung health path is given up on rather than holding the loop.
  test('the health poll asks Outpost\'s status and timeout, until a deadline at the budget', async () => {
    const { HEALTHY_STATUS, HEALTH_CHECK_TIMEOUT_S } = await import('../core/swap.js')
    const t = onBox()
    await t.go({ deployConf: { healthTimeout: 12 } })
    const poll = t.commands.find(c => c.includes('%{http_code}'))
    expect(poll).toContain(`--max-time ${HEALTH_CHECK_TIMEOUT_S} `)
    expect(poll).toContain(`[ "$STATUS" = "${HEALTHY_STATUS}" ]`)
    // FJS-4029: a count of polls overran the budget by the hung ask each cost.
    expect(poll).toContain('DEADLINE=$(( $(date +%s) + 12 ))')
    expect(poll).toContain('[ "$(date +%s)" -lt "$DEADLINE" ] || break')
    expect(poll).not.toContain('seq 1')
  })
})

// ─── start-first over ssh ────────────────────────────────────────────────────
// The same verdict and the same sequence Outpost runs (`FJS-D1840`): the
// table's start-first cases through the cli's swap, its routes in a fake Caddy.
// The live `app` publishes 7300 in the fake daemon and `_next` 49153.
describe('swapContainer — start-first', () => {
  const { edgeRoutes, applyEdge } = edgeModule
  const routed = (port = 7300) => applyEdge({}, {
    appId: 'app1',
    routes: edgeRoutes({ appId: 'app1', serverPath: '/srv', apiPort: port, web: { domain: 'app.test' }, api: { domain: null } }),
  })
  const startFirst = { swap: 'startFirst', web: { domain: 'app.test' } }
  const go = (t, opts = {}) => t.go({ appId: 'app1', serverPath: '/srv', deployConf: startFirst, ...opts })

  // With no live container there is no schema to classify against, so the cli
  // swaps stop-first (`livePivot`): the rows that start from one run on Outpost alone.
  for (const c of CASES.filter(c => c.swap === 'start-first' && !(c.dials && !('app' in c.before)))) {
    test(c.case, async () => {
      const t = onBox({ before: c.before, refuses: c.refuses, caddy: routed(c.dials ?? 7300), verdict: 'expand' })
      if (c.refuses) {
        // Past the route, with no `restored` or `untouched`: the error is thrown, the new release serving.
        await expect(go(t, { image: c.image })).rejects.toThrow(c.throws)
        expect(t.d.log).toEqual(c.log)
        expect(imagesOn(t.d.box)).toEqual(c.after)
        return
      }
      const result = await go(t, { image: c.image })
      expect(t.d.log).toEqual(c.log)
      expect(imagesOn(t.d.box)).toEqual(c.after)
      expect(t.dials).toEqual(routesOf(c.log))
      expect(result).toMatchObject({ swap: 'start-first', pivot: 'expand', swapReason: null, healthy: !c.throws })
      if (c.throws) expect(result).toMatchObject({ untouched: true, restored: true, port: 7300 })
      else          expect(result.port).toBe(c.port)
    })
  }

  test('a contract swaps stop-first, says why, and moves the routes back onto apiPort', async () => {
    const t = onBox({ before: { app: old }, caddy: routed(), verdict: 'contract' })
    const result = await go(t)
    expect(result).toMatchObject({ healthy: true, swap: 'stop-first', pivot: 'contract', port: 7102 })
    expect(result.swapReason).toMatch(/this deploy is the pivot/)
    expect(t.d.log).toContain('run app img:new')
    expect(t.dials).toEqual([7102])
  })

  // FJS-4018: the live release a start-first left is on a port Docker picked,
  // so the routes stay on it until the stop-first's new container answers.
  const overlapped = { image: 'img:old', running: true, port: 49153, picked: true }

  test('a stop-first after a start-first moves the routes once the new one answers', async () => {
    const t = onBox({ before: { app: overlapped }, caddy: routed(49153), verdict: 'contract' })
    expect(await go(t)).toMatchObject({ healthy: true, swap: 'stop-first', port: 7102 })
    expect(t.d.log).toEqual(['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:new', 'route 7102', 'rm app_replaced'])
  })

  test('a stop-first after a start-first that is put back moves the routes to the port it came back on', async () => {
    const t = onBox({ before: { app: overlapped }, caddy: routed(49153), verdict: 'contract' })
    expect(await go(t, { image: 'img:sick' })).toMatchObject({ healthy: false, restored: true, port: 49154 })
    expect(t.d.log.slice(-4)).toEqual(['rm app', 'rename app_replaced app', 'start app', 'route 49154'])
    expect(t.dials).toEqual([49154])
  })

  test('an image without the classifier swaps stop-first', async () => {
    const t = onBox({ before: { app: old }, caddy: routed(), verdict: null })
    const result = await go(t)
    expect(result).toMatchObject({ swap: 'stop-first', pivot: null })
    expect(result.swapReason).toMatch(/the classifier did not run/)
  })

  test('an app Caddy does not front swaps stop-first without asking the classifier', async () => {
    const t = onBox({ before: { app: old }, verdict: 'expand' })
    const result = await go(t)
    expect(result.swap).toBe('stop-first')
    expect(result.swapReason).toMatch(/Caddy holds no route for this app/)
    expect(t.commands.some(c => c.includes('litestone release'))).toBe(false)
  })

  test('an app that did not ask runs no classifier and stays on apiPort', async () => {
    const t = onBox({ before: { app: old }, caddy: routed(7102), verdict: 'expand' })
    const result = await go(t, { deployConf: { web: { domain: 'app.test' } }, apiPort: 7300 })
    expect(result).toMatchObject({ healthy: true, swap: 'stop-first', swapReason: null, pivot: null })
    expect(t.commands.some(c => c.includes('litestone release'))).toBe(false)
    expect(t.dials).toEqual([])
  })

  test('a misspelled deploy.swap is refused before anything is touched', async () => {
    const t = onBox({ before: { app: old }, caddy: routed(), verdict: 'expand' })
    await expect(go(t, { deployConf: { swap: 'start-first' } })).rejects.toThrow(/deploy.swap is 'stopFirst' or 'startFirst' — got 'start-first'/)
    expect(t.d.log).toEqual([])
  })
})

describe('swapContainer — the docker run line', () => {
  const runCmd = async (opts) => { const t = onBox(); await t.go(opts); return t.runCmd() }

  test('starts the new container on the image it was given', async () => {
    const line = await runCmd({ image: 'sha256:abc' })
    expect(line).toContain('docker run -d')
    expect(line).toContain('--name app')
    expect(line).toContain('sha256:abc')
  })

  // FJS-D1484: on a box each app runs as its own host user, never the
  // image's uid every app would share.
  test('on a box the container starts as the app\'s own user', async () => {
    const t = onBox({ ids: '998:998\n' })
    await t.go({ host: 'root@203.0.113.7', appId: 'my-app' })
    expect(t.runCmd()).toContain('--user 998:998')
  })

  test('a box with no user for the app is refused before the running container is touched', async () => {
    const t = onBox({ before: { app: old } })
    await expect(t.go({ host: 'root@203.0.113.7', appId: 'my-app' })).rejects.toThrow(/fjs-my-app is not a user on this box.*fli deploy:setup/)
    expect(t.d.log).toEqual([])
  })

  test('a dry run names the app\'s user without asking the box, so it is not refused', async () => {
    const t = onBox({ before: { app: old }, dry: true })
    await t.go({ host: 'root@203.0.113.7', appId: 'my-app' })
    expect(t.commands.some(c => c.includes('id -u fjs-'))).toBe(false)
    expect(t.runCmd()).toContain("--user '<uid:gid of fjs-my-app>'")
  })

  test('localhost passes no --user, so the image\'s user runs', async () => {
    expect(await runCmd()).not.toContain('--user')
  })

  test('the old container is renamed and stopped BEFORE the new one starts', async () => {
    const t = onBox({ before: { app: old } })
    await t.go()
    expect(t.d.log.slice(0, 4)).toEqual(['rm app_replaced', 'rename app app_replaced', 'stop app_replaced', 'run app img:new'])
  })

  // FJS-3980: the grace is handed to the container once, so the stop of the
  // replaced one reads the number it was started with, not a literal here.
  test('the stop grace reaches the run command, and the replaced container is stopped by its own', async () => {
    const t = onBox({ before: { app: old } })
    await t.go()
    expect(t.runCmd()).toContain('--stop-timeout 50 -e FRONTIER_STOP_GRACE=50')
    expect(t.commands.find(c => c.startsWith('docker stop'))).toBe('docker stop app_replaced')
    expect(await runCmd({ deployConf: { stopGrace: 25 } })).toContain('--stop-timeout 25 -e FRONTIER_STOP_GRACE=25')
  })

  test('a stop grace that leaves Junction no drain is refused before anything is touched', async () => {
    const t = onBox({ before: { app: old } })
    await expect(t.go({ deployConf: { stopGrace: 1 } })).rejects.toThrow(/stopGrace must be a whole number of seconds, at least 2/)
    expect(t.d.log).toEqual([])
  })

  test('the log driver reaches the run command; a stated one is carried; logs: false declines it', async () => {
    expect(await runCmd()).toContain('--log-driver json-file --log-opt max-size=10m')
    const journald = await runCmd({ deployConf: { logs: { driver: 'journald' } } })
    expect(journald).toContain('--log-driver journald')
    expect(journald).not.toContain('json-file')
    const none = await runCmd({ deployConf: { logs: false } })
    expect(none).toContain('docker run -d')
    expect(none).not.toContain('--log-driver')
  })

  test('an absent deployConf does not throw — the revert path passes less', async () => {
    const line = await runCmd({ deployConf: undefined })
    expect(line).toContain('docker run -d')
    expect(line).toContain('--log-driver json-file')
  })

  test('the build id is stamped when given and absent when not', async () => {
    expect(await runCmd({ build: 'abc1234' })).toContain('--env FJS_BUILD=abc1234')
    expect(await runCmd()).not.toContain('FJS_BUILD')
  })

  test('the configuration values reach the process, after the env file so they win (FJS-585)', async () => {
    // The Release hash names these values, so they are what the process runs on:
    // `--env K=V` after `--env-file`, never a file written on the target.
    const line = await runCmd({ configuration: { A: '1', GREETING: "it's here" } })
    expect(line).toContain('--env A=1')
    expect(line).toContain(`--env 'GREETING=it'\\''s here'`)
    expect(line.indexOf('--env A=')).toBeGreaterThan(line.indexOf('--env-file'))
  })

  test('FRONTIER_PORT_BE and NODE_ENV still beat a configuration value of the same name', async () => {
    const line = await runCmd({ configuration: { FRONTIER_PORT_BE: '9999' } })
    expect(line.lastIndexOf('--env FRONTIER_PORT_BE=3000')).toBeGreaterThan(line.indexOf('--env FRONTIER_PORT_BE=9999'))
    expect(line.indexOf('--env FRONTIER_PORT_BE=3000')).toBeGreaterThan(line.indexOf('--env-file'))
  })

  test('the app is told the one proxy the edge puts in front of it (FJS-1841)', async () => {
    // Untold, every caller arrives from Caddy's address and shares one
    // rate-limit bucket, so one caller's failed logins lock out the site.
    const { EDGE_HOPS } = await import('../core/edge.js')
    expect(await runCmd()).toContain(`--env FRONTIER_TRUST_PROXY=${EDGE_HOPS}`)
  })

  test('the derived cross-origin list reaches the container, and a same-origin app gets none (FJS-2655)', async () => {
    const origins = ['https://app.example.com', 'tauri://localhost']
    expect(await runCmd({ corsOrigins: origins })).toContain(`--env FRONTIER_CORS_ORIGINS=${origins.join(',')}`)
    expect(await runCmd()).not.toContain('FRONTIER_CORS_ORIGINS')
  })

  // ─── the secrets directory (FJS-3359) ──────────────────────────────────────
  const secretsDir = '/srv/secrets'

  test('each key in the secrets directory is mounted read-only and passed as KEY_FILE, never as a value', async () => {
    const t = onBox({ ls: 'ENCRYPTION_KEY\nSTRIPE_KEY\n' })
    await t.go({ secretsDir })
    expect(t.runCmd()).toContain('--volume /srv/secrets:/run/secrets:ro')
    expect(t.runCmd()).toContain('--env ENCRYPTION_KEY_FILE=/run/secrets/ENCRYPTION_KEY')
    expect(t.runCmd()).toContain('--env STRIPE_KEY_FILE=/run/secrets/STRIPE_KEY')
  })

  test('no secrets directory, or an empty one, mounts nothing', async () => {
    const t = onBox()
    await t.go({ secretsDir })
    expect(t.runCmd()).not.toContain('/run/secrets')
    expect(t.runCmd()).not.toContain('_FILE=')
  })

  test('a file not named like an env key never reaches the docker run line', async () => {
    const t = onBox({ ls: 'ENCRYPTION_KEY\nnotes.txt\n$(reboot)\n' })
    await t.go({ secretsDir })
    expect(t.runCmd()).toContain('ENCRYPTION_KEY_FILE=')
    expect(t.runCmd()).not.toContain('notes.txt')
    expect(t.runCmd()).not.toContain('reboot')
  })

  test('a key also in the env file or the configuration set is refused before the running container is touched', async () => {
    const inFile = onBox({ before: { app: old }, ls: 'ENCRYPTION_KEY\n', inEnv: 'ENCRYPTION_KEY\n' })
    await expect(inFile.go({ secretsDir })).rejects.toThrow(/ENCRYPTION_KEY is in \/srv\/secrets and also in \/srv\/\.env\.production/)
    expect(inFile.d.log).toEqual([])

    const inConfig = onBox({ before: { app: old }, ls: 'API_TOKEN\n' })
    await expect(inConfig.go({ secretsDir, configuration: { API_TOKEN: 'x' } })).rejects.toThrow(/API_TOKEN/)
    expect(inConfig.d.log).toEqual([])
  })

  test('a secrets directory this login cannot list stops the swap rather than starting the API without its keys', async () => {
    const t = onBox({ before: { app: old }, ls: '?unreadable\n' })
    await expect(t.go({ secretsDir })).rejects.toThrow(/cannot list it/)
    expect(t.d.log).toEqual([])
  })
})

// ─── the health check and the put-back ─────────────────────────────────────────
//
// `restored` is read by the revert as *the release that was serving is running
// again*, and `docker start` answers the moment the process exists — before the
// app has migrated and bound. On a slow runner the check right after a refused
// deploy found the put-back release still booting (FJS-009), so the restore is
// polled like the deploy was, and only an answer counts.

describe('swapContainer — health and the put-back', () => {
  test('the put-back container is polled before it is called restored', async () => {
    const t = onBox({ before: { app: old } })
    const result = await t.go({ image: 'img:sick' })
    const back = t.commands.indexOf('docker start app')
    expect(back).toBeGreaterThan(0)
    expect(t.commands.slice(back + 1).some(c => c.includes('curl'))).toBe(true)
    expect(result).toMatchObject({ healthy: false, restored: true, none: false, unbound: [] })
  })

  test('a put-back container that never answers is not restored', async () => {
    const t = onBox({ before: { app: { image: 'img:sick', running: true } } })
    expect(await t.go({ image: 'img:sick' })).toMatchObject({ healthy: false, restored: false, none: false, unbound: [] })
  })

  // FJS-3586: a first deploy has no _replaced, and polling the name it just
  // removed reported a put-back that never happened.
  test('a first deploy with nothing to put back answers none and polls nothing after the removal', async () => {
    const t = onBox()
    const result = await t.go({ image: 'img:sick' })
    expect(result).toMatchObject({ healthy: false, restored: false, none: true, unbound: [] })
    const removed = t.commands.indexOf('docker rm -f app')
    expect(removed).toBeGreaterThan(0)
    expect(t.commands.slice(removed + 1).some(c => c.includes('curl'))).toBe(false)
  })

  // A 200 is not enough: a database in the container's own layer is empty after
  // the next swap, so the release that wrote it is put back like a sick one.
  test('a container answering with a database outside the volume is put back; one on the volume passes', async () => {
    const outside = onBox({ before: { app: old }, open: '/data/app.db\n/db/audit.db\n' })
    expect(await outside.go()).toMatchObject({ healthy: false, restored: true, none: false, unbound: ['/data/app.db'] })
    expect(imagesOn(outside.d.box)).toEqual({ app: 'img:old' })

    const inside = onBox({ before: { app: old }, open: '/db/app.db\n' })
    expect(await inside.go()).toMatchObject({ healthy: true, restored: false, unbound: [] })
    expect(imagesOn(inside.d.box)).toEqual({ app: 'img:new' })
  })
})

// ─── litestreamInstall (FJS-243) ─────────────────────────────────────────────

describe('litestreamInstall', () => {
  test('deploy:setup checks for litestream and installs it with the pinned script', () => {
    const steps = readFileSync(resolve(ROOT, 'commands/deploy/_steps-setup/01-check-deps.md'), 'utf8')
    expect(steps).toMatch(/name: 'litestream'.*install: litestreamInstall\(\)/)
  })
})

// ─── aptIdle ─────────────────────────────────────────────────────────────────
// A fresh droplet answers ssh while its own apt holds the lock, and every apt
// install deploy:setup started in those minutes failed. Driven against a fake
// fuser, which is what the script polls.

describe('aptIdle', () => {
  // A fuser that reports a holder for its first `busy` calls, then none.
  const fakeFuser = (busy) => {
    const bin = resolve(TMP, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(resolve(bin, 'fuser'),
      `#!/bin/sh\nn=$(cat "${TMP}/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${TMP}/calls"; [ $n -le ${busy} ]\n`, { mode: 0o755 })
    mkdirSync(resolve(TMP, 'conf'), { recursive: true })
    return { PATH: `${bin}:${process.env.PATH}` }
  }
  const run = (script, env) => Bun.spawnSync(['sh', '-c', script], { env: { ...process.env, ...env } })

  // 02-install-deps wraps the script in sudo sh -c '...'
  test('the script carries no single quote', () => {
    expect(aptIdle()).not.toContain("'")
  })

  test('waits while apt is held, says how long, then leaves the lock timeout', () => {
    const r = run(aptIdle({ step: 1, confDir: resolve(TMP, 'conf') }), fakeFuser(1))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('1')
    expect(readFileSync(resolve(TMP, 'calls'), 'utf8').trim()).toBe('2')
    expect(readFileSync(resolve(TMP, 'conf/90frontier-lock-wait'), 'utf8')).toBe('DPkg::Lock::Timeout "600";\n')
  })

  test('prints nothing when apt was free', () => {
    const r = run(aptIdle({ step: 0, confDir: resolve(TMP, 'conf') }), fakeFuser(0))
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString()).toBe('')
  })

  test('gives up past the limit and writes nothing', () => {
    const r = run(aptIdle({ limit: 2, step: 1, confDir: resolve(TMP, 'conf') }), fakeFuser(99))
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('apt is still busy after 2s')
    expect(Bun.spawnSync(['ls', resolve(TMP, 'conf')]).stdout.toString().trim()).toBe('')
  })
})

// ─── deploy:rollback — a box that does not answer ─────────────────────────────

// Every rollback step read an ssh failure as "nothing to roll back", so an
// unreachable box printed "Rollback complete" and exited 0 (FJS-3572). The ssh
// on PATH answers its first `answers` calls and refuses the rest.
describe('deploy:rollback against a box that does not answer', () => {

  const rollback = (answers, ...flags) => {
    mkdirSync(resolve(TMP, 'db'))
    mkdirSync(resolve(TMP, 'bin'))
    writeFileSync(resolve(TMP, 'db/schema.lite'), '')
    writeFileSync(resolve(TMP, 'package.json'), '{"name":"rb"}')
    writeConfig({ deploy: { app_id: 'rb', server: 'box.invalid', user: 'deploy', path: '/srv/rb' } })
    writeFileSync(resolve(TMP, 'bin/ssh'),
      `#!/bin/sh\nn=$(cat ${TMP}/n 2>/dev/null || echo 0)\necho $((n+1)) > ${TMP}/n\n[ "$n" -lt ${answers} ] || exit 255\n`,
      { mode: 0o755 })
    Bun.spawnSync(['git', 'init', '-q'], { cwd: TMP })
    const r = Bun.spawnSync(['bun', resolve(ROOT, 'bin/fli.js'), 'deploy:rollback', '--production', ...flags],
      { cwd: TMP, env: { ...process.env, PATH: `${TMP}/bin:${process.env.PATH}` } })
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
  }

  test('unreachable before it starts refuses', () => {
    const { code, out } = rollback(0)
    expect(code).toBe(1)
    expect(out).toContain('nothing was rolled back')
    expect(out).not.toContain('Rollback complete')
  }, 30000)

  test('lost after the probe refuses in the web step', () => {
    const { code, out } = rollback(1, '--web')
    expect(code).toBe(1)
    expect(out).toContain('web was not rolled back')
    expect(out).not.toContain('Rollback complete')
  }, 30000)

  test('lost after the probe refuses in the API step', () => {
    const { code, out } = rollback(1, '--api')
    expect(code).toBe(1)
    expect(out).toContain('API was not rolled back')
    expect(out).not.toContain('Rollback complete')
  }, 30000)
})
