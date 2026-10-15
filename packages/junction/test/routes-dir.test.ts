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
    logLevel: 'silent', autoload: join(root, 'services'), config: { port: 0, ...config },
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
