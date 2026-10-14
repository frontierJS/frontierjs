/**
 * test/devline-plugin.test.js — the dev server under `fli dev`, through a REAL
 * Vite server.
 *
 * fli prints an unmarked line as ordinary output, so every way this breaks is
 * quiet: a ready line that stops parsing leaves the web row out of the summary,
 * and a banner that is not held back prints beside it. So the questions are
 * the ones fli asks of the stream:
 *
 *   1. one ready line, carrying the URL and the schema facts
 *   2. none of Vite's own banner — and its later INFO still reaches the log
 *   3. a Mesa hint as a marked warning naming its file
 *
 * The banner is the one Vite's CLI prints, replayed here in its order: the
 * version line through the logger, then `printUrls()`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname }        from 'path'
import { fileURLToPath }        from 'url'
import { createServer }         from 'vite'
import { parseDevLine }         from '@frontierjs/toolbelt/devline'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP       = join(__dirname, 'tmp-devline')

let server
const out = []

beforeAll(async () => {
  await mkdir(join(TMP, 'src/routes/users'), { recursive: true })
  await writeFile(join(TMP, 'index.html'), '<!doctype html><div id="app"></div>', 'utf8')
  await writeFile(
    join(TMP, 'src/routes/users/[id].mesa'),
    "<script>\n  import { page } from '@frontierjs/sierra/router'\n  const id = page.params.id\n</script>\n\n<p>{id}</p>\n",
    'utf8'
  )

  // Set for the server's whole life, as fli sets it: the plugins read it at
  // config time and again at every transform.
  process.env.FLI_DEV = '1'
  const config = createSierraViteConfig({
    target: 'spa',
    vite: { root: TMP, server: { port: 0, strictPort: false } },
  })

  for (const k of ['log', 'warn']) {
    const real = console[k]
    console[k] = (...args) => { out.push(args.join(' ')) }
    afterAll(() => { console[k] = real })
  }

  server = await createServer(config)
  await server.listen()
  server.config.logger.info('\n  VITE v8  ready in 1 ms\n', { clear: true })
  server.printUrls()
}, 60_000)

afterAll(async () => {
  delete process.env.FLI_DEV
  await server?.close()
  await rm(TMP, { recursive: true, force: true })
})

const messages = () => out.map(parseDevLine).filter(Boolean)

describe('the dev server under fli dev', () => {
  test('says it is ready on one marked line', () => {
    const ready = messages().filter(m => m.ready)
    expect(ready).toHaveLength(1)
    expect(ready[0].ready.url).toBe(`http://localhost:${server.httpServer.address().port}/`)
    expect(ready[0].ready.rows[0].name).toBe('Sierra')
  })

  test('holds back the banner and lets later INFO through', () => {
    expect(out.some(l => l.includes('VITE v8'))).toBe(false)
    expect(out.some(l => l.includes('Local:'))).toBe(false)
    server.config.logger.info('hmr update /src/routes/users/[id].mesa')
    expect(out.some(l => l.includes('hmr update'))).toBe(true)
  })

  test('a Mesa hint is a marked warning naming its file', async () => {
    await server.transformRequest('/src/routes/users/[id].mesa')
    const warn = messages().find(m => m.warn)
    expect(warn?.warn.file).toBe('src/routes/users/[id].mesa')
    expect(warn?.warn.text).toContain('page.params.id')
  })
})
