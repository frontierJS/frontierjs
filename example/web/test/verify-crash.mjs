/**
 * web/test/verify-crash.mjs — a crash rings once.
 *
 * **bun, starts its own API.** No browser, no vite, and no ntfy: a loopback
 * listener stands in for the server and records what the API POSTs to it.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * `@frontierjs/notifications` sends one critical push when the app dies of an
 * uncaught throw (`FJS-D2184` to `FJS-D2187`), and `--restart unless-stopped`
 * brings the app straight back, so a crash loop would ring all night without
 * the ten-minute window. The package's own test proves both on a fixture app.
 * This proves the same on the REAL example API: that the plugin is installed
 * and its boot runs, that the ping leaves before the process exits, and that
 * the second crash inside the window sends nothing.
 *
 * ─── Why the API runs from a copy ─────────────────────────────────────────
 *
 * Under `tenancy { strategy database }` the fleet lives in `db/shops/` beside
 * the schema, and no environment variable moves it (`SHOP_DB_PATH` is the
 * `main` path a registry never uses). An API started in place would open the
 * shop a peer's drive on 8110 is using, and would leave the `.crash-ping`
 * record where the next run, or the next person, finds a window already open.
 * So the app is copied into a scratch directory, schema and all, and the
 * database, the window record and the fleet are born there and removed with it.
 *
 * ─── Reading it ───────────────────────────────────────────────────────────
 *
 *   `first.*`  — the crash that rings: one POST, to the topic, critical, titled
 *                for the app, with the error in the body, and a non-zero exit.
 *   `second.*` — a crash inside the window: the process dies the same way and
 *                the listener hears nothing more.
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORTS, TEST_SINK_ENV } from './lib/preflight.mjs'
import { results, report } from './lib/report.mjs'

export const holds = ['ports']

const HERE    = dirname(fileURLToPath(import.meta.url))
const ROOT    = join(HERE, '../..')
const PRELOAD = join(HERE, 'fixtures/crash/preload.mjs')
const TOPIC   = 'example-crash-drive'
const API_PORT = String(PORTS.apiTest)

const { got, t } = results()

// A cold boot builds the shop from the schema, which is slow on a loaded box.
const BOOT_MS = 120_000

// ─── The listener standing in for ntfy ────────────────────────────────────

const posts = []
const ntfy = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    posts.push({
      method:   req.method,
      path:     new URL(req.url).pathname,
      title:    req.headers.get('Title'),
      priority: req.headers.get('Priority'),
      body:     await req.text(),
    })
    return Response.json({ id: 'drive' })
  },
})

// ─── The app, copied ──────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'fjs-crash-'))
const app     = join(scratch, 'app')
// The record sits beside the main database, which under a fleet is a shop's
// file, so it lands in `db/shops/` (already ignored) and not in `db/`.
const recordFile = join(app, 'db', 'shops', '.crash-ping')

let child = null
const stop = () => { try { child?.kill('SIGKILL') } catch {} }
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(130) })

function copyApp() {
  // `dist` is 20 MB of build output the API does not read, and the `.db` files
  // are somebody else's data. node_modules is linked, not copied: the schema's
  // imports resolve from the file's own path.
  cpSync(join(ROOT, 'api'), join(app, 'api'), {
    recursive: true,
    filter: (src) => !/\/api\/dist(\/|$)/.test(src),
  })
  for (const f of ['schema.lite', 'user.lite', 'migrations'])
    cpSync(join(ROOT, 'db', f), join(app, 'db', f), { recursive: true })
  for (const f of ['package.json', 'tsconfig.json', 'config'])
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(app, f), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'))
}

// One API process: started with the settings, answering, then crashed.
async function crashOnce() {
  let stderr = ''
  child = spawn('bun', ['--preload', PRELOAD, 'api/index.ts'], {
    cwd: app, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, ...TEST_SINK_ENV,
      API_PORT,
      NTFY_BASE_URL: `http://127.0.0.1:${ntfy.port}`,
      NTFY_TOPIC:    TOPIC,
      NTFY_TOKEN:    '',
    },
  })
  child.stderr.on('data', d => { stderr += d; if (process.env.DEBUG) process.stderr.write(`[api] ${d}`) })
  const exited = new Promise(res => child.on('exit', (code, signal) => res({ code, signal })))

  let up = false
  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    const gone = await Promise.race([exited, new Promise(r => setTimeout(() => r(null), 250))])
    if (gone) break
    try { if ((await fetch(`http://localhost:${API_PORT}/api/products`)).ok) { up = true; break } } catch {}
  }
  if (!up) { stop(); return { up, stderr: stderr.slice(-2000) } }

  child.kill('SIGUSR2')
  const end = await Promise.race([exited, new Promise(r => setTimeout(() => r('timeout'), 30_000))])
  if (end === 'timeout') { stop(); return { up, timedOut: true, stderr: stderr.slice(-2000) } }
  child = null
  return { up, ...end, stderr: stderr.slice(-2000) }
}

try {
  // A port already answering is a peer's server, and this drive would grade it.
  let busy = false
  try { await fetch(`http://localhost:${API_PORT}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${API_PORT} already answers — an earlier run is still up. Stop it; this drive starts its own.`)
    process.exit(1)
  }

  copyApp()
  t('app.isACopyNotTheShared', existsSync(join(app, 'db', 'schema.lite')))

  // ─── the crash that rings ───────────────────────────────────────────────
  const first = await crashOnce()
  t('first.apiCameUp', first.up === true)
  t('first.exitedNonZero', typeof first.code === 'number' && first.code !== 0)
  t('first.oneRing', posts.length === 1)
  t('first.toTheTopic', posts[0]?.path === `/${TOPIC}` && posts[0]?.method === 'POST')
  t('first.critical', posts[0]?.priority === '5')
  t('first.titledForTheApp', /crashed on /.test(posts[0]?.title ?? ''))
  t('first.carriesTheError', (posts[0]?.body ?? '').startsWith('verify-crash: crashed on purpose'))
  t('first.openedTheWindow', existsSync(recordFile) && JSON.parse(readFileSync(recordFile, 'utf8')).since === 0)
  if (!first.up || posts.length !== 1) console.log(first.stderr)

  // ─── inside the window ──────────────────────────────────────────────────
  const second = await crashOnce()
  t('second.apiCameUp', second.up === true)
  t('second.exitedNonZero', typeof second.code === 'number' && second.code !== 0)
  t('second.noSecondRing', posts.length === 1)
  t('second.wasCounted', existsSync(recordFile) && JSON.parse(readFileSync(recordFile, 'utf8')).since === 1)
  if (!second.up) console.log(second.stderr)
} finally {
  stop()
  ntfy.stop(true)
  rmSync(scratch, { recursive: true, force: true })
}

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'app.isACopyNotTheShared': true,
  'first.apiCameUp':         true,
  'first.exitedNonZero':     true,
  'first.oneRing':           true,
  'first.toTheTopic':        true,
  'first.critical':          true,
  'first.titledForTheApp':   true,
  'first.carriesTheError':   true,
  'first.openedTheWindow':   true,
  'second.apiCameUp':        true,
  'second.exitedNonZero':    true,
  'second.noSecondRing':     true,
  'second.wasCounted':       true,
}

process.exit(report(got, expected))
