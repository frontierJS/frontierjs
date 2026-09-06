/**
 * render-runtime-identity.test.js
 *
 * Two questions about what a server render writes out.
 *
 * 1. WHICH runtime the temp module runs against (FJS-835). A compiled module
 *    imports the runtime by bare specifier, and Node resolves that from wherever
 *    the temp file was written — so `options.tmpDir`, which Sierra sets on every
 *    build, chose the copy. A foreign one never received
 *    `setRenderEnvironment(true, false)` and, because happy-dom's globals are
 *    installed BEFORE the import, believed it was in a browser: `{@attach}` ran
 *    (FJS-146's symptom, reopened) and `island()` emitted no markers at all.
 *
 *    That half runs in a spawned `bun`, not here, for two reasons. Vitest's
 *    module runner refuses to load a module outside its root, so the foreign
 *    tmpDir the defect needs cannot be imported in-process at all; and bun
 *    resolves an unresolvable bare specifier out of its global install cache,
 *    which is exactly the second copy of Mesa the defect turns on.
 *
 * 2. Whether a page wrapper's attribute sinks escape (FJS-860). `title` and
 *    `meta` did; `css`, `scripts[]` and `islandLoader` did not.
 *
 * Run: npx vitest run render-runtime-identity.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { wrapPage, escapeHTML } from '../src/render.js'

const run = promisify(execFile)
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

let dir

const DRIVER = `
import { renderComponent } from ${JSON.stringify(path.join(SRC, 'render-component.js'))}
const dir = import.meta.dir
const out = {}

globalThis.__attachRan = false
const att = await renderComponent(
  [
    '<script>',
    '  function ring(el) { globalThis.__attachRan = true }',
    '</script>',
    '',
    '<div {@attach ring}>hi</div>',
  ].join('\\n'),
  { filename: 'Att.mesa', cwd: dir, target: 'fragment', tmpDir: dir }
)
out.attachRan = globalThis.__attachRan
out.attachHtml = att.html

const isl = await renderComponent(
  "<script>\\n  import Leaf from './Leaf.mesa'\\n</script>\\n\\n<section><Leaf client:load /></section>",
  { filename: 'Isl.mesa', cwd: dir, target: 'fragment', islands: true, tmpDir: dir }
)
out.islandHtml = isl.html

console.log('__RESULT__' + JSON.stringify(out))
`

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mesa-foreign-'))
  await writeFile(path.join(dir, 'Leaf.mesa'), '<div>leaf</div>\n')
  await writeFile(path.join(dir, 'drive.mjs'), DRIVER)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('a render under a caller-supplied tmpDir', () => {
  let result

  beforeAll(async () => {
    const { stdout } = await run('bun', [path.join(dir, 'drive.mjs')], { cwd: dir })
    const line = stdout.split('\n').find(l => l.startsWith('__RESULT__'))
    result = JSON.parse(line.slice('__RESULT__'.length))
  }, 60000)

  it('leaves {@attach} unrun on the server', () => {
    expect(result.attachHtml).toContain('hi')
    expect(result.attachRan).toBe(false)
  })

  it('still emits island markers', () => {
    expect(result.islandHtml).toContain('mesa-island')
  })
})

describe('wrapPage attribute sinks', () => {
  const html = wrapPage('<p>x</p>', {
    title:        'ok',
    css:          '/a.css" onload="alert(1)',
    scripts:      ['/a.js"></script><script>alert(2)</script><script src="'],
    islandLoader: '/l.js" onerror="alert(3)',
  })

  it('leaves the stylesheet value inside its attribute', () => {
    expect(html).not.toContain('onload="alert(1)"')
    expect(html).toContain('href="/a.css&quot; onload=&quot;alert(1)"')
  })

  it('does not let a script src close its own tag', () => {
    expect(html).not.toContain('<script>alert(2)</script>')
    expect(html.match(/<script/g)).toHaveLength(2)
  })

  it('leaves the island loader value inside its attribute', () => {
    expect(html).not.toContain('onerror="alert(3)"')
  })

  it('escapes an apostrophe, which a single-quoted attribute needs', () => {
    expect(escapeHTML("a'b")).toBe('a&#39;b')
  })
})
