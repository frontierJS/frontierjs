// tests/browser/verify-devtools.mjs
//
// The devtools console in a real browser, driven over CDP.
//
// Everything else about this surface is asserted against JSON — which is the
// half that cannot see the failure it actually has. `admin.html` is a
// hand-written page with no build step and no framework: a typo in a selector,
// a renderer that throws on a shape the server legitimately answers, a tab that
// never wires its click, are all invisible to a test that fetches `/api/jobs`
// and reads the body. The panel exists to be LOOKED at, so it is opened.
//
// It also opens the console on its DEFAULT port, which is the only thing that
// checks the number three packages restate by hand (junction's plugin, sierra's
// toolbar, the CLI's port table).
//
// Boots a real app with a real Caravan queue on its own SQLite file, fails a
// job on purpose, and drives the page: tab switch, queue cards, the job row,
// retry, run-now, and the readiness section under Metrics.
//
// Run:  node tests/browser/verify-devtools.mjs        (needs Chrome, and bun)

import { openChrome, green, red, dim } from '../../../mesa/test/browser/drive.mjs'
import { spawn }                        from 'node:child_process'
import { mkdtempSync, writeFileSync }   from 'node:fs'
import { tmpdir }                       from 'node:os'
import { join }                         from 'node:path'
import net                              from 'node:net'

const APP_PORT = 3961
const DV_PORT  = 8503   // the default; see packages/cli/core/ports.js
const dir      = mkdtempSync(join(tmpdir(), 'fjs-devtools-'))
const here     = new URL('.', import.meta.url).pathname

// The app is a separate process on purpose: devtools binds its own Bun server,
// and a drive that imported it would hold the port for the life of the runner.
const APP = `
import { createApp, createService, healthPlugin, devtools, defaultConfig } from '${join(here, '../../index.ts')}'
import { createCaravan, defineJob } from '${join(here, '../../../caravan/src/index.ts')}'

// Fails its first attempt and succeeds on the next, so a retry driven from the
// panel has an observable outcome. A handler that always throws re-fails inside
// one poll interval and the button looks like it did nothing.
let runs = 0
const boom  = defineJob('flaky-job', async () => {
  if (runs++ === 0) throw new Error('handler exploded')
  return 1
}, { maxAttempts: 1, timeout: 5000 })
const sweep = defineJob('nightly-sweep', async () => 1, { cron: '0 3 * * *' })

const app = createApp({ config: { port: ${APP_PORT}, database: { url: '', log: false },
  services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 200 } } })

const queue = createCaravan({ db: '${join(dir, 'jobs.db')}', pollInterval: 50 })
queue.handle(boom); queue.handle(sweep)
app.configure(queue)
app.configure(healthPlugin())
app.configure(devtools())   // no port: 8503 is the assigned slot
app.services.register(createService({ name: 'things', async find() { return [] } }))
await app.start()
await queue.dispatch(boom, { orderId: 'ord_42' })
console.log('READY')
`
const appFile = join(dir, 'app.ts')
writeFileSync(appFile, APP)

// Refuse a port that already answers. A leftover console from an earlier run
// holds 8503 and serves that run's data, so this drive asserted against a
// previous queue and reported half its checks red with nothing naming the cause
// (`FJS-420`). The repo's own rule about `strictPort`, applied to a drive.
for (const [p, what] of [[DV_PORT, 'the devtools console'], [APP_PORT, 'the test app']]) {
  const answering = await new Promise((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(300)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('timeout', () => { sock.destroy(); resolve(false) })
    sock.once('error',   () => resolve(false))
    sock.connect(p, '127.0.0.1')
  })
  if (answering) {
    console.error(`Port ${p} is already answering — ${what} would be a previous run's, ` +
                  `and every assertion below would grade that instead.\n` +
                  `  fuser -k ${p}/tcp`)
    process.exit(2)
  }
}

const proc = spawn('bun', ['run', appFile], { stdio: ['ignore', 'pipe', 'pipe'] })
proc.on('error', (e) => { console.error(`Could not start the app: ${e.message}`); process.exit(2) })

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the app never said READY')), 20000)
  proc.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(timer); resolve() } })
  proc.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d))
}).catch((e) => { console.error(e.message); proc.kill(); process.exit(2) })

// The failing job needs to have been picked up and given up on before the page
// is asked what the queue looks like.
await new Promise(r => setTimeout(r, 900))

const browser = await openChrome()
const rows    = []
const ok      = (name, v, detail = '') => rows.push({ name, ok: !!v, detail })

/** Poll the page until `expr` is truthy — a click renders on the next fetch. */
async function until(expr, ms = 4000) {
  const t = Date.now()
  for (;;) {
    const v = await browser.evaluate(`return ${expr}`)
    if (v) return v
    if (Date.now() - t > ms) return v
    await new Promise(r => setTimeout(r, 100))
  }
}

