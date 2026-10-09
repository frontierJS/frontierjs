/*
 * run.mjs — mesa's benchmark: bytes, DOM work and time for a keyed table.
 *
 *   bun run bench                        everything, 10 interleaved runs
 *   bun run bench -- --runs 3            fewer runs
 *   bun run bench -- --only swap,shuffle operations whose name matches
 *   bun run bench -- --gate              bytes and DOM counts only — fast, and all a gate may read
 *   bun run bench -- --update            write gated numbers that went DOWN into baseline.json
 *   bun run bench -- --adopt             write every gated number, raises included
 *   bun run bench -- --serve             build, serve the fixtures, stay up
 *
 * Needs Chrome on PATH or `$FJS_CHROME`.
 *
 * ── Three kinds of number, and only two are committed ─────────────────
 *
 * GATED — identical on every machine, so `baseline.json` holds them and a
 * rise fails the run: gzip bytes of each built fixture, and the DOM mutations
 * each operation makes (MutationObserver records: nodes added, nodes removed,
 * text writes, attribute writes). `floor` is the smallest interactive
 * component, so its bytes are what every Mesa app pays before writing a line.
 * The baseline ratchets down only (root Invariant 14's shape): `--update`
 * cannot raise a number, and `--adopt` is the separate verb that can, so a
 * raise is a visible line in a diff.
 *
 * REPORTED — milliseconds, printed and never committed. A committed ms is a
 * statement about one laptop (`IDEAS/performance-regression-watch.md` § The
 * useful negative result). Every time is therefore also shown as a ratio to
 * `fixtures/vanilla/`, the same table written by hand and measured in the same
 * browser, interleaved run by run, and the ratio is the number to compare.
 *
 * RECORDED — heap after mount, after 1k rows, and after five create/clear
 * cycles. The last one should come back to the first; growth there is a leak.
 *
 * ── What a time here includes ──────────────────────────────────────────
 *
 * Script, style and layout: the click is dispatched in the page, Mesa's flush
 * is a microtask queued during it, and a forced layout read closes the
 * measurement. Paint is excluded. It costs the same for the same DOM, so it
 * would only dilute the ratio. After the measurement the page waits a frame
 * and reads the observer again, and any mutation that turns up then is a
 * failure: the measurement closed before Mesa finished.
 *
 * ── Why a fast result is also checked for being right ─────────────────
 *
 * After every operation both fixtures' tables are reduced to one signature
 * (id, label, selected, per row) and must match, and every row whose id
 * survived the operation must still be the SAME node. A keyed list that
 * rebuilds rows instead of moving them can finish sooner and still be wrong.
 * `../shared/data.js` is seeded so both checks can be exact.
 */
import { createServer }                                    from 'node:http'
import { readFile, readdir, writeFile, stat }              from 'node:fs/promises'
import { existsSync }                                      from 'node:fs'
import { join, extname, resolve }                          from 'node:path'
import { fileURLToPath }                                   from 'node:url'
import { gzipSync }                                        from 'node:zlib'
import { build }                                           from 'vite'
import mesa                                                from '../mesa-vite/index.js'
import { openChrome }                                      from '../src/drive.js'
import { green, red, dim }                                 from '../test/browser/drive.mjs'

const HERE     = fileURLToPath(new URL('.', import.meta.url))
const DIST     = join(HERE, 'dist')
const BASELINE = join(HERE, 'baseline.json')

const argv    = process.argv.slice(2)
const flag    = (f) => argv.includes(f)
const option  = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const gate    = flag('--gate')
const runs    = gate ? 1 : Number(option('--runs') ?? 10)
const only    = option('--only')?.split(',')

// ─── operations ──────────────────────────────────────────────────────────────
//
// [name, setup clicks, measured click, CPU throttle]. Each run is a fresh page
// load, warmed by three create/clear cycles so the measured click is not the
// first time the code runs. The throttles are this bench's own choice: the
// small operations finish in under a millisecond unthrottled, below what a
// ratio can resolve.

