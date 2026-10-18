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

  test('the Worker answers a function, with strings only, and hands every other path to ASSETS', async () => {
    const { default: entry } = await import(join(CF, adapter.WORKER_ENTRY))
    const env = { KEY: 'cf-secret', ASSETS: { fetch: () => new Response('from assets') } }
    expect(await (await entry.fetch(new Request('https://fn.dev/api/event/'), env)).json()).toEqual({ key: 'cf-secret', assets: 'undefined' })
    expect(await (await entry.fetch(new Request('https://fn.dev/about/'), env)).text()).toBe('from assets')
  })
})
