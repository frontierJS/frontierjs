// test/routes-dir.test.ts
//
// FJS-1889 / FJS-D626. No loader read `api/src/routes/`, so a Route had no home
// and apps mounted raw routes from plugins, `core/` and `app.ts`. A file's path
// there is the URL it answers, and its `GET`/`POST`/… exports are the handlers.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createApp } from '../index.ts'

// `<root>/services` is where the app's services are; `<root>/routes` is the
// folder beside it. The services folder is empty — it has to exist for the
// loader to have a place to look from.
function appDir(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fjs-routes-'))
  mkdirSync(join(root, 'services'), { recursive: true })
  for (const [name, src] of Object.entries(files)) {
    const file = join(root, 'routes', name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, src)
  }
  return root
}

const OK = (body: string) => `export const GET = () => new Response('${body}')\n`

type Started = {
  start(): Promise<void>, stop(): Promise<void>
  http: { port: number }
}

async function withApp<T>(
  files: Record<string, string>, run: (base: string) => Promise<T>, config: Record<string, unknown> = {},
): Promise<T> {
  const root = appDir(files)
  const app = createApp({
    logLevel: 'silent', root, config: { port: 0, ...config },
  }) as unknown as Started
  try {
    await app.start()
    return await run(`http://localhost:${app.http.port}`)
  } finally {
    await app.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
}

async function startError(files: Record<string, string>): Promise<string | null> {
  try { await withApp(files, async () => {}); return null }
  catch (err) { return (err as Error).message }
}

describe('routes/ — a file\'s path is the URL it answers', () => {
  it('a file answers its own path, and index.ts answers its folder', async () => {
    await withApp({ 'ping.ts': OK('pong'), 'hooks/index.ts': OK('hooked') }, async base => {
      expect(await (await fetch(`${base}/ping`)).text()).toBe('pong')
      expect(await (await fetch(`${base}/hooks`)).text()).toBe('hooked')
    })
  })

  it('[name] is a path capture, read off ctx.route', async () => {
    const src = `export const GET = (ctx: any) => new Response('id=' + ctx.route.id)\n`
    await withApp({ 'files/[id].ts': src }, async base => {
      expect(await (await fetch(`${base}/files/42`)).text()).toBe('id=42')
    })
  })

  it('each exported verb is its own method, and an unexported one is not served', async () => {
    const src = OK('read') + `export const POST = () => new Response('wrote')\n`
    await withApp({ 'thing.ts': src }, async base => {
      expect(await (await fetch(`${base}/thing`, { method: 'POST' })).text()).toBe('wrote')
      expect((await fetch(`${base}/thing`, { method: 'DELETE' })).status).not.toBe(200)
    })
  })

  it('apiPrefix applies, as it does to app.get', async () => {
    await withApp({ 'ping.ts': OK('pong') }, async base => {
      expect(await (await fetch(`${base}/api/ping`)).text()).toBe('pong')
    }, { apiPrefix: '/api' })
  })

  it('a _-prefixed file is private to the files beside it', async () => {
    await withApp({ '_helper.ts': OK('private'), 'ping.ts': OK('pong') }, async base => {
      expect((await fetch(`${base}/_helper`)).status).toBe(404)
    })
  })

  it('two files answering one URL are refused at boot, naming both', async () => {
    const msg = await startError({ 'a.ts': OK('one'), 'a/index.ts': OK('two') })
    expect(msg).toContain('a.ts')
    expect(msg).toContain('index.ts')
    expect(msg).toContain('/a')
  })

  it('so are two captures at one position, whatever they are called', async () => {
    const msg = await startError({ 'x/[id].ts': OK('one'), 'x/[slug].ts': OK('two') })
    expect(msg).toContain('[id].ts')
    expect(msg).toContain('[slug].ts')
  })

  it('a file exporting no verb is refused, since it would answer nothing', async () => {
    const msg = await startError({ 'empty.ts': `export const x = 1\n` })
    expect(msg).toContain('empty.ts')
    expect(msg).toContain('GET')
  })

  it('a file that threw is refused, naming it', async () => {
    const msg = await startError({ 'broken.ts': `throw new Error('route file did not load')\n` })
    expect(msg).toContain('broken.ts')
    expect(msg).toContain('route file did not load')
  })
})

// FJS-4229 / FJS-D2219. A 50 MB upload must read its body as a stream, and a
// file here registered its verbs with no options, so it moved to app.ts.
describe('routes/ — export const options is each verb\'s third argument', () => {
  const STREAM = `export const options = { PUT: { body: 'stream' } }\n` +
    `export const PUT = (ctx: any) => new Response(String(ctx.body instanceof ReadableStream))\n` +
    `export const POST = (ctx: any) => new Response(String(ctx.body instanceof ReadableStream))\n`

  it('the verb it names reads its body as a stream, and a verb it does not name is parsed', async () => {
    await withApp({ 'content.ts': STREAM }, async base => {
      const put  = await fetch(`${base}/content`, { method: 'PUT', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
      const post = await fetch(`${base}/content`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
      expect(await put.text()).toBe('true')
      expect(await post.text()).toBe('false')
    })
  })

  it('a key naming no exported verb is refused, since its options would apply to nothing', async () => {
    const msg = await startError({
      'content.ts': `export const options = { Put: { body: 'stream' } }\nexport const PUT = () => new Response('x')\n`,
    })
    expect(msg).toContain('content.ts')
    expect(msg).toContain('Put')
  })

  // FJS-3132. A vault import is a 1 MB body; raising http.maxBodySize for it
  // raised it for login, every service and every socket frame too.
  it('a verb that states maxBodySize takes a body past the app bound, and a route beside it keeps the app bound', async () => {
    const files = {
      'import.ts': `export const options = { POST: { maxBodySize: 2 * 1024 * 1024 } }\n` +
        `export const POST = (ctx: any) => new Response(String(ctx.body.items.length))\n`,
      'login.ts':  `export const POST = (ctx: any) => new Response('in')\n`,
    }
    const vault = JSON.stringify({ items: Array.from({ length: 1000 }, (_, i) => ({ i, note: 'x'.repeat(1000) })) })
    expect(vault.length).toBeGreaterThan(256 * 1024)
    await withApp(files, async base => {
      const send = (path: string) => fetch(`${base}${path}`, { method: 'POST', body: vault, headers: { 'content-type': 'application/json' } })
      const imported = await send('/import')
      expect(imported.status).toBe(200)
      expect(await imported.text()).toBe('1000')
      const login = await send('/login')
      expect(login.status).toBe(413)
      expect(await login.text()).toContain('states its own maxBodySize')
    })
  })
})

// FJS-3596 / FJS-D1663. A route file is handed only its TransportContext, so a
// handler needing the app's client, logger or sqlite path had to stay a plugin.
describe('routes/ — a handler reaches the app as ctx.app', () => {
  it('a route file reads the app it is mounted on', async () => {
    const src = `export const GET = (ctx: any) => new Response(typeof ctx.app?.service + ' ' + typeof ctx.app?.logger?.info)\n`
    await withApp({ 'whoami.ts': src }, async base => {
      expect(await (await fetch(`${base}/whoami`)).text()).toBe('function function')
    })
  })

  it('app.get hands the same app, so both spellings take one signature', async () => {
    const app = createApp({ logLevel: 'silent', config: { port: 0 } })
    app.get('/same', ctx => new Response(String(ctx.app === app)))
    try {
      await app.start()
      expect(await (await fetch(`http://localhost:${app.http.port}/same`)).text()).toBe('true')
    } finally {
      await app.stop().catch(() => {})
    }
  })
})
