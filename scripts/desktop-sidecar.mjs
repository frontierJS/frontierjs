#!/usr/bin/env bun
// scripts/desktop-sidecar.mjs — a desktop app that runs its own API (FJS-D1815),
// built from a fresh scaffold and proved on whatever OS runs it.
//
//   bun scripts/desktop-sidecar.mjs stage --target bun-windows-x64 --dir <dir>
//       fli new <dir>/probe, make:desktop --wraps web --sidecar, then the screens
//       and the sidecar for that bun target, with no shell (--no-shell). The
//       sidecar cross-compiles from Linux; the shell does not, so it is built on
//       the target OS from <dir>/probe/desktop.
//
//   bun scripts/desktop-sidecar.mjs smoke <shell executable | <product>_<version>_x64-setup.exe>
//       Given a Tauri NSIS installer, installs it silently for this user first
//       (%LOCALAPPDATA%\<product>) and smokes what it installed. Launches the shell with no bun on PATH and asks what a person's install
//       has to answer: its own API started as a child on 127.0.0.1, /api/health
//       ok, a socket from each page origin a Tauri webview sends (tauri://localhost
//       on Linux and macOS, http://tauri.localhost on Windows) and none from
//       another, and no API left behind once the shell is killed — the stdin
//       lifeline is the only thing that ends it on Windows.
//
// .github/workflows/desktop-windows.yml runs `stage` on ubuntu and `smoke` on
// windows-latest; both run on a laptop the same way.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FLI  = join(ROOT, 'packages', 'cli', 'bin', 'fli.js')
const [cmd, ...rest] = process.argv.slice(2)
const opt = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback }

if (cmd === 'stage') await stage()
else if (cmd === 'smoke') await smoke(rest[0])
else fail('usage: desktop-sidecar.mjs stage --target <bun target> --dir <dir> | smoke <shell executable or NSIS setup.exe>')

async function stage() {
  const target = opt('--target', 'bun-linux-x64')
  const dir    = resolve(opt('--dir', join(ROOT, '.desktop-sidecar')))
  const app    = join(dir, 'probe')
  if (existsSync(app)) fail(`${app} exists; stage writes a fresh scaffold`)
  mkdirSync(dir, { recursive: true })
  run(process.execPath, [FLI, 'new', 'probe', '--yes', '--no-git', '--no-ci', '--auth', '--no-deploy', '--source', 'local'], dir)
  run(process.execPath, [FLI, 'make:desktop', '--wraps', 'web', '--sidecar'], app)
  run(process.execPath, ['run', 'build:desktop', '--', '--release', '--target', target, '--no-shell'], app)
  console.log(`\n  staged: ${join(app, 'desktop')} — build the shell there with cargo or the tauri cli`)
}

async function smoke(given) {
  if (!given || !existsSync(given)) fail(`no shell executable or installer at ${given}`)
  const win  = process.platform === 'win32'
  const exe  = /-setup\.exe$/i.test(given) ? install(given) : given
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const env  = { ...process.env, PATH: win ? `${root}\\System32;${root}` : '/usr/bin:/bin' }
  delete env.BUN_INSTALL

  const results = []
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

  const shell = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  shell.stdout.on('data', d => { log += d })
  shell.stderr.on('data', d => { log += d })

  // A cold WebView2 and a first-run data directory are slow on a fresh runner.
  const started = await until(90_000, () => log.match(/sidecar on http:\/\/127\.0\.0\.1:(\d+) \(pid (\d+)\)/))
  check('the shell started its own API', !!started, started ? started[0] : `no sidecar line in 90 s; output:\n${log}`)
  if (!started) return finish(shell, results)
  const [, port, pid] = started

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()).catch(e => ({ error: String(e) }))
  check('/api/health answers ok', health.status === 'ok', JSON.stringify(health).slice(0, 120))

  for (const [origin, want] of [['tauri://localhost', 'open'], ['http://tauri.localhost', 'open'], ['https://evil.example', 'refused']]) {
    const got = await upgrade(port, origin)
    check(`socket from ${origin} is ${want}`, got === want, got)
  }

  check('the API is alive while the shell runs', alive(Number(pid)), `pid ${pid}`)
  shell.kill('SIGKILL')
  const gone = await until(10_000, () => !alive(Number(pid)))
  check('killing the shell leaves no API behind', !!gone, gone ? '' : `pid ${pid} still running`)
  return finish(null, results)
}

// Tauri's NSIS installer names itself <productName>_<version>_<arch>-setup.exe
// and installs per user into %LOCALAPPDATA%\<productName>, the shell beside its
// sidecar (<slug>-api.exe) and its uninstaller.
function install(given) {
  // run() sets cwd to the installer's folder, which a relative path would then be resolved against.
  const setup   = resolve(given)
  const product = basename(setup).split('_')[0]
  const dir = join(process.env.LOCALAPPDATA ?? '', product)
  run(setup, ['/S'], dirname(setup))
  const shells = existsSync(dir) ? readdirSync(dir).filter(f => /\.exe$/i.test(f) && !/^uninstall|-api\.exe$/i.test(f)) : []
  console.log(`  installed into ${dir}: ${existsSync(dir) ? readdirSync(dir).join(', ') : 'nothing'}`)
  if (shells.length !== 1) fail(`expected one shell executable in ${dir}, found ${shells.length}`)
  return join(dir, shells[0])
}

function finish(shell, results) {
  shell?.kill('SIGKILL')
  const failed = results.filter(r => !r).length
  console.log(`\n  ${results.length - failed} ok, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

function upgrade(port, origin) {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } })
    const t = setTimeout(() => { ws.close(); done('timeout') }, 5000)
    ws.onopen  = () => { clearTimeout(t); ws.close(); done('open') }
    ws.onerror = () => { clearTimeout(t); done('refused') }
  })
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(ms, test) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = test()
    if (v) return v
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}

function run(cmd, args, cwd) {
  console.log(`\n  $ ${[cmd, ...args].join(' ')}   (in ${cwd})`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.error) fail(`${cmd} could not be started: ${r.error.message}`)
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function fail(message) {
  console.error(`\n  desktop-sidecar: ${message}\n`)
  process.exit(1)
}
