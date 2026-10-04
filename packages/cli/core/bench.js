// core/bench.js — what a built app costs: bytes on the wire, bytes on disk, and
// what the process holds once it is up.
//
// Two kinds of number live here and they are never mixed. A BYTE is the same on
// every machine for the same build, so it is gated: `bench.baseline.json`
// ratchets down only (Invariant 14's mechanism). A BOOT figure (cold start, RSS)
// is a statement about one machine on one afternoon, so it is reported and never
// fails anything — a timing red on a shared runner trains everyone to skip the
// check (IDEAS/performance-regression-watch.md § What a performance claim is).
//
// Nothing here builds. It reads what is on disk, because a bench that rebuilt
// would answer for the tree it just built rather than the one the person has.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { brotliCompressSync, constants as zc } from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, extname, resolve } from 'node:path'
import { chalk } from './color.js'

export const BASELINE_FILE = 'bench.baseline.json'

// A built surface and its output directory. Extension, desktop and cli builds
// land elsewhere and ship as a package, not as a page a visitor downloads.
export const BUILT_SURFACES = ['web', 'site']

const brotli = (buf) => brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length

/** Every regular file under `dir`, symlinks not followed. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (st.isFile()) out.push({ path: p, bytes: st.size })
  }
  return out
}

/** Total bytes of every file under `dir`; null when it does not exist. */
export function dirBytes(dir) {
  if (!existsSync(dir)) return null
  return walk(dir).reduce((n, f) => n + f.bytes, 0)
}

/** The local files `index.html` asks for before first paint, in order. A remote
 *  URL is not ours to count and a `data:` URI is already inside the HTML. */
