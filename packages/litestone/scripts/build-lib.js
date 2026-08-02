#!/usr/bin/env bun
// Bundle the LIBRARY (not the CLI) into a single drop-in file.
//
//   bun run build:lib                  → dist/lib/litestone.js + .d.ts + .map
//   bun run build:lib:testing          → adds makeTestClient/Factory via a shared chunk
//   bun scripts/build-lib.js --no-sourcemap
//   bun scripts/build-lib.js --no-minify
//
// This exists for vendoring: copying one file into another package so it loads
// THIS workspace build rather than whatever `@frontierjs/litestone: latest`
// resolves to from npm. The bundle is Bun-only — it imports bun:sqlite, plus
// fs/path/os/crypto/child_process. Nothing from npm; the package has no
// third-party deps, which is why a single file is viable at all.
//
// --with-testing uses code splitting because src/testing.js pulls in the whole
// core: two independent bundles cost ~547 KB, a split build ~340 KB.

import { copyFileSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'fs'
import { resolve, join }                                                     from 'path'

const ROOT = resolve(import.meta.dir, '..')
const DIST = resolve(ROOT, 'dist/lib')
const PKG  = await Bun.file(resolve(ROOT, 'package.json')).json()

const args    = process.argv.slice(2)
const flag    = n => args.includes(`--${n}`)
const minify  = !flag('no-minify')
const sources = !flag('no-sourcemap')
const testing = flag('with-testing')

// Stamp the build so a vendored copy can be identified later. Git SHA is
// best-effort — the tarball consumer may not have a repo.
const sha = (() => {
  const p = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  return p.exitCode === 0 ? new TextDecoder().decode(p.stdout).trim() : null
})()
const banner = `// @frontierjs/litestone ${PKG.version}${sha ? ` (git ${sha})` : ''} — bundled single-file build\n` +
               `// Requires Bun (imports bun:sqlite). Regenerate with: bun run build:lib`

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const cmd = [
  'bun', 'build',
  '--target=bun',
  ...(minify  ? ['--minify'] : []),
  ...(sources ? ['--sourcemap=linked'] : []),
  '--banner', banner,
  ...(testing ? ['--splitting'] : []),
  resolve(ROOT, 'src/index.js'),
  ...(testing ? [resolve(ROOT, 'src/testing.js')] : []),
  '--outdir', DIST,
]

const proc = Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
if (proc.exitCode !== 0) {
  console.error(new TextDecoder().decode(proc.stderr))
  process.exit(1)
}

// Bun names entry outputs after the entry basename. "index.js" is a poor filename
// to drop into someone else's package, so rename it. Safe because shared chunks
// import each other, never the entry.
if (existsInDist('index.js')) renameSync(join(DIST, 'index.js'), join(DIST, 'litestone.js'))
if (existsInDist('index.js.map')) renameSync(join(DIST, 'index.js.map'), join(DIST, 'litestone.js.map'))

// Types ship as-is: index.d.ts has no relative imports, so it needs no bundling.
copyFileSync(resolve(ROOT, 'src/index.d.ts'), join(DIST, 'litestone.d.ts'))
if (testing) copyFileSync(resolve(ROOT, 'src/testing.d.ts'), join(DIST, 'testing.d.ts'))

function existsInDist(f) { try { statSync(join(DIST, f)); return true } catch { return false } }

const kb    = f => (statSync(join(DIST, f)).size / 1024).toFixed(0).padStart(4) + ' KB'
const files = readdirSync(DIST).sort()
const total = files.reduce((n, f) => n + statSync(join(DIST, f)).size, 0)

console.log(`\n  dist/lib/`)
for (const f of files) {
  const chunk = /-[a-z0-9]{8}\.js$/.test(f) ? '  (shared chunk)' : ''
  console.log(`    ${kb(f)}  ${f}${chunk}`)
}
console.log(`\n  total ${(total / 1024).toFixed(0)} KB · minify ${minify ? 'on' : 'off'} · sourcemap ${sources ? 'on' : 'off'}`)
console.log(`\n  Vendor it:  import { createClient } from './vendor/litestone.js'`)
if (testing) console.log(`              import { makeTestClient } from './vendor/testing.js'`)
console.log(`  Bun-only — imports bun:sqlite.\n`)
