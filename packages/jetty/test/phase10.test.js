// Phase 10 — a code-only island does not carry the Mesa runtime (FJS-3384).
//
// An island with no `app` mounts nothing, so the content script it becomes
// (injected on every page its `matches` names) must not pay for the Mesa
// runtime that `runIsland` reaches through `mount()`. An island with an `app`
// still must carry it, or its UI has no runtime to mount on.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const PKG = resolve(fileURLToPath(import.meta.url), '../..')

let pass = 0, fail = 0
function ok(msg)  { pass++; console.log('  ✓ ' + msg) }
function bad(msg, info = '') { fail++; console.log('  ✗ ' + msg + (info ? '\n     → ' + info : '')) }

console.log('phase 10: code-only island bundle size\n')

const { autoGenForIsland } = await import('../src/build/auto-gen.js')
const { islandsViteConfig } = await import('../src/build/vite-config.js')

const root = mkdtempSync(join(tmpdir(), 'jetty-p10-'))
mkdirSync(join(root, 'src/islands'), { recursive: true })

async function bundle(id, source) {
  const path = join(root, 'src/islands', `${id}.js`)
  writeFileSync(path, source)
  const entry = autoGenForIsland({ island: { id, path }, cacheDir: join(root, '.cache'), packageRoot: PKG })
  const cfg = await islandsViteConfig({ extRoot: root, islandId: id, islandEntry: entry.path, islandPath: path, outDir: join(root, 'out') })
  cfg.logLevel = 'silent'
  await build(cfg)
  return readFileSync(join(root, 'out/islands', `${id}.js`), 'utf8')
}

const define = JSON.stringify(join(PKG, 'src/index.js'))

try {
  const code = await bundle('clip', `
    import { defineIsland } from ${define}
    export default defineIsland({ matches: ['<all_urls>'], main() { document.title += '!' } })
  `)
  if (code.length < 30_000) ok(`code-only island is ${code.length} bytes`)
  else bad(`code-only island is ${code.length} bytes`, 'the Mesa runtime is inlined into a bundle that mounts nothing')

  const ui = await bundle('badge', `
    import { defineIsland } from ${define}
    export default defineIsland({ matches: ['<all_urls>'], app(root) { root.textContent = 'hi' } })
  `)
  if (/stub mount/.test(ui)) ok('an island with an app still carries mount()')
  else bad('an island with an app lost mount()')

  // `app` the analysis cannot see (not an object literal) must keep the runtime.
  const opaque = await bundle('opaque', `
    import { defineIsland } from ${define}
    const cfg = { matches: ['<all_urls>'], app(root) { root.textContent = 'hi' } }
    export default defineIsland(cfg)
  `)
  if (/stub mount/.test(opaque)) ok('a config the build cannot read statically keeps mount()')
  else bad('a config the build cannot read statically lost mount()')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log()
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