const ROW = (n, a) => `tbody > tr:nth-child(${n}) a.${a}`
const OPS = [
  ['create1k',      [],       '#run'],
  ['replace1k',     ['#run'], '#run'],
  ['update10th',    ['#run'], '#update',          4],
  ['select',        ['#run'], ROW(2, 'lbl'),      4],
  ['swap',          ['#run'], '#swaprows',        4],
  ['remove',        ['#run'], ROW(4, 'remove'),   2],
  ['create10k',     [],       '#runlots'],
  ['append1k',      ['#run'], '#add'],
  ['clear',         ['#run'], '#clear',           4],
  ['reverse',       ['#run'], '#reverse'],
  ['shuffle',       ['#run'], '#shuffle'],
  ['rotate',        ['#run'], '#rotate',          4],
  ['prepend100',    ['#run'], '#prepend100'],
  ['insertmid100',  ['#run'], '#insertmid100'],
  ['removefirst',   ['#run'], '#removefirst',     4],
  ['removeevery10', ['#run'], '#removeevery10'],
].filter(([name]) => !only || only.some((o) => name.includes(o)))

const WARMUP  = ['#run', '#clear', '#run', '#clear', '#run', '#clear']
const TABLES  = ['rows', 'vanilla']
const BUILT   = ['floor', 'rows', 'vanilla']

// ─── build + bytes ───────────────────────────────────────────────────────────

async function buildFixture(name) {
  await build({
    root:       join(HERE, 'fixtures', name),
    configFile: false,
    logLevel:   'warn',
    base:       './',
    plugins:    [mesa()],
    // Workspace source by relative path: a by-name import resolves to the copy
    // `bun install` made, and would measure a runtime that no longer exists.
    resolve:    { alias: { '@frontierjs/mesa/runtime.js': resolve(HERE, '../src/runtime.js') } },
    build:      { outDir: join(DIST, name), emptyOutDir: true, target: 'es2020', reportCompressedSize: false },
  })
}

async function files(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    e.isDirectory() ? out.push(...await files(p)) : out.push(p)
  }
  return out
}

async function bytesOf(name) {
  const sum = { js: 0, jsRaw: 0, css: 0 }
  for (const f of await files(join(DIST, name))) {
    const ext = extname(f)
    if (ext !== '.js' && ext !== '.css') continue
    const buf = await readFile(f)
    if (ext === '.js') { sum.js += gzipSync(buf, { level: 9 }).length; sum.jsRaw += buf.length }
    else sum.css += gzipSync(buf, { level: 9 }).length
  }
  return sum
}

// ─── static server ───────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

