// desktop/test/verify.mjs — Workbench as a desktop app, its screens bundled into
// a native shell, driven to the local repos scan.
//
//   bun run verify:desktop
//
// Starts and stops everything itself: a scratch database, WORKBENCH_DIR and
// HOME in a temp directory, the API on a port the OS hands out, then builds the
// screens and the shell and runs the shell under Xvfb.
//
// What only this can ask is what changes when the page is not a web page. It
// is served from tauri://localhost, so:
//
//   • the API is another ORIGIN — the bundle must carry its URL, and the API's
//     CORS list must name the shell's origin or every call is refused;
//   • sign-in has no cookie to fall back on across that origin, so the session
//     must ride the stored token;
//   • the link to the local repos screen must route inside the page rather
//     than reload it, on a scheme that is not http(s);
//   • the scan reads THIS machine's checkouts (a fake ~/code here) and its
//     answer never carries the token in a remote.
//
// ─── Traps ────────────────────────────────────────────────────────────────
//
// Workbench lives in the global port block, which has no slot for a drive, so
// the API takes an OS-chosen port and the bundle is built against it. The
// binary this leaves behind points at that port, so `bun run build:desktop`
// afterwards puts the dev one (5501) back.
//
// There is no CDP. test/probe.js runs inside the page and reports through the
// shell's `probe_report` command, which only a DEBUG shell registers.
//
// The shell runs with a throwaway XDG_DATA_HOME, so the developer's own app
// data — their session included — is never touched. The jobs queue is the one
// thing shared: caravan opens db/workbench-jobs.db beside the schema, as the
// test suite does.

// No port is held. The build writes desktop/dist, so two runs of this drive
// at once would build over each other.
export const holds = []

import { spawn, spawnSync }                                  from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer }                                      from 'node:net'
import { tmpdir }                                            from 'node:os'
import { dirname, join, resolve }                            from 'node:path'
import { fileURLToPath }                                     from 'node:url'

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG     = resolve(DESKTOP, '..')
// core/env.ts's dev default; the API below is started without WORKBENCH_KEY.
const KEY     = 'workbench-dev-only'
const LINUX   = process.platform === 'linux'

const sleep = ms => new Promise(r => setTimeout(r, ms))
let passed = 0, failed = 0
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else      { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 300)}` : ''}`) }
}

