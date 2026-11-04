// desktop/sidecar/make-sidecar.ts — stage the API sidecar for the Tauri shell
// (FJS-D1815): one bun binary with every package compiled in, and the app's
// own files beside it as the bundle's resources. Written by
// `fli make:desktop --sidecar`; IDEAS/portable-install.md is why each step is.
//
//   bun desktop/sidecar/make-sidecar.ts [--target bun-linux-x64]
//
// Writes desktop/sidecar/bundled.ts (the compiled-in packages, derived from the
// API's own imports on every run) and desktop/shell/sidecar/ (git-ignored):
//   __SLUG__-api-<triple>[.exe]  tauri.conf.json bundle.externalBin — Tauri
//                               requires the target-triple suffix
//   app/                        tauri.conf.json bundle.resources
//     api/                      minus test/
//     db/schema.lite, db/migrations/
//     node_modules/@frontierjs/*  stubs over the compiled-in packages, plus
//                               each package's non-code exports (.lite)
//     node_modules/<npm dep>    the app's plain npm dependencies, copied whole
import * as fs from 'node:fs'
import * as path from 'node:path'

const { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = fs
const { dirname, join, resolve } = path

const HERE = import.meta.dir
const APP = resolve(HERE, '../..')
const OUT = join(APP, 'desktop', 'shell', 'sidecar')
const NAME = '__SLUG__-api'

// bun's compile target → the Rust triple Tauri suffixes an externalBin with.
// Any target builds on any host: bun fetches that target's runtime.
const TRIPLES: Record<string, string> = {
  'bun-linux-x64': 'x86_64-unknown-linux-gnu',
  'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
  'bun-windows-x64': 'x86_64-pc-windows-msvc',
  'bun-darwin-x64': 'x86_64-apple-darwin',
  'bun-darwin-arm64': 'aarch64-apple-darwin',
}
const ti = process.argv.indexOf('--target')
const target = ti > 0 ? process.argv[ti + 1] : 'bun-linux-x64'
const triple = TRIPLES[target]
if (!triple) {
  console.error(`make-sidecar: no triple for --target ${target}; one of ${Object.keys(TRIPLES).join(', ')}`)
  process.exit(1)
}

// The packages compiled in are the ones the API's own files import. Derived on
// every run, so an import added to a service is compiled in by the next build.
// The same two functions are @frontierjs/cli's core/desktop-sidecar.js, which
// writes them here.
/*__SPECIFIERS_FN__*/
/*__BUNDLED_FN__*/
const specs = frontierSpecifiers(APP, fs, path)
const bundledFile = join(HERE, 'bundled.ts')
const bundled = bundledSource(specs)
if (!existsSync(bundledFile) || readFileSync(bundledFile, 'utf8') !== bundled) writeFileSync(bundledFile, bundled)

rmSync(OUT, { recursive: true, force: true })
const app = join(OUT, 'app')
mkdirSync(join(app, 'db'), { recursive: true })
cpSync(join(APP, 'api'), join(app, 'api'), { recursive: true, filter: (p) => !/[\\/]api[\\/]test([\\/]|$)/.test(p) })
cpSync(join(APP, 'db', 'schema.lite'), join(app, 'db', 'schema.lite'))
if (existsSync(join(APP, 'db', 'migrations'))) cpSync(join(APP, 'db', 'migrations'), join(app, 'db', 'migrations'), { recursive: true })

// The app's plain npm dependencies are not compiled in: the on-disk files
// import them through node resolution, so each package is copied whole — its
// own dependencies are not followed (FJS-3959).
const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  if (dep.startsWith('@frontierjs/')) continue
  cpSync(realpathSync(join(APP, 'node_modules', dep)), join(app, 'node_modules', dep), { recursive: true, dereference: true })
}

// A stub per bundled specifier, and every non-code export (a schema fragment)
// copied from the real package under its exports map.
const byPkg = new Map<string, Record<string, string>>()
for (const spec of specs) {
  const [scope, name, ...rest] = spec.split('/')
  const p = `${scope}/${name}`
  const sub = rest.length ? `./${rest.join('/')}` : '.'
  const mod = await import(spec)
  const keys = Object.keys(mod).filter((k) => k !== 'default')
  const file = `${sub === '.' ? 'index' : rest.join('__')}.js`
  const body =
    `const m = globalThis.__fjsBundled[${JSON.stringify(spec)}]\n` +
    (keys.length ? `export const { ${keys.join(', ')} } = m\n` : '') +
    ('default' in mod ? 'export default m.default\n' : '')
  mkdirSync(join(app, 'node_modules', p), { recursive: true })
  writeFileSync(join(app, 'node_modules', p, file), body)
  byPkg.set(p, { ...(byPkg.get(p) ?? {}), [sub]: `./${file}` })
}
for (const [p, exportsMap] of byPkg) {
  const realDir = realpathSync(join(APP, 'node_modules', p))
  const real = JSON.parse(readFileSync(join(realDir, 'package.json'), 'utf8'))
  for (const [sub, t0] of Object.entries(real.exports ?? {})) {
    const t = typeof t0 === 'string' ? t0 : (t0 as Record<string, string>)?.default
    if (!t || /\.[mc]?[jt]s$/.test(t) || sub in exportsMap) continue
    if (t.includes('*')) {
      const dir = t.slice(0, t.indexOf('*'))
      if (!existsSync(join(realDir, dir))) continue
      cpSync(join(realDir, dir), join(app, 'node_modules', p, dir), { recursive: true, filter: (f) => !/\.[mc]?[jt]s$/.test(f) })
    } else {
      if (!existsSync(join(realDir, t))) continue
      mkdirSync(dirname(join(app, 'node_modules', p, t)), { recursive: true })
      cpSync(join(realDir, t), join(app, 'node_modules', p, t))
      // A compiled binary's resolver does not follow a renaming exports entry
      // (bun 1.4.4, portable-install wall 3): it looks for the subpath itself.
      mkdirSync(dirname(join(app, 'node_modules', p, sub)), { recursive: true })
      cpSync(join(realDir, t), join(app, 'node_modules', p, sub))
    }
    exportsMap[sub] = t
  }
  writeFileSync(join(app, 'node_modules', p, 'package.json'), `${JSON.stringify({ name: p, type: 'module', exports: exportsMap }, null, 2)}\n`)
}

// bun build inlines process.env.NODE_ENV as "development" whatever the
// environment says (portable-install wall 6), so it is defined.
const exe = join(OUT, `${NAME}-${triple}${target.startsWith('bun-windows') ? '.exe' : ''}`)
const build = Bun.spawnSync(
  ['bun', 'build', '--compile', `--target=${target}`, '--define', 'process.env.NODE_ENV="production"', join(HERE, 'launcher.ts'), '--outfile', exe],
  { stdout: 'inherit', stderr: 'inherit', cwd: APP },
)
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
console.log(`  sidecar: ${exe}\n  resources: ${app}`)
