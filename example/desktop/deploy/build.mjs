// desktop/deploy/build.mjs — build the desktop app: its screens, then the shell.
//
//   bun run build:desktop              debug shell, the one the drive runs
//   bun run build:desktop -- --release
//   VITE_API_URL=https://api.example.com bun run build:desktop -- --release
//
// The one reader of desktop/config/desktop.config.js (FJS-D263). Two refusals,
// both for failures that otherwise build clean and ship broken:
//
//   • a wrapped surface with no `api`: the bundle would keep the wrapped
//     surface's same-origin default, and in the shell that origin is the shell.
//   • a bundle that does not carry `api` after the build: the wrapped surface's
//     sierra.config.js is what inlines it, and a surface that stopped reading
//     VITE_API_URL there builds a desktop app pointed at nothing.
//
// The screens are built into desktop/dist and never into the wrapped surface's
// own dist/, because `vite build` empties its outDir.

import { spawnSync }                                 from 'node:child_process'
import { existsSync, readdirSync, readFileSync }     from 'node:fs'
import { dirname, join, resolve }                    from 'node:path'
import { fileURLToPath }                             from 'node:url'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP     = resolve(DESKTOP, '..')
const release = process.argv.includes('--release')

const { default: config } = await import(join(DESKTOP, 'config', 'desktop.config.js'))

const screens = config.wraps ? join(APP, config.wraps) : DESKTOP
const viteConfig = join(screens, 'config', 'vite.config.js')
if (!existsSync(viteConfig)) refuse(
  `${config.wraps ? `wraps: '${config.wraps}'` : 'this surface'} has no config/vite.config.js at ${viteConfig}.`)
if (config.wraps && !config.api) refuse(
  `wraps: '${config.wraps}' with no api. The page is served from tauri://localhost, so the ` +
  `wrapped surface's same-origin default would send every API call to the shell.`)

const dist = join(DESKTOP, 'dist')
run('bunx', ['--bun', 'vite', 'build', '-c', viteConfig, '--outDir', dist, '--emptyOutDir'], {
  cwd: APP,
  env: { ...process.env, ...(config.api ? { VITE_API_URL: config.api } : {}) },
})

if (config.api && !bundleNames(dist, config.api)) refuse(
  `the build finished and no file under ${dist} contains ${config.api}. The screens' ` +
  `sierra.config.js has to read VITE_API_URL for junction.url.`)

run('cargo', ['build', ...(release ? ['--release'] : []), '--manifest-path', join(DESKTOP, 'shell', 'Cargo.toml')], {
  cwd: DESKTOP,
})

console.log(`\n  desktop shell: ${join(DESKTOP, 'shell', 'target', release ? 'release' : 'debug', 'kitchen-sink-desktop')}`)

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

function refuse(message) {
  console.error(`\n  build:desktop refused — ${message}\n`)
  process.exit(1)
}
