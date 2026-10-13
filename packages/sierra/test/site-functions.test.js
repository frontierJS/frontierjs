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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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
