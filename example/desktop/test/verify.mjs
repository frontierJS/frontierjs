/**
 * verify:desktop — the seller's console as a desktop app, its screens bundled
 * into a native shell (FJS-D263).
 *
 * Run: `bun run verify:desktop`, after `bun run db:seed`. It starts the API
 * itself on the TEST row (7115), builds the screens and the shell, runs the
 * shell and stops everything. **bun, not node**: it imports the app, as
 * verify:stripe does, so it never needs or disturbs a dev server. It signs in
 * once, which counts against login's 10-per-15-minutes limit.
 *
 * What only this can ask is what changes when the page is not a web page. It is
 * served from tauri://localhost (http://tauri.localhost on Windows), so:
 *
 *   • the API is another ORIGIN, and the bundle must carry its URL — the
 *     wrapped surface's same-origin default would call the shell;
 *   • the router must intercept a link on a scheme that is not http(s), or every
 *     click is a full page load that lands on the right URL and looks fine
 *     (FJS-1085);
 *   • a URL loaded cold must still hand back the app, with the session intact.
 *
 * ─── Traps ────────────────────────────────────────────────────────────────
 *
 * There is no CDP. WebKitGTK and WKWebView do not speak it, so nothing here can
 * evaluate in the page; test/probe.js runs inside it and reports through the
 * shell's `probe_report` command, which only a DEBUG shell registers.
 *
 * The screens are compiled INTO the shell binary. deploy/build.mjs rebuilds
 * both halves every run; building only the screens runs the previous bundle.
 *
 * The click row is paired with its own control. `pagehides: 0` after the click
 * says the router kept the page — and means nothing unless a real reload is
 * counted, so the probe makes one on purpose and the deep-link row asserts it
 * saw exactly one.
 *
 * On Linux the shell runs under Xvfb with a throwaway XDG_DATA_HOME, so neither
 * a display nor the developer's own app data is touched.
 */

import { spawn, spawnSync }                                  from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir }                                            from 'node:os'
import { dirname, join, resolve }                            from 'node:path'
import { fileURLToPath }                                     from 'node:url'
import { results, report }                                   from '../../web/test/lib/report.mjs'

const DESKTOP  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP      = resolve(DESKTOP, '..')
const API_PORT = 7115
const API      = `http://localhost:${API_PORT}`
const LINUX    = process.platform === 'linux'

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

// ─── the API, in this process ─────────────────────────────────────────────

// Set before importing the app: app.ts reads API_PORT at module scope. The
// app's sinks would otherwise take the dev row's ports off a running server.
process.env.API_PORT      = String(API_PORT)
process.env.MAIL_SINK_URL = 'http://localhost:9/unused'
process.env.PSP_URL       = 'http://localhost:9/unused'

const { default: app } = await import('../../api/src/app.ts')
const { got, t }       = results()
const scratch          = mkdtempSync(join(tmpdir(), 'fjs-desktop-'))
let stoppedEarly       = null
let exitCode           = null

await app.start()

try {
  // ── build ───────────────────────────────────────────────────────────────
  const built = spawnSync('bun', [join(DESKTOP, 'deploy', 'build.mjs')], {
    cwd: APP, stdio: 'inherit', env: { ...process.env, VITE_API_URL: API },
  })
  if (built.status !== 0) throw new Error(`build:desktop exited ${built.status}`)

  const assets = join(DESKTOP, 'dist', 'assets')
  t('build.bundleCarriesTheApi', readdirSync(assets)
    .some(f => f.endsWith('.js') && readFileSync(join(assets, f), 'utf8').includes(API)))

  // ── run the shell with the probe inside it ──────────────────────────────
  const probe = join(scratch, 'probe.js')
  writeFileSync(probe, readFileSync(join(DESKTOP, 'test', 'probe.js'), 'utf8').replaceAll('__API__', API))

  // Named for the crate, which make:desktop derives from the app's name.
  const crate  = readFileSync(join(DESKTOP, 'shell', 'Cargo.toml'), 'utf8').split('\n')
    .find(l => l.startsWith('name'))?.split('"')[1]
  const binary = join(DESKTOP, 'shell', 'target', 'debug', crate)
  if (!existsSync(binary)) throw new Error(`no shell at ${binary}`)

  const env = {
    ...process.env,
    FJS_DESKTOP_PROBE:               probe,
    XDG_DATA_HOME:                   join(scratch, 'data'),
    WEBKIT_DISABLE_DMABUF_RENDERER:  '1',
  }
  const [cmd, args] = LINUX
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1280x900x24', binary]]
    : [binary, []]

  const rows = {}
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
    const timer = setTimeout(() => { try { process.kill(LINUX ? -child.pid : child.pid, 'SIGKILL') } catch {} }, 90_000)
    child.on('exit', (code) => { clearTimeout(timer); done(code) })
  })

  if (rows.watchdog) console.error('probe watchdog:', JSON.stringify(rows.watchdog))
  if (rows.threw)    console.error('probe threw:', rows.threw)

  t('shell.exited',             exitCode)
  t('page.origin',              rows.page?.origin)
  t('api.reachedCrossOrigin',   rows['api.health'])
  t('signIn.asStaff',           rows.signIn)
  t('click.keptThePage',        rows.click && {
    defaultPrevented: rows.click.defaultPrevented,
    arrived:          rows.click.arrived,
    pagehides:        rows.click.pagehides,
  })
  t('orders.rendered',          rows.click?.rows)
  t('socket.openToTheApi',      rows.sockets?.some(u => u === `ws://localhost:${API_PORT}/ws`))
  t('deepLink.coldLoad',        rows.deepLink && {
    path:     rows.deepLink.path,
    signedIn: rows.deepLink.signedIn,
  })
  t('deepLink.rows',            rows.deepLink?.rows)
  // The control for click.keptThePage: the one reload the probe made itself.
  t('reload.wasCounted',        rows.deepLink?.pagehides)
  t('errors.none',              [...(rows['errors.first'] ?? ['not reported']), ...(rows['errors.reloaded'] ?? ['not reported'])])
} catch (e) {
  stoppedEarly = e
  console.error(e)
} finally {
  await app.stop()
  rmSync(scratch, { recursive: true, force: true })
}

const expected = {
  'build.bundleCarriesTheApi': true,
  'shell.exited':              0,
  // Named rather than "not the API": a shell that loaded the dev server would
  // pass that and prove nothing about a bundled page.
  'page.origin':               (o) => o === 'tauri://localhost' || o === 'http://tauri.localhost',
  'api.reachedCrossOrigin':    200,
  'signIn.asStaff':            (v) => typeof v === 'string' && v.includes('level 5'),
  'click.keptThePage':         { defaultPrevented: true, arrived: true, pagehides: 0 },
  'orders.rendered':           (n) => n > 0,
  'socket.openToTheApi':       true,
  'deepLink.coldLoad':         (v) => v.path === '/orders/' && typeof v.signedIn === 'string' && v.signedIn.includes('level 5'),
  'deepLink.rows':             (n) => n > 0,
  'reload.wasCounted':         1,
  'errors.none':               [],
}

process.exit(report(got, expected, { stoppedEarly }))