try {
  await browser.navigate(`http://localhost:${DV_PORT}`)

  // The page is served by the socket's own server, so a cached copy loads fine
  // while the server is down and the only symptom is a `disconnected` badge —
  // which reads as a broken console rather than an app that is not running.
  const cacheHeader = await fetch(`http://localhost:${DV_PORT}/`)
    .then(r => r.headers.get('cache-control')).catch(() => null)
  ok('the console page is never cached', cacheHeader === 'no-store', String(cacheHeader))

  ok('the console boots', await until(`!!document.getElementById('app')`))
  ok('the socket connects', await until(`document.getElementById('ws')?.className === 'wsbadge live'`))
  ok('there is a Jobs tab', await until(`!!document.querySelector('[data-t="jobs"]')`))

  await browser.evaluate(`document.querySelector('[data-t="jobs"]').click(); return true`)
  ok('the Jobs panel opens',
     await until(`document.getElementById('panel-jobs').classList.contains('on')`))

  // The queue card, not the JSON behind it.
  ok('a queue card is drawn with its counts',
     await until(`document.querySelector('#jstats .jqc .qn')?.textContent === 'default'`))
  ok('the failed count is on screen',
     await until(`/failed\\s*1/.test(document.querySelector('#jstats .jqc .qr').textContent)`))

  // A schedule that stops being registered is nothing happening — the whole
  // reason the declaration is rendered next to the live clock.
  ok('the cron handler is listed with its expression',
     await until(`[...document.querySelectorAll('.jschi')].some(e => e.textContent.includes('nightly-sweep') && e.textContent.includes('0 3 * * *'))`))
  ok('its next fire is shown',
     await until(`[...document.querySelectorAll('.jschi')].some(e => /next \\d/.test(e.textContent))`))

  // The row.
  ok('the failed job is a row', await until(`document.querySelectorAll('#jtb tr').length >= 1`))
  ok('the row carries the error text',
     await until(`document.querySelector('#jtb tr').textContent.includes('handler exploded')`))
  ok('the row is marked as an error',
     await until(`document.querySelector('#jtb tr').classList.contains('er')`))
  ok('the status badge says failed',
     await until(`document.querySelector('#jtb .jst.failed')?.textContent === 'failed'`))

  // Expanding shows the payload — the thing no counter can answer.
  await browser.evaluate(`document.querySelector('#jtb tr td:nth-child(2)').click(); return true`)
  ok('expanding shows the payload',
     await until(`document.querySelector('#jtb .xrow')?.textContent.includes('ord_42')`))

  // Retry, driven from the button rather than the endpoint.
  // Retry, driven from the button rather than the endpoint. The handler
  // succeeds on its second attempt, so this asserts the job actually RAN
  // again — a re-queue that stalls would sit at pending and pass a weaker check.
  await browser.evaluate(`document.querySelector('#jtb button[data-act="retry"]').click(); return true`)
  ok('retry re-runs the job through to done',
     await until(`[...document.querySelectorAll('#jtb tr')].some(r => r.textContent.includes('flaky-job') && r.querySelector('.jst.done'))`, 6000))

  // Run-now: the picker is filled from the registrations, so a name cannot be
  // typed into a dispatch no worker will ever pick up.
  ok('the run picker lists the registered handlers',
     await until(`document.querySelectorAll('#jrn option').length === 3`))
  await browser.evaluate(`
    const s = document.getElementById('jrn'); s.value = 'nightly-sweep'
    document.getElementById('jrb').click(); return true`)
  ok('running a job by hand puts it in the list',
     await until(`[...document.querySelectorAll('#jtb tr')].some(r => r.textContent.includes('nightly-sweep'))`))

  // Status filter.
  await browser.evaluate(`[...document.querySelectorAll('#jfps .fp')].find(p => p.dataset.s === 'done').click(); return true`)
  ok('the done filter shows only done jobs',
     await until(`[...document.querySelectorAll('#jtb .jst')].every(b => b.textContent === 'done')`))

  // Readiness, under Metrics — the section that had no source until now.
  await browser.evaluate(`document.querySelector('[data-t="metrics"]').click(); return true`)
  ok('the health section names the queue check',
     await until(`[...document.querySelectorAll('.hcheck .hn')].some(e => e.textContent === 'jobs')`))
  ok('the queue reports ok',
     await until(`document.querySelector('.hcheck')?.textContent.includes('ok')`))

  // The regression this whole change came from: a plugin section reaching the
  // console at all.
  ok('the plugin metrics section is rendered',
     await until(`[...document.querySelectorAll('.msec')].some(e => e.textContent.trim() === 'JOBS')`))

  // ── Real traffic ────────────────────────────────────────────────────────
  //
  // Everything above drives the console's own REST API, which is why this drive
  // passed while the socket was broken: the app itself was never called, so the
  // only frame the page ever received was the `state` snapshot on connect.
  //
  // A single service call emits `request`, `call_start` and `hook`. The page
  // handles the first and used to compile the other two as JavaScript — the
  // fallback for an unknown frame type was the `Function` CONSTRUCTOR, so every
  // one threw `missing ] after element list` in a browser doing real work
  // (`FJS-420`). Nothing here can see that without generating the frames.
  await fetch(`http://localhost:${APP_PORT}/things`).catch(() => {})
  await fetch(`http://localhost:${APP_PORT}/things`).catch(() => {})

  ok('a service call reaches the live feed',
     await until(`document.querySelectorAll('#tb tr').length >= 2`))
  ok('the feed names the service and method',
     await until(`document.querySelector('#tb tr')?.textContent.includes('things')`))

  // The assertion the fallback bug would have failed. Kept separate from the
  // page-error sweep below so a regression names the socket rather than "the
  // page reported something".
  ok('no frame was compiled as source',
     !browser.errors.some(e => /missing \]|Function|Unexpected token/.test(e)),
     browser.errors.join(' | '))

  const pageErrors = browser.errors.filter(e => !/favicon|fonts\.googleapis/.test(e))
  ok('the page reported no errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
  proc.kill()
}

let failed = 0
for (const r of rows) {
  console.log(r.ok ? `${green('✓')} ${r.name}` : `${red('✗')} ${r.name} ${dim(r.detail)}`)
  if (!r.ok) failed++
}
console.log(`\n${rows.length - failed}/${rows.length} passed`)
process.exit(failed ? 1 : 0)