function serve() {
  const server = createServer(async (req, res) => {
    const path = resolve(DIST, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname))
    const file = (await stat(path).catch(() => null))?.isDirectory() ? join(path, 'index.html') : path
    if (!file.startsWith(DIST + '/') || !existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Cross-origin isolation is what buys a fine clock: without it Chrome
      // rounds performance.now() to 100µs, and the floor's small operations
      // finish inside one tick, so their ratios are quotients of noise.
      'cross-origin-opener-policy':   'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    res.end(await readFile(file))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })))
}

// ─── the in-page probe ───────────────────────────────────────────────────────
//
// Installed before any page script, so the observer is watching before the
// first row exists.

const PROBE = `(() => {
  // The callback keeps what it is handed: records are DELIVERED at the next
  // microtask checkpoint, and a delivered record is gone from takeRecords().
  let seen = []
  const obs = new MutationObserver((recs) => { seen.push(...recs) })
  obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
  const drain = () => { const out = seen.concat(obs.takeRecords()); seen = []; return out }
  const count = (recs) => {
    const c = { added: 0, removed: 0, text: 0, attrs: 0 }
    for (const r of recs) {
      if (r.type === 'childList') { c.added += r.addedNodes.length; c.removed += r.removedNodes.length }
      else if (r.type === 'characterData') c.text++
      else c.attrs++
    }
    c.total = c.added + c.removed + c.text + c.attrs
    return c
  }
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  const find  = (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('bench: no element for ' + sel); return el }
  const table = () => [...document.querySelectorAll('tbody > tr')]
  const signature = () => {
    let h = 2166136261
    const rows = table()
    for (const tr of rows) {
      const s = tr.children[0].textContent + '|' + tr.children[1].textContent.trim() + '|' + tr.classList.contains('danger') + ';'
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    }
    return rows.length + ':' + (h >>> 0).toString(16)
  }
  window.__bench = {
    async step(sel) { find(sel).click(); await frame(); drain() },
    async measure(sel) {
      const el     = find(sel)
      const before = new Map(table().map((tr) => [tr.getAttribute('data-id'), tr]))
      await frame()
      drain()
      const t0 = performance.now()
      el.click()
      await Promise.resolve()
      document.body.offsetHeight
      const ms  = performance.now() - t0
      const dom = count(drain())
      await frame()
      const late = count(drain()).total
      let recreated = 0
      for (const tr of table()) {
        const was = before.get(tr.getAttribute('data-id'))
        if (was && was !== tr) recreated++
      }
      return { ms, dom, late, recreated, sig: signature(), isolated: self.crossOriginIsolated }
    },
  }
})()`

// ─── measuring ───────────────────────────────────────────────────────────────

async function load(page, origin, fixture) {
  await page.navigate(`${origin}/${fixture}/`, 'window.__bench && document.querySelector("#run")')
}

async function sample(page, origin, fixture, [, setup, action, throttle = 1]) {
  await load(page, origin, fixture)
  for (const s of [...WARMUP, ...setup]) await page.evaluate(`return await window.__bench.step(${JSON.stringify(s)});`)
  await page.cmd('Emulation.setCPUThrottlingRate', { rate: throttle })
  try {
    return await page.evaluate(`return await window.__bench.measure(${JSON.stringify(action)});`)
  } finally {
    await page.cmd('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
}

async function heap(page) {
  await page.cmd('HeapProfiler.collectGarbage')
  return (await page.cmd('Runtime.getHeapUsage')).usedSize
}

async function memory(page, origin, fixture) {
  await load(page, origin, fixture)
  const idle = await heap(page)
  await page.evaluate(`return await window.__bench.step('#run');`)
  const rows = await heap(page)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(`return await window.__bench.step('#run');`)
    await page.evaluate(`return await window.__bench.step('#clear');`)
  }
  return { idle, rows: rows - idle, cycled: (await heap(page)) - idle }
}

// ─── report ──────────────────────────────────────────────────────────────────

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const ms     = (x) => x.toFixed(2).padStart(8)
const kb     = (x) => (x / 1024).toFixed(1).padStart(7) + ' KB'
const pad    = (s, n) => String(s).padEnd(n)
const lpad   = (s, n) => String(s).padStart(n)
const domStr = (d) => `${d.total} ${dim(`(+${d.added} −${d.removed} t${d.text} a${d.attrs})`)}`

// ─── main ────────────────────────────────────────────────────────────────────

for (const name of BUILT) await buildFixture(name)
const server = await serve()

if (flag('--serve')) {
  for (const name of BUILT) console.log(`${pad(name, 8)} ${server.origin}/${name}/`)
  console.log(dim('ctrl-c to stop'))
} else {
  const failures = []
  const bytes    = {}
  for (const name of BUILT) bytes[name] = await bytesOf(name)

  const page = await openChrome({ bootstrap: PROBE })
  const results = {}   // op → fixture → [samples]
  const heaps   = {}
  try {
    for (const op of OPS) {
      results[op[0]] = { rows: [], vanilla: [] }
      process.stdout.write(dim(`  ${op[0]} `))
      for (let i = 0; i < runs; i++) {
        for (const fixture of TABLES) results[op[0]][fixture].push(await sample(page, server.origin, fixture, op))
        process.stdout.write(dim('.'))
      }
      process.stdout.write('\r\x1b[K')
    }
    if (!gate) for (const f of TABLES) heaps[f] = await memory(page, server.origin, f)
    if (page.errors.length) failures.push(...page.errors.map((e) => `page: ${e}`))
  } finally {
    await page.close()
    server.close()
  }

  // ── correctness, before any number is believed ──
  const dom = {}
  for (const [op, by] of Object.entries(results)) {
    const m = by.rows, v = by.vanilla
    if (m[0].sig !== v[0].sig) failures.push(`${op}: the Mesa table differs from the floor's (${m[0].sig} vs ${v[0].sig})`)
    for (const s of [...m, ...v]) if (s.late) failures.push(`${op}: ${s.late} mutation(s) landed after the measurement closed`)
    if (m.some((s) => s.recreated)) failures.push(`${op}: Mesa rebuilt ${m[0].recreated} keyed row(s) instead of keeping them`)
    if ([...m, ...v].some((s) => !s.isolated)) failures.push(`${op}: the page was not cross-origin isolated, so its clock is rounded to 100µs`)
    if (new Set(m.map((s) => s.dom.total)).size > 1) failures.push(`${op}: DOM mutation count differs between runs — the workload is not deterministic`)
    dom[op] = m[0].dom.total
  }

  // ── print ──
  console.log(`\n${'bytes (gzip)'.padEnd(16)}${'js'.padStart(11)}${'css'.padStart(11)}${'js raw'.padStart(11)}`)
  for (const name of BUILT) console.log(`  ${pad(name, 14)}${kb(bytes[name].js)}${kb(bytes[name].css)}${kb(bytes[name].jsRaw)}`)

  console.log(`\n${pad('operation', 16)}${gate ? '' : `${lpad('mesa ms', 9)}${lpad('floor ms', 9)}${lpad('ratio', 8)}   `}${pad('mesa DOM ops', 34)}floor`)
  const ratios = []
  for (const [op, by] of Object.entries(results)) {
    const m = median(by.rows.map((s) => s.ms)), v = median(by.vanilla.map((s) => s.ms))
    const ratio = m / v
    ratios.push(ratio)
    const timing = gate ? '' : `${ms(m)} ${ms(v)}${lpad(ratio.toFixed(2) + '×', 8)}   `
    console.log(`  ${pad(op, 14)}${timing}${pad(domStr(by.rows[0].dom), 34 + 9)}${by.vanilla[0].dom.total}`)
  }
  if (!gate) {
    const geo = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length)
    console.log(`  ${pad('geomean', 14)}${' '.repeat(18)}${lpad(geo.toFixed(2) + '×', 8)}   ${dim(`median of ${runs}, script + style + layout, no paint`)}`)
    console.log(`\n${pad('heap', 16)}${lpad('idle', 10)}${lpad('+1k rows', 11)}${lpad('5 cycles', 11)}`)
    for (const f of TABLES) console.log(`  ${pad(f, 14)}${kb(heaps[f].idle)}${kb(heaps[f].rows)}${kb(heaps[f].cycled)}`)
  }

  // ── the ratchet ──
  const current  = { bytes: Object.fromEntries(['floor', 'rows'].map((n) => [n, bytes[n].js])), dom }
  const baseline = existsSync(BASELINE) ? JSON.parse(await readFile(BASELINE, 'utf8')) : null
  const rises = [], falls = []
  if (baseline) {
    for (const kind of ['bytes', 'dom']) for (const [k, now] of Object.entries(current[kind])) {
      const was = baseline[kind]?.[k]
      if (was === undefined) continue
      if (now > was) rises.push(`${kind}.${k} ${was} → ${now}`)
      if (now < was) falls.push(`${kind}.${k} ${was} → ${now}`)
    }
  }
  const partial = !!only
  const write = async (next) => {
    await writeFile(BASELINE, JSON.stringify({
      '//': 'Written by `bun run bench -- --update` (improvements only) or `--adopt` (raises too). gzip bytes of each built fixture, and DOM mutations per operation in the Mesa fixture. See bench/run.mjs.',
      ...next,
    }, null, 2) + '\n')
  }
  const merged = (take) => {
    const out = { bytes: { ...baseline?.bytes }, dom: { ...baseline?.dom } }
    for (const kind of ['bytes', 'dom']) for (const [k, now] of Object.entries(current[kind]))
      if (take(baseline?.[kind]?.[k], now)) out[kind][k] = now
    return out
  }

  console.log('')
  if (!baseline || flag('--adopt')) {
    if (failures.length) console.log(red('baseline not written: the run failed its checks'))
    else { await write(merged(() => true)); console.log(green(`baseline ${baseline ? 'adopted' : 'written'} — ${BASELINE.replace(HERE, 'bench/')}`)) }
  } else {
    for (const r of rises) console.log(red(`  raised   ${r}`))
    for (const f of falls) console.log(green(`  lowered  ${f}`))
    if (flag('--update') && falls.length && !failures.length) { await write(merged((was, now) => was === undefined || now < was)); console.log(green('baseline updated with the improvements')) }
    else if (falls.length) console.log(dim('  `--update` writes the improvements back'))
    if (rises.length) failures.push(`${rises.length} gated number(s) rose — fix it, or \`--adopt\` with the reason in the commit message`)
  }
  if (partial) console.log(dim('--only: the DOM baseline covered only the operations run'))

  for (const f of failures) console.log(red(`  ✗ ${f}`))
  process.exit(failures.length ? 1 : 0)
}
