// desktop/deploy/build.mjs — build the desktop app: its screens, then the shell.
//
//   bun run build:desktop              debug shell
//   bun run build:desktop -- --release
//   VITE_API_URL=https://api.example.com bun run build:desktop -- --release
//
// The one reader of desktop/config/desktop.config.js (FJS-D263). Two refusals,
// both for failures that otherwise build clean and ship broken:
//
//   • no `api`: the page is served from tauri://localhost, so a same-origin
//     default sends every API call to the shell. `null` says there is no API.
//   • a bundle that does not carry `api` after the build: the screens'
//     sierra.config.js is what inlines it, and one that stopped reading
//     VITE_API_URL builds a desktop app pointed at nothing.
//
// The screens are built into desktop/dist and never into a wrapped surface's
// own dist/, because `vite build` empties its outDir. The shell compiles dist
// INTO the binary, so building one half alone runs the previous other half.

import { spawnSync }                             from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve }                from 'node:path'
import { fileURLToPath }                         from 'node:url'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP     = resolve(DESKTOP, '..')
const SHELL   = join(DESKTOP, 'shell')
const release = process.argv.includes('--release')

const { default: config } = await import(join(DESKTOP, 'config', 'desktop.config.js'))

const screens    = config.wraps ? join(APP, config.wraps) : DESKTOP
const viteConfig = join(screens, 'config', 'vite.config.js')
if (!existsSync(viteConfig)) refuse(
  `${config.wraps ? `wraps: '${config.wraps}'` : 'this surface'} has no config/vite.config.js at ${viteConfig}.`)
if (config.api === undefined) refuse(
  'desktop.config.js names no api. The page is served from tauri://localhost, so a same-origin ' +
  'default would send every API call to the shell. Set api: null if this app has no API.')

// From the screens' own directory: a surface's vite config may leave its root
// to the working directory, which is what `cd web && vite` relies on.
const dist = join(DESKTOP, 'dist')
run('bun', ['--bun', 'vite', 'build', '-c', viteConfig, '--outDir', dist, '--emptyOutDir'], {
  cwd: screens,
  env: { ...process.env, ...(config.api ? { VITE_API_URL: config.api } : {}) },
})

if (config.api && !bundleNames(dist, config.api)) refuse(
  `the build finished and no file under ${dist} contains ${config.api}. The screens' ` +
  'sierra.config.js has to read VITE_API_URL for junction.url.')

run('cargo', ['build', ...(release ? ['--release'] : []), '--manifest-path', join(SHELL, 'Cargo.toml')], {
  cwd: DESKTOP,
})

console.log(`\n  desktop shell: ${join(SHELL, 'target', release ? 'release' : 'debug', crateName())}`)

// ─── helpers ──────────────────────────────────────────────────────────────

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) refuse(`${cmd} could not be started: ${r.error.message}`)
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function bundleNames(dir, needle) {
  const assets = join(dir, 'assets')
  if (!existsSync(assets)) return false
  return readdirSync(assets)
    .filter(f => f.endsWith('.js'))
    .some(f => readFileSync(join(assets, f), 'utf8').includes(needle))
}

// The binary is named for the crate, so Cargo.toml is read rather than restated.
function crateName() {
  const line = readFileSync(join(SHELL, 'Cargo.toml'), 'utf8')
    .split('\n')
    .find(l => l.startsWith('name'))
  return line?.split('"')[1] ?? 'desktop'
}

function refuse(message) {
  console.error(`\n  build:desktop refused — ${message}\n`)
  process.exit(1)
}