export function firstLoadRefs(html) {
  const refs = []
  const tag = /<(script|link)\b([^>]*)>/gi
  let m
  while ((m = tag.exec(html))) {
    const attrs = m[2]
    const attr = (name) => attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
    const rel = attr('rel')
    const ref = m[1].toLowerCase() === 'script' ? attr('src') : attr('href')
    if (!ref || /^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) continue
    if (m[1].toLowerCase() === 'link' && !['stylesheet', 'modulepreload'].includes(rel)) continue
    refs.push(ref.split(/[?#]/)[0])
  }
  return [...new Set(refs)]
}

/** The bytes a built surface puts on the wire. `dist` is the build directory. */
export function measureSurface(dist) {
  if (!existsSync(dist)) return null
  const files = walk(dist)
  const kinds = { js: [0, 0], css: [0, 0], html: [0, 0], other: [0, 0] }
  let largest = { file: null, brotli: 0 }
  const compressed = new Map()
  for (const f of files) {
    const ext = extname(f.path).slice(1)
    const kind = ['js', 'mjs'].includes(ext) ? 'js' : kinds[ext] ? ext : 'other'
    const body = readFileSync(f.path)
    // Already-compressed media gains nothing from brotli and costs seconds.
    const z = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'woff2', 'mp4', 'webm', 'zip'].includes(ext) ? f.bytes : brotli(body)
    compressed.set(f.path, z)
    kinds[kind][0] += f.bytes
    kinds[kind][1] += z
    if (kind === 'js' && z > largest.brotli) largest = { file: relative(dist, f.path), brotli: z }
  }

  // An SPA build writes dist/client/ (the server half is not shipped to a browser),
  // a static build writes dist/ itself; the page is wherever index.html is.
  const pageRoot = existsSync(join(dist, 'index.html')) ? dist : join(dist, 'client')
  const index = join(pageRoot, 'index.html')
  let first = null
  if (existsSync(index)) {
    const refs = firstLoadRefs(readFileSync(index, 'utf8'))
    const sizes = refs.map(ref => {
      const p = resolve(pageRoot, ref.replace(/^\//, ''))
      return { ref, ext: extname(p).slice(1), brotli: compressed.get(p) ?? null }
    })
    const sum = (ext) => sizes.filter(s => s.ext === ext && s.brotli != null).reduce((n, s) => n + s.brotli, 0)
    first = {
      requests: 1 + refs.length,
      jsBrotli: sum('js') + sum('mjs'),
      cssBrotli: sum('css'),
      htmlBrotli: compressed.get(index),
      // A ref the build names and the disk lacks is a broken build, and a
      // bench that skipped it would report a smaller number than a visitor pays.
      missing: sizes.filter(s => s.brotli == null).map(s => s.ref),
    }
  }

  return {
    files: files.length,
    rawBytes: files.reduce((n, f) => n + f.bytes, 0),
    brotliBytes: [...compressed.values()].reduce((n, z) => n + z, 0),
    js: { raw: kinds.js[0], brotli: kinds.js[1] },
    css: { raw: kinds.css[0], brotli: kinds.css[1] },
    html: { raw: kinds.html[0], brotli: kinds.html[1] },
    largestJs: largest,
    firstLoad: first,
  }
}

/** Disk an operator provisions for: what is installed and what is stored. */
export function measureDisk(root) {
  const dbDir = join(root, 'db')
  const dbs = existsSync(dbDir)
    ? readdirSync(dbDir).filter(n => /\.db$/.test(n)).map(n => ({ file: n, bytes: lstatSync(join(dbDir, n)).size }))
    : []
  return {
    nodeModules: dirBytes(join(root, 'node_modules')),
    databases: dbs,
    databaseBytes: dbs.reduce((n, d) => n + d.bytes, 0),
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const answers = async (url) => { try { return (await fetch(url)).ok } catch { return false } }

/** RSS in bytes of `pid` and every descendant — a command is a LAUNCHER, and the
 *  pid it hands back is the wrapper holding almost nothing. Linux's /proc only;
 *  null elsewhere, which prints as not measured rather than as 0. */
export function treeRss(pid) {
  if (!existsSync('/proc/self/status')) return null
  const kids = new Map()
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(Number(n))
    } catch {}
  }
  let total = 0
  const stack = [pid]
  while (stack.length) {
    const p = stack.pop()
    try {
      const kb = readFileSync(`/proc/${p}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m)?.[1]
      if (kb) total += Number(kb) * 1024
    } catch {}
    stack.push(...(kids.get(p) ?? []))
  }
  return total
}

/** Start `cmd` in `cwd`, wait for `url` to answer, let it settle, read its RSS,
 *  kill it. Refuses a url that already answers: a port that responds is not
 *  evidence the right process holds it (FJS-740), and the figure would belong to
 *  whatever else is serving. */
export async function measureBoot({ cmd, cwd, url, settleMs = 3000, timeoutMs = 60_000, env = {}, whileUp = null }) {
  if (await answers(url)) throw new Error(`${url} already answers — stop what holds it, a bench of someone else's process measures nothing`)
  const started = performance.now()
  const child = spawn(cmd, { cwd, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...env } })
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
  try {
    let up = false
    while (!up && performance.now() - started < timeoutMs) {
      if (child.exitCode != null) throw new Error(`\`${cmd}\` exited ${child.exitCode} before ${url} answered`)
      up = await answers(url)
      if (!up) await sleep(100)
    }
    if (!up) throw new Error(`${url} never answered within ${timeoutMs}ms`)
    const coldStartMs = Math.round(performance.now() - started)
    const rssAtReady = treeRss(child.pid)
    await sleep(settleMs)
    const rssIdle = treeRss(child.pid)
    // Load runs against THIS process, after the idle read so the idle figure is
    // not the load's, and RSS is read again after it: memory that only grows
    // under traffic is the earliest sign of a leak.
    const during = whileUp ? await whileUp(url) : null
    return { coldStartMs, rssAtReady, rssIdle, rssAfterLoad: whileUp ? treeRss(child.pid) : null, settleMs, during }
  } finally {
    stop()
  }
}

// ─── database growth ─────────────────────────────────────────────────────────

/** Bytes of a fresh database holding `counts[i]` rows of one model, written
 *  through the app's own Litestone client so indexes and column defaults are the
 *  ones the schema declares. Runs a child in `appRoot` against a throwaway file
 *  (DATABASE_URL), never the app's real db/. `row(i)` must be deterministic --
 *  a random value moves b-tree splits, and a gated number that moves between
 *  runs is a number nobody trusts. The WAL is checkpointed into the file before
 *  each read: counting the file alone understates, and counting file plus WAL
 *  measures however many frames had not yet been folded back.
 *  Returns { [count]: bytes }. */
export function measureDbGrowth({ appRoot, accessor, counts, row, timeoutMs = 300_000 }) {
  const dir  = mkdtempSync(join(tmpdir(), 'fjs-bench-db-'))
  const file = join(dir, 'bench.db')
  const script = `
    const { db } = await import(${JSON.stringify(join(appRoot, 'api/src/core/db.ts'))})
    const sys = db.asSystem()
    const row = ${row.toString()}
    const counts = ${JSON.stringify([...counts].sort((a, b) => a - b))}
    const sizes = {}
    let n = 0
    const { statSync } = await import('node:fs')
    const bytes = async () => {
      await sys.sql\`PRAGMA wal_checkpoint(TRUNCATE)\`
      return statSync(${JSON.stringify(file)}).size
    }
    for (const c of counts) {
      while (n < c) { n++; await sys.${accessor}.create({ data: row(n) }) }
      sizes[c] = await bytes()
    }
    console.log('BENCH_DB ' + JSON.stringify(sizes))
  `
  try {
    const r = spawnSync('bun', ['-e', script], {
      cwd: appRoot, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, DATABASE_URL: file },
    })
    const line = (r.stdout ?? '').split('\n').find(l => l.startsWith('BENCH_DB '))
    if (!line) throw new Error(`db growth measured nothing (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-600)}`)
    return JSON.parse(line.slice('BENCH_DB '.length))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── the gated half ──────────────────────────────────────────────────────────

/** The numbers a baseline may hold, flattened to `surface.metric` keys. Only a
 *  quantity that is the same on every machine for the same build belongs here. */
export function gatedMetrics(surfaces) {
  const out = {}
  for (const [name, s] of Object.entries(surfaces)) {
    if (!s) continue
    out[`${name}.totalBrotli`] = s.brotliBytes
    out[`${name}.files`] = s.files
    if (s.firstLoad) {
      out[`${name}.firstLoadJsBrotli`] = s.firstLoad.jsBrotli
      out[`${name}.firstLoadCssBrotli`] = s.firstLoad.cssBrotli
      out[`${name}.firstLoadRequests`] = s.firstLoad.requests
    }
  }
  return out
}

export function readBaseline(root) {
  const file = join(root, BASELINE_FILE)
  if (!existsSync(file)) return {}
  const { metrics } = JSON.parse(readFileSync(file, 'utf8'))
  return metrics ?? {}
}

export function writeBaseline(root, metrics) {
  const sorted = Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(join(root, BASELINE_FILE), JSON.stringify({
    '//': 'Ratchets DOWN only. `fli test:bench --update` writes an improvement back and cannot raise a number; `--adopt` is the verb that can, so a raise is a visible line in a diff.',
    metrics: sorted,
  }, null, 2) + '\n')
}

/** Judge `current` against `baseline`. A metric with no baseline is `unbaselined`,
 *  never a failure: nothing was promised about it. `next` is what `--update`
 *  writes (improvements and new keys, never a raise); `adopted` is what `--adopt`
 *  writes (everything measured). A baselined metric the run did not measure is
 *  `unmeasured` and keeps its number — nothing moved and nothing was measured
 *  are different sentences. */
export function ratchet(current, baseline) {
  const regressions = [], improvements = [], unbaselined = [], unmeasured = []
  const next = { ...baseline }
  for (const [k, v] of Object.entries(current)) {
    if (!(k in baseline)) { unbaselined.push({ key: k, value: v }); next[k] = v; continue }
    if (v > baseline[k]) regressions.push({ key: k, was: baseline[k], now: v })
    else if (v < baseline[k]) { improvements.push({ key: k, was: baseline[k], now: v }); next[k] = v }
  }
  for (const k of Object.keys(baseline)) if (!(k in current)) unmeasured.push(k)
  return { regressions, improvements, unbaselined, unmeasured, next, adopted: { ...baseline, ...current } }
}

// ─── the printed half ────────────────────────────────────────────────────────

export const kb = (n) => n == null ? 'n/a' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} kB`

/** Sections, each a small aligned table, color only on a terminal (color.js
 *  honors NO_COLOR and pipes). `db` is { [rows]: bytes } from measureDbGrowth;
 *  `bootError` is a failed boot's reason, shown rather than read as n/a. */
export function formatBench({ surfaces, disk, boot, verdict, db = null, bootError = null }) {
  const ms = (n) => n == null ? 'n/a' : `${n.toFixed(1)} ms`
  const head = (title, note = '') => `\n${chalk.bold(title)}${note ? '  ' + chalk.dim(note) : ''}`
  const table = (rows) => {
    const widths = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)))
    return rows.map(r => '  ' + r.map((cell, c) => c === 0 ? String(cell).padEnd(widths[c]) : String(cell).padStart(widths[c])).join('   ')).join('\n')
  }
  const out = []

  out.push(head('Download', 'brotli, gated — a rise fails'))
  const built = Object.entries(surfaces).filter(([, s]) => s)
  for (const [name, s] of Object.entries(surfaces)) {
    if (!s) out.push(`  ${name}/  ${chalk.yellow('not built')} — no dist/ (build it, then re-run)`)
  }
  if (built.length) {
    out.push(table([
      ['', 'files', 'raw', 'brotli', 'js', 'css', 'largest js'],
      ...built.map(([name, s]) => [`${name}/`, s.files, kb(s.rawBytes), kb(s.brotliBytes), kb(s.js.brotli), kb(s.css.brotli), kb(s.largestJs.brotli)]),
    ]))
    out.push(head('First load', 'what index.html makes a visitor fetch'))
    out.push(table([
      ['', 'requests', 'js', 'css'],
      ...built.map(([name, s]) => s.firstLoad
        ? [`${name}/`, s.firstLoad.requests, kb(s.firstLoad.jsBrotli), kb(s.firstLoad.cssBrotli)]
        : [`${name}/`, 'no index.html', '', '']),
    ]))
    for (const [name, s] of built) if (s.firstLoad?.missing.length) out.push(`  ${chalk.red('MISSING from dist')} (${name}): ${s.firstLoad.missing.join(', ')}`)
  }

  out.push(head('Disk', 'printed, not gated'))
  out.push(table([['node_modules', kb(disk.nodeModules)], ['databases', `${kb(disk.databaseBytes)} (${disk.databases.length})`]]))
  if (db) {
    out.push(head('Database size', 'bytes after a WAL checkpoint, gated'))
    out.push(table([['rows', ...Object.keys(db)], ['size', ...Object.values(db).map(kb)]]))
  }

  out.push(head('Memory and boot', 'reported, never gated'))
  if (boot) {
    out.push(table([
      ['cold start', `${boot.coldStartMs} ms`],
      ['RSS at ready', kb(boot.rssAtReady)],
      [`RSS idle (${boot.settleMs} ms)`, kb(boot.rssIdle)],
      ...(boot.rssAfterLoad != null ? [['RSS after load', kb(boot.rssAfterLoad)]] : []),
    ]))
    if (boot.during?.length) {
      out.push(head('Latency', 'p50 / p95 / p99 / max, constant arrival rate, reported'))
      const ok = boot.during.filter(c => !c.error)
      if (ok.length) out.push(table([
        ['case', 'p50', 'p95', 'p99', 'max', 'samples'],
        ...ok.map(c => [c.name, ms(c.p50), ms(c.p95), ms(c.p99), ms(c.max), `${c.n} @ ${c.rate}/s`]),
      ]))
      for (const c of boot.during.filter(c => c.error)) out.push(`  ${chalk.red('FAILED')} ${c.name} — ${c.error}`)
    }
  } else if (bootError) out.push(`  ${chalk.red('boot FAILED')} — ${bootError}`)
  else out.push(chalk.dim('  not measured — pass --boot "<command>" --url <health url>'))

  if (verdict) {
    out.push(head('Verdict'))
    const lines = []
    for (const r of verdict.regressions) lines.push(`  ${chalk.red('REGRESSION')}  ${r.key}  ${r.was} → ${r.now}  (+${r.now - r.was})`)
    for (const r of verdict.improvements) lines.push(`  ${chalk.green('improved')}    ${r.key}  ${r.was} → ${r.now}`)
    if (verdict.unbaselined.length) lines.push(`  ${chalk.yellow('unbaselined')} ${verdict.unbaselined.length} metric(s) — --update records them`)
    if (verdict.unmeasured.length) lines.push(`  ${chalk.dim('unmeasured')}  ${verdict.unmeasured.join(', ')} (baselined, not built this run)`)
    out.push(lines.length ? lines.join('\n') : `  ${chalk.green('within baseline')}`)
  }
  return out.join('\n').replace(/^\n/, '')
}
