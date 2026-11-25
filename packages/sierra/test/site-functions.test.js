/*
 * test/site-functions.test.js — host functions (`FJS-1540`, `FJS-D919`).
 *
 * A static site owes its host a place for a function: ksite's same-origin
 * Plausible proxy sits at `/api/event` and a build that has no `functions/`
 * notion leaves it either cross-origin or dropped. The directory answers its
 * own paths, the build writes one entry, and `serveSite` mounts that entry
 * before its static answers, so a drive runs the site the way a host that is
 * not Cloudflare would.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { functionRoutes, writeFunctionsEntry, FUNCTIONS_ENTRY } from '../src/postbuild/functions.js'
import { runPostBuild } from '../src/postbuild/index.js'
import { serveSite } from '../src/site/serve.js'

let ROOT
let server

const write = (rel, body) => {
  const full = join(ROOT, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), 'sierra-fn-'))
  write('dist/index.html', '<h1>home</h1>')
  write('dist/api/event/index.html', '<h1>a page under the function path</h1>')
  write('functions/api/event.js', `
    export default async (request, env) => {
      const body = request.method === 'POST' ? await request.text() : ''
      return new Response(JSON.stringify({ method: request.method, body, key: env.KEY, kv: typeof env.KV }), {
        status: 202,
        headers: { 'Content-Type': 'application/json', 'X-Fn': 'event' },
      })
    }
  `)
  write('functions/index.js', `export default () => new Response('fn root')`)
  write('functions/ping/index.js', `export default () => new Response('pong')`)
  const entry = await writeFunctionsEntry({ root: ROOT, dir: 'functions' })
  server = await serveSite({
    dir: join(ROOT, 'dist'),
    functions: entry,
    env: { KEY: 'secret-string', KV: { get() {} }, N: 3 },
  })
})

afterAll(async () => {
  await server?.close()
  rmSync(ROOT, { recursive: true, force: true })
})

describe('the path a file answers', () => {
  test('a file answers its own path, index.js answers its directory', () => {
    const routes = functionRoutes(join(ROOT, 'functions')).map(r => r.path).sort()
    expect(routes).toEqual(['/', '/api/event', '/ping'])
  })

  test('a bracketed name is refused by name', () => {
    write('bad/[id].js', `export default () => new Response('x')`)
    expect(() => functionRoutes(join(ROOT, 'bad'))).toThrow(/\[id\]\.js/)
  })

  test('a module importing cloudflare: is refused at build time, by name', () => {
    write('cf/api/kv.js', `import { env } from 'cloudflare:workers'\nexport default () => new Response(env.KV)`)
    expect(() => functionRoutes(join(ROOT, 'cf'))).toThrow(/cloudflare:workers/)
  })
})

describe('serveSite mounts the entry before the static answers', () => {
  test('a POST reaches the function with the body', async () => {
    const res = await fetch(`${server.url}/api/event`, { method: 'POST', body: '{"n":1}' })
    expect(res.status).toBe(202)
    expect(res.headers.get('x-fn')).toBe('event')
    expect(await res.json()).toMatchObject({ method: 'POST', body: '{"n":1}' })
  })

  test('env carries strings only — a binding reads undefined', async () => {
    const body = await (await fetch(`${server.url}/api/event`)).json()
    expect(body.key).toBe('secret-string')
    expect(body.kv).toBe('undefined')
  })

  test('the function wins over a page at the same path, with or without the slash', async () => {
    expect((await fetch(`${server.url}/api/event/`)).headers.get('x-fn')).toBe('event')
  })

  test('the root function answers /, and an index.js directory answers its name', async () => {
    expect(await (await fetch(`${server.url}/`)).text()).toBe('fn root')
    expect(await (await fetch(`${server.url}/ping/`)).text()).toBe('pong')
  })

  test('a path with no function falls through to the files', async () => {
    expect((await fetch(`${server.url}/nope/`)).status).toBe(404)
  })
})

describe('the build writes the entry', () => {
  test('runPostBuild writes .sierra/functions.js when config.functions names a directory', async () => {
    const entry = join(ROOT, FUNCTIONS_ENTRY)
    rmSync(entry, { force: true })
    const results = await runPostBuild(
      { functions: 'functions' }, { redirects: [] }, join(ROOT, 'dist'), ROOT, null,
    )
    expect(existsSync(entry)).toBe(true)
    expect(results.join('\n')).toMatch(/functions/)
  })
})

// ─── vite dev ──────────────────────────────────────────────────────────────────

describe('vite dev answers the functions', () => {
  let dev

  beforeAll(async () => {
    const { createServer } = await import('vite')
    const { functionsPlugin } = await import('../src/build/functions-plugin.js')
    dev = await createServer({
      root: ROOT,
      configFile: false,
      logLevel: 'silent',
      appType: 'spa',
      plugins: [functionsPlugin({ functions: 'functions' })],
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
    })
    await dev.listen()
  })

  afterAll(async () => { await dev?.close() })

  const origin = () => `http://127.0.0.1:${dev.httpServer.address().port}`

  test('a POST reaches the function, not the SPA fallback', async () => {
    const res = await fetch(`${origin()}/api/event`, { method: 'POST', body: '{"n":2}' })
    expect(res.status).toBe(202)
    expect(res.headers.get('x-fn')).toBe('event')
    expect(await res.json()).toMatchObject({ method: 'POST', body: '{"n":2}' })
  })

  test('a function added under the running server answers on the next call', async () => {
    write('functions/late.js', `export default () => new Response('late')`)
    expect(await (await fetch(`${origin()}/late`)).text()).toBe('late')
  })

  test('an edited function answers with its new body', async () => {
    write('functions/edit.js', `export default () => new Response('one')`)
    expect(await (await fetch(`${origin()}/edit`)).text()).toBe('one')
    await new Promise(r => setTimeout(r, 20))
    write('functions/edit.js', `export default () => new Response('two')`)
    expect(await (await fetch(`${origin()}/edit`)).text()).toBe('two')
  })

  test('a path with no function falls through to Vite', async () => {
    expect((await fetch(`${origin()}/nope`)).headers.get('x-fn')).toBeNull()
  })
})

// ─── compiled binary ───────────────────────────────────────────────────────────

describe('a compiled site runs the functions', () => {
  let bin

  beforeAll(async () => {
    const { compileSite } = await import('../src/site/compile.js')
    const { spawn } = await import('node:child_process')
    const { outfile } = compileSite({
      dir: join(ROOT, 'dist'),
      outfile: join(ROOT, 'out', 'site'),
      functions: join(ROOT, FUNCTIONS_ENTRY),
    })
    const proc = spawn(outfile, ['--port', '0'], {
      cwd: mkdtempSync(join(ROOT, 'empty-')),
      env: { ...process.env, HOST: '127.0.0.1', KEY: 'binary-secret' },
    })
    const url = await new Promise((ok, fail) => {
      let out = ''
      proc.stdout.on('data', d => { out += d; const m = /at (http:\/\/\S+)/.exec(out); if (m) ok(m[1]) })
      proc.on('exit', code => fail(new Error(`binary exited ${code}: ${out}`)))
    })
    bin = { proc, url }
  }, 60_000)

  afterAll(() => { bin?.proc.kill() })

  test('a POST reaches the function and env is the process\'s strings', async () => {
    const res = await fetch(`${bin.url}/api/event`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ method: 'POST', body: 'x', key: 'binary-secret' })
  })

  test('the pages still answer', async () => {
    expect(await (await fetch(`${bin.url}/`)).text()).toBe('fn root')
    expect(await (await fetch(`${bin.url}/ping/`)).text()).toBe('pong')
  })
})

// ─── the Cloudflare adapter ────────────────────────────────────────────────────
//
// What workerd itself answers is not run here; the Worker below is called with
// an ASSETS binding standing in for Cloudflare's, so what this proves is the
// adapter's half — the order, and which env a function sees.

describe('the Cloudflare adapter', () => {
  let CF
  let adapter

  beforeAll(async () => {
    adapter = await import('../src/site/cloudflare.js')
    CF = mkdtempSync(join(tmpdir(), 'sierra-cf-'))
    const put = (rel, body) => {
      mkdirSync(join(CF, rel, '..'), { recursive: true })
      writeFileSync(join(CF, rel), body)
    }
    put('dist/index.html', '<h1>home</h1>')
    put('dist/404.html', '<h1>not found</h1>')
    put('functions/api/event.js', `export default (request, env) => new Response(JSON.stringify({ key: env.KEY, assets: typeof env.ASSETS }))`)
    await writeFunctionsEntry({ root: CF, dir: 'functions' })
  })

  afterAll(() => rmSync(CF, { recursive: true, force: true }))

  test('the Worker is named for siteUrl\'s host', () => {
    expect(adapter.workerName('https://frontierjs.com')).toBe('frontierjs-com')
    expect(adapter.workerName('https://www.Example.co.uk/')).toBe('www-example-co-uk')
  })

  test('no siteUrl, a siteUrl with a path, and a name past 63 characters are refused by name', () => {
    expect(() => adapter.workerName(undefined)).toThrow(/no siteUrl/)
    expect(() => adapter.workerName('https://example.com/blog')).toThrow(/has a path/)
    expect(() => adapter.workerName(`https://${'a'.repeat(60)}.com`)).toThrow(/past Cloudflare's 63/)
  })

  test('an assets-only site gets no script, and every assets key is derived', () => {
    const w = adapter.wranglerConfig({ root: CF, config: { siteUrl: 'https://frontierjs.com' } })
    expect(w).toEqual({
      name: 'frontierjs-com',
      compatibility_date: adapter.COMPATIBILITY_DATE,
      assets: { directory: '../dist', html_handling: 'force-trailing-slash', not_found_handling: '404-page' },
      routes: [{ pattern: 'frontierjs.com', custom_domain: true }],
      preview_urls: true,
    })
  })

  test('a preview alias is the branch spelled as wrangler spells it, refused rather than truncated', () => {
    expect(adapter.previewAlias('frontierjs-com', 'feat/Site_Hosting')).toBe('feat-site-hosting')
    expect(() => adapter.previewAlias('frontierjs-com', undefined)).toThrow(/HEAD names none/)
    expect(() => adapter.previewAlias('frontierjs-com', '2026-round')).toThrow(/starts with a letter/)
    expect(() => adapter.previewAlias('frontierjs-com', 'a'.repeat(50))).toThrow(/past Cloudflare's 63/)
  })

  test('a deploy refuses a preview build, and a preview refuses a production build', async () => {
    const both = mkdtempSync(join(tmpdir(), 'sierra-cf-kind-'))
    const config = { siteUrl: 'https://a.dev' }
    try {
      mkdirSync(join(both, 'dist', 'about'), { recursive: true })
      writeFileSync(join(both, 'dist', 'index.html'), '<h1>home</h1>')
      writeFileSync(join(both, 'dist', 'about', 'index.html'), '<h1>about</h1>')
      await expect(adapter.writeCloudflare({ root: both, config, preview: true })).rejects.toThrow(/dist is a production build/)
      // A page that documents the stamp is still a production page.
      writeFileSync(join(both, 'dist', 'about', 'index.html'), '<p>Each element gets <code>data-fjs-loc="File.mesa:1:1"</code> in dev, or data-fjs-loc="x" in prose.</p>')
      expect((await adapter.writeCloudflare({ root: both, config })).wrangler.name).toBe('a-dev')
      writeFileSync(join(both, 'dist', 'about', 'index.html'), '<h1 data-fjs-loc="content/routes/about.md:1:1">about</h1>')
      await expect(adapter.writeCloudflare({ root: both, config })).rejects.toThrow(/dist\/about\/index\.html is a preview build's/)
      expect((await adapter.writeCloudflare({ root: both, config, preview: true })).wrangler.name).toBe('a-dev')
    } finally { rmSync(both, { recursive: true, force: true }) }
  })

  test('a build with no 404.html gets no 404 page, and a missing build is refused', () => {
    const bare = mkdtempSync(join(tmpdir(), 'sierra-cf-bare-'))
    try {
      expect(() => adapter.wranglerConfig({ root: bare, config: { siteUrl: 'https://a.dev' } })).toThrow(/no build at dist/)
      mkdirSync(join(bare, 'dist'))
      const w = adapter.wranglerConfig({ root: bare, config: { siteUrl: 'https://a.dev', trailingSlash: 'never' } })
      expect(w.assets).toMatchObject({ html_handling: 'drop-trailing-slash', not_found_handling: 'none' })
    } finally { rmSync(bare, { recursive: true, force: true }) }
  })

  test('with functions, the script runs first on their paths only', async () => {
    const { wrangler, worker } = await adapter.writeCloudflare({ root: CF, config: { siteUrl: 'https://fn.dev', functions: 'functions' } })
    expect(wrangler.main).toBe('worker.js')
    expect(wrangler.assets).toMatchObject({ binding: 'ASSETS', run_worker_first: ['/api/event', '/api/event/'] })
    expect(existsSync(worker)).toBe(true)
  })

  // The Worker bundles this file. Any import in it is a bundle wrangler refuses
  // without nodejs_compat, and nothing under vitest would notice.
  test('the handler the Worker bundles imports nothing', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/postbuild/function-handler.js'), 'utf8')
    expect(src).not.toMatch(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m)
  })

  // FJS-4268: a camp whose account lacks the zone uploaded the Worker, then failed on the custom domain.
  test('a deploy refuses a host whose zone is not on the account, before anything is uploaded', async () => {
    const asked = []
    const zones = (names) => async (url) => {
      const name = new URL(url).searchParams.get('name')
      asked.push(name)
      return Response.json({ success: true, result: names.includes(name) ? [{ name }] : [] })
    }
    const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acct1' }
    const config = { siteUrl: 'https://www.kobami.com' }
    await expect(adapter.deploySite({ root: CF, config, env, fetch: zones([]), log: () => {} }))
      .rejects.toThrow(/www\.kobami\.com is in no zone on Cloudflare account acct1/)
    expect(asked).toEqual(['www.kobami.com', 'kobami.com'])

    expect(await adapter.zoneOnAccount({ host: 'www.kobami.com', env, fetch: zones(['kobami.com']) })).toBe(true)
    // Unknown is not a no: wrangler is left to answer.
    expect(await adapter.zoneOnAccount({ host: 'kobami.com', env, fetch: async () => new Response('', { status: 403 }) })).toBe(null)
    expect(await adapter.zoneOnAccount({ host: 'kobami.com', env: {}, fetch: zones([]) })).toBe(null)
  })

  test('the Worker answers a function, with strings only, and hands every other path to ASSETS', async () => {
    const { default: entry } = await import(join(CF, adapter.WORKER_ENTRY))
    const env = { KEY: 'cf-secret', ASSETS: { fetch: () => new Response('from assets') } }
    expect(await (await entry.fetch(new Request('https://fn.dev/api/event/'), env)).json()).toEqual({ key: 'cf-secret', assets: 'undefined' })
    expect(await (await entry.fetch(new Request('https://fn.dev/about/'), env)).text()).toBe('from assets')
  })
})

// ─── analytics.proxy ───────────────────────────────────────────────────────────

describe('analytics.proxy derives the Plausible proxy (FJS-D1037)', () => {
  let P
  let upstream
  let site
  const seen = []

  beforeAll(async () => {
    const { createServer } = await import('node:http')
    upstream = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie, ua: req.headers['user-agent'], xff: req.headers['x-forwarded-for'] })
        if (req.url === '/js/script.manual.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Set-Cookie': 'up=1' })
          return res.end('/* plausible */')
        }
        res.writeHead(202, { 'Content-Type': 'text/plain' })
        res.end('ok')
      })
    })
    await new Promise(r => upstream.listen(0, '127.0.0.1', r))

    P = mkdtempSync(join(tmpdir(), 'sierra-proxy-'))
    mkdirSync(join(P, 'dist'), { recursive: true })
    writeFileSync(join(P, 'dist/index.html'), '<h1>home</h1>')
  })

  afterAll(async () => {
    await site?.close()
    await new Promise(r => upstream?.close(r))
    rmSync(P, { recursive: true, force: true })
  })

  const analytics = () => ({ provider: 'plausible', domain: 'shop.example', proxy: true, apiHost: `http://127.0.0.1:${upstream.address().port}` })

  test('the build writes both routes with no functions directory', async () => {
    const results = await runPostBuild({ analytics: analytics() }, { redirects: [] }, join(P, 'dist'), P, null)
    expect(results.join('\n')).toMatch(/functions\.js \(2 functions\)/)
    const { routes } = await import(join(P, FUNCTIONS_ENTRY))
    expect(Object.keys(routes).sort()).toEqual(['/api/event', '/js/script.js'])
  })

  test('the script and the event reach the upstream, without the visitor\'s cookie', async () => {
    site = await serveSite({ dir: join(P, 'dist'), functions: join(P, FUNCTIONS_ENTRY) })
    const script = await fetch(`${site.url}/js/script.js`, { headers: { cookie: 'session=SECRET' } })
    expect(script.status).toBe(200)
    expect(await script.text()).toBe('/* plausible */')
    expect(script.headers.get('set-cookie')).toBe(null)

    const event = await fetch(`${site.url}/api/event`, {
      method: 'POST', body: '{"n":"pageview"}',
      headers: { 'Content-Type': 'text/plain', cookie: 'session=SECRET', 'User-Agent': 'probe/1', 'X-Forwarded-For': '203.0.113.9' },
    })
    expect(event.status).toBe(202)
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/event', body: '{"n":"pageview"}', cookie: undefined, ua: 'probe/1', xff: '203.0.113.9' })
    expect(seen.every(s => s.cookie === undefined)).toBe(true)
    expect(seen[0].url).toBe('/js/script.manual.js')
  })

  // FJS-4447: with nothing fronting serveSite, Plausible saw only the server's IP.
  test('with no front proxy, the event carries the visitor\'s socket address', async () => {
    const event = await fetch(`${site.url}/api/event`, { method: 'POST', body: '{"n":"pageview"}', headers: { 'Content-Type': 'text/plain' } })
    expect(event.status).toBe(202)
    expect(seen.at(-1).xff).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/)
  })

  test('a site file at a proxied path is refused as a duplicate, by name', async () => {
    mkdirSync(join(P, 'functions/api'), { recursive: true })
    writeFileSync(join(P, 'functions/api/event.js'), `export default () => new Response('mine')`)
    await expect(writeFunctionsEntry({ root: P, dir: 'functions', analytics: analytics() })).rejects.toThrow(/api\/event\.js.*\/api\/event/)
    rmSync(join(P, 'functions'), { recursive: true, force: true })
  })

  test('the Cloudflare Worker runs first on the proxied paths', async () => {
    const { wranglerConfig } = await import('../src/site/cloudflare.js')
    const out = wranglerConfig({ root: P, config: { siteUrl: 'https://shop.example', analytics: analytics() } })
    expect(out.main).toBe('worker.js')
    expect(out.assets.run_worker_first).toEqual(['/js/script.js', '/js/script.js/', '/api/event', '/api/event/'])
  })

  // Bundled into the Worker beside function-handler.js, under the same rule.
  test('the proxy module imports nothing', () => {
    const src = readFileSync(join(import.meta.dirname, '../src/postbuild/plausible-proxy.js'), 'utf8')
    expect(src).not.toMatch(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m)
  })
})