// Ask the OS for a free port, then give it back for the API to bind.
const freePort = () => new Promise((done, fail) => {
  const s = createServer()
  s.once('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)) })
})

// ─── toolchain ────────────────────────────────────────────────────────────

const missing = [
  ['cargo', ['--version'], 'Rust (https://rustup.rs)'],
  ...(LINUX ? [
    ['xvfb-run', ['--help'], 'xvfb (apt install xvfb)'],
    ['pkg-config', ['--exists', 'webkit2gtk-4.1'], 'WebKitGTK 4.1 (apt install libwebkit2gtk-4.1-dev)'],
  ] : []),
].filter(([cmd, args]) => spawnSync(cmd, args, { stdio: 'ignore' }).status !== 0)
if (missing.length) {
  console.error(`\nverify:desktop needs ${missing.map(m => m[2]).join(', ')}.\n`)
  process.exit(1)
}

const API_PORT = await freePort()
const API      = `http://localhost:${API_PORT}`

// ─── a database, a WORKBENCH_DIR and a HOME of their own ──────────────────
// Two checkouts under ~/code: one committed, with a token in its remote and a
// file left uncommitted, and one empty.

const scratch = mkdtempSync(join(tmpdir(), 'workbench-desktop-'))
const HOME    = join(scratch, 'home')
const gitIn = (cwd, ...args) => spawnSync('git', args, { cwd, env: { ...process.env, HOME,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
for (const name of ['alpha', 'beta']) {
  mkdirSync(join(HOME, 'code', name), { recursive: true })
  gitIn(join(HOME, 'code', name), 'init', '-q', '-b', 'main')
}
const ALPHA = join(HOME, 'code', 'alpha')
writeFileSync(join(ALPHA, 'README'), 'x')
gitIn(ALPHA, 'add', '.'); gitIn(ALPHA, 'commit', '-q', '-m', 'first commit')
gitIn(ALPHA, 'remote', 'add', 'origin', 'https://me:tok_secret@example.test/alpha.git')
writeFileSync(join(ALPHA, 'dirty.txt'), 'y')

console.log('\nWorkbench — the desktop shell\n')

// Detached so `-pid` is its group: `bun api/index.ts` alone would leave the
// server holding the port for the next run to be answered by.
const api = spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, DATABASE_URL: join(scratch, 'workbench.db'), WORKBENCH_DIR: join(scratch, 'workbench'),
    PORT: String(API_PORT), HOME, WORKBENCH_KEY: KEY },
})

let stoppedEarly = null
let exitCode     = null
const rows       = {}

try {
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    up = await fetch(`${API}/health`).then(r => r.ok, () => false)
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`the API never answered ${API}/health`)

  // ── build ───────────────────────────────────────────────────────────────
  const built = spawnSync('bun', [join(DESKTOP, 'deploy', 'build.mjs')], {
    cwd: PKG, stdio: 'inherit', env: { ...process.env, FRONTIER_PUBLIC_API_URL: API },
  })
  if (built.status !== 0) throw new Error(`build:desktop exited ${built.status}`)

  const assets = join(DESKTOP, 'dist', 'assets')
  check('the bundle carries the API', readdirSync(assets)
    .some(f => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes(API)))

  // ── run the shell with the probe inside it ──────────────────────────────
  const probe = join(scratch, 'probe.js')
  writeFileSync(probe, readFileSync(join(DESKTOP, 'test', 'probe.js'), 'utf8')
    .replaceAll('__API__', API).replaceAll('__KEY__', KEY))

  const crate  = readFileSync(join(DESKTOP, 'shell', 'Cargo.toml'), 'utf8').split('\n')
    .find(l => l.startsWith('name'))?.split('"')[1]
  const binary = join(DESKTOP, 'shell', 'target', 'debug', crate)
  if (!existsSync(binary)) throw new Error(`no shell at ${binary}`)

  const env = {
    ...process.env,
    FJS_DESKTOP_PROBE:              probe,
    XDG_DATA_HOME:                  join(scratch, 'data'),
    WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  }
  const [cmd, args] = LINUX
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x900x24', binary]]
    : [binary, []]

  exitCode = await new Promise((done) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'], detached: LINUX })
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('[probe] ')) continue
        const { row, value } = JSON.parse(line.slice(8))
        rows[row] ??= value
      }
    })
    // xvfb-run is a wrapper: signaling it alone leaves the shell holding the
    // display, so the whole group goes.
    const timer = setTimeout(() => { try { process.kill(LINUX ? -child.pid : child.pid, 'SIGKILL') } catch {} }, 120_000)
    child.on('exit', (code) => { clearTimeout(timer); done(code) })
  })
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  try { process.kill(-api.pid, 'SIGTERM') } catch {}
  await sleep(500)
  try { process.kill(-api.pid, 'SIGKILL') } catch {}
  rmSync(scratch, { recursive: true, force: true })
}

if (rows.watchdog) console.error('probe watchdog:', JSON.stringify(rows.watchdog))
if (rows.threw)    console.error('probe threw:', rows.threw)

if (!stoppedEarly) {
  const scan = rows.scan ?? {}
  check('the shell exited cleanly', exitCode === 0, exitCode)
  // Named rather than "not the API": a shell that loaded a dev server would
  // pass that and prove nothing about a bundled page.
  check('the page is served from the shell',
    ['tauri://localhost', 'http://tauri.localhost'].includes(rows.page?.origin), rows.page)
  check('the API answers across origins', rows['api.health'] === 200, rows['api.health'])
  check('the key at the door lands on /workbench/ with a stored token',
    rows.signIn?.landed && rows.signIn?.token, rows.signIn)
  check('the link reaches /git-activity/local/ without a reload',
    rows.nav?.arrived && rows.nav?.path === '/git-activity/local/' && rows.nav?.reloads === 0, rows.nav)
  check('the scan lists both checkouts under ~/code',
    scan.listed && /alpha/.test(scan.text) && /beta/.test(scan.text), scan)
  check('with branch and dirty state', /main/.test(scan.text) && /1 changed/.test(scan.text), scan.text)
  check('and the remote with its token cut out',
    /https:\/\/example\.test\/alpha\.git/.test(scan.text) && scan.leaked === false, scan.text)
  check('no page errors', Array.isArray(rows.errors) && rows.errors.length === 0, rows.errors)
}

console.log(`\n  ${passed} passed, ${failed} failed${stoppedEarly ? ' — stopped early' : ''}\n`)
process.exit(failed || stoppedEarly ? 1 : 0)
