// @vitest-environment node
//
// A real Vite dev server is a Node program, and happy-dom's `URL` breaks the
// plugin's own path resolution (see vite-devtools.test.js).

/**
 * vite-server-failclosed.test.js — what Vite itself concludes about a module
 * the HMR boundary refused to wrap (`FJS-887`, `FJS-865`).
 *
 * "Fails closed" is a claim about VITE, not about the plugin: no
 * `import.meta.hot.accept` in the module means the module does not self-accept,
 * so an edit to it escalates to a full page reload instead of being handled.
 * Asserting the absence of a string cannot say that; `isSelfAccepting` on the
 * module graph is Vite's own answer to the same question, recorded when it
 * analyses the module it was served.
 *
 * The refusal had no trigger at all — `canInject` accepted every shape the real
 * compiler emits — so the compiler here is the stub, whose output is whatever
 * the source file says. Two components differing by one line: the guard fires
 * on one and not the other, and Vite reaches the opposite conclusion about each.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http                  from 'node:http'
import { fileURLToPath }     from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }            from 'node:os'
import { join }              from 'node:path'

import mesaPlugin from '../mesa-vite/index.js'

const STUB = fileURLToPath(new URL('./fixtures/stub-compiler.mjs', import.meta.url))

// The stub compiler reads its instructions out of the file it is given, so a
// component here is a JSON document describing the output a compiler emits.
const component = (body) => JSON.stringify({ result: body })

const WRAPPABLE = `export default function Stub(__anchor, __props, __block) {
  $$runtime.pop_component();
}`
const NOT_WRAPPABLE = `export default function Stub(__anchor, __props, __block) {
  $$runtime.somethingElse();
}`

let root, server, listener

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fjs-mesa-failclosed-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="app"></div>')
  writeFileSync(join(root, 'Good.mesa'), component(WRAPPABLE))
  writeFileSync(join(root, 'Bad.mesa'),  component(NOT_WRAPPABLE))

  const { createServer } = await import('vite')

  server = await createServer({
    root,
    logLevel:   'silent',
    configFile: false,
    server:     { middlewareMode: true, hmr: false },
    plugins:    [mesaPlugin({ compilerPath: STUB })],
  })

  listener = http.createServer(server.middlewares)
  await new Promise((r) => listener.listen(0, '127.0.0.1', r))
}, 30_000)

afterAll(async () => {
  await server?.close()
  await new Promise((r) => listener?.close(r) ?? r())
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

/** Transform a module the way a browser request does, and ask Vite about it. */
async function served(url) {
  const result = await server.transformRequest(url)
  const mod    = await server.moduleGraph.getModuleByUrl(url)
  return { code: result?.code ?? '', selfAccepting: mod?.isSelfAccepting }
}

describe('output the boundary can wrap', () => {
  test('Vite records the module as self-accepting', async () => {
    const { code, selfAccepting } = await served('/Good.mesa')

    expect(code).toContain('import.meta.hot.accept')
    expect(selfAccepting).toBe(true)
  })
})

describe('output the boundary refuses', () => {
  test('Vite records it as NOT self-accepting, so an edit escalates', async () => {
    const { code, selfAccepting } = await served('/Bad.mesa')

    expect(code).not.toContain('import.meta.hot.accept')
    expect(code).not.toContain('__mesa_register')
    expect(selfAccepting).toBe(false)
  })
})
