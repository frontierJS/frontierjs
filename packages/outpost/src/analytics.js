/*
 * analytics.js — what traffic a route took, counted off its Caddy access log.
 *
 * `POST /analytics` (`IDEAS/traffic-analysis.md`). Caddy writes one JSON line
 * per request to `accessLogPath(id)` and rolls it itself; this reads the live
 * file and the rolled ones, keeps the lines whose `ts` falls in the window and
 * counts them per `request.host` (`FJS-D763`, `FJS-D764`). Nothing is stored:
 * the log is the source, so every read re-parses it and the deepest history is
 * whatever Caddy's roll keeps.
 *
 * A named capability with a bounded answer, not `/exec`: the caller names a
 * route and a window and gets numbers back, never a line of the log.
 */

import { readdir, readFile } from 'node:fs/promises'
import { createReadStream }   from 'node:fs'
import { createInterface }    from 'node:readline'
import { gunzipSync, createGunzip } from 'node:zlib'
import { join, basename }    from 'node:path'
import { ROOTS }             from './layout.js'
import { validName }         from './static.js'
import { accessLogPath }     from './ingress.js'
import { ISO_INSTANT }       from './replicate.js'

/** `fjs-<app>` (Outpost's routes) or `fli-<app>[-api][-http]` (`fli deploy`'s).
 *  The id becomes a filename, so it is refused before it is joined to a path. */
export function checkRouteId(id) {
  const prefix = typeof id === 'string' ? /^(fjs|fli)-/.exec(id)?.[0] : null
  if (!prefix) return `route_id must name a route, fjs-<app> or fli-<app> — got ${JSON.stringify(id ?? null)}`
  const bad = validName(id.slice(prefix.length), 'route_id')
  return bad && `route_id '${id}' is not a route this machine logs`
}

/** A window bound as epoch seconds — Caddy's `ts` — from a UTC instant, the
 *  rule `/replica/restore`'s `at` already holds the wire to. */
function boundOf(value, what) {
  if (value == null) return null
  const ms = typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN
  if (Number.isNaN(ms)) throw new Error(`${what} must be a UTC instant (2026-10-28T00:00:00Z) — got ${JSON.stringify(value)}`)
  return ms / 1000
}

// Caddy rolls `<id>.access.log` to `<id>.access-<UTC stamp>.log`, gzipped
// unless the logger says `roll_uncompressed`. The stamp is when the roll
// happened, so a rolled file holds nothing newer than it.
const ROLLED = /^\.access-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?\.log(\.gz)?$/

// The most lines one report parses. A read is paid for here, and Caddy's roll
// keeps up to a gigabyte of JSON; newest first, so a cut drops the oldest.
export const MAX_LINES = 100_000
// Rows per panel. A scanner walking a wordlist is a path per request.
export const TOP = 20

// ─── Panels ───────────────────────────────────────────────────────────────

const tally = () => ({ requests: 0, bytes: 0, ips: new Set(), status: new Map(), paths: new Map(), errors: new Map() })

/** The path a panel names. The query is dropped: it is where a reset link or
 *  a signed URL carries its token, and a panel is read by every operator. */
const pathOf = (uri) => typeof uri === 'string' ? uri.split('?')[0] || '/' : '(none)'

function count(t, entry) {
  const status = Number.isInteger(entry.status) ? entry.status : 0
  const bytes  = Number.isFinite(entry.size) ? entry.size : 0
  const path   = pathOf(entry.request.uri)
  t.requests++
  t.bytes += bytes
  t.status.set(status, (t.status.get(status) ?? 0) + 1)
  // `client_ip`, never `remote_ip`: behind a proxied Cloudflare zone the
  // remote is the edge, and every request would come from a handful of IPs.
  if (typeof entry.request.client_ip === 'string') t.ips.add(entry.request.client_ip)

  const p = t.paths.get(path) ?? { requests: 0, bytes: 0, seconds: 0, max: 0 }
  p.requests++
  p.bytes += bytes
  // Caddy's `duration` is seconds as a float.
  const seconds = Number.isFinite(entry.duration) ? entry.duration : 0
  p.seconds += seconds
  if (seconds > p.max) p.max = seconds
  t.paths.set(path, p)

  if (status >= 400) {
    const key = `${status} ${path}`
    const e = t.errors.get(key) ?? { path, status, requests: 0 }
    e.requests++
    t.errors.set(key, e)
  }
}

// Ties break on the row's own key, so a report does not reorder with the
// direction the log was read in.
const byRequests = (a, b) => b.requests - a.requests
  || String(a.path ?? '').localeCompare(String(b.path ?? '')) || (a.status ?? 0) - (b.status ?? 0)
// To a hundredth: a static answer takes well under a millisecond, and a
// whole-number panel would draw it as 0, the same as a missing `duration`.
const ms = (seconds) => Math.round(seconds * 100_000) / 100
const iso = (ts) => ts == null ? null : new Date(ts * 1000).toISOString()

/** One host's panels. `client_ips` is a count of distinct addresses and is
 *  never a count of people. */
function panels(host, t) {
  const paths = [...t.paths].map(([path, p]) => ({ path, ...p }))
  return {
    host,
    requests:   t.requests,
    bytes:      t.bytes,
    client_ips: t.ips.size,
    status:     [...t.status].map(([status, requests]) => ({ status, requests })).sort(byRequests).slice(0, TOP),
    paths:      paths.map(({ path, requests, bytes }) => ({ path, requests, bytes })).sort(byRequests).slice(0, TOP),
    errors:     [...t.errors.values()].sort(byRequests).slice(0, TOP),
    durations:  paths.map(({ path, requests, seconds, max }) => ({ path, requests, mean_ms: ms(seconds / requests), max_ms: ms(max) }))
      .sort((a, b) => b.mean_ms - a.mean_ms).slice(0, TOP),
  }
}

/** A file's first access-line `ts`. Streamed and stopped there, so the depth
 *  of a gigabyte roll costs a few lines, not a decompress of the oldest file. */
async function firstTs(file) {
  const raw   = createReadStream(file.path)
  const input = file.gzip ? raw.pipe(createGunzip()) : raw
  const lines = createInterface({ input, crlfDelay: Infinity })
  let looked  = 0
  try {
    for await (const line of lines) {
      let ts
      try { ts = JSON.parse(line)?.ts } catch {}
      if (typeof ts === 'number') return ts
      if (++looked === 100) return null
    }
    return null
  } catch {
    // An unreadable oldest roll leaves the depth unknown; the lines in the
    // window are still countable, so it does not fail the report.
    return null
  } finally {
    lines.close()
    raw.destroy()
    if (input !== raw) input.destroy()
  }
}

export function createAnalytics({ dir = ROOTS.logs } = {}) {

  /** Every log file of the route, newest first. */
  async function filesOf(id) {
    let names
    try { names = await readdir(dir) } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    const live  = basename(accessLogPath(id))
    const files = []
    for (const name of names) {
      if (name === live) { files.push({ path: join(dir, name), gzip: false, rolledAt: Infinity }); continue }
      if (!name.startsWith(id)) continue
      const m = ROLLED.exec(name.slice(id.length))
      if (!m) continue
      const rolledAt = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ?? ''}Z`) / 1000
      files.push({ path: join(dir, name), gzip: !!m[6], rolledAt })
    }
    return files.sort((a, b) => b.rolledAt - a.rolledAt)
  }

  /** The files that can hold a line in the window. A rolled file holds the
   *  lines after the roll before it, up to its own. */
  const inWindow = (files, from, to) => files.filter((file, i) => {
    const since = files[i + 1]?.rolledAt ?? -Infinity
    return (from == null || file.rolledAt >= from) && (to == null || since <= to)
  })

  async function report({ routeId, from: fromIso, to: toIso }) {
    const bad = checkRouteId(routeId)
    if (bad) throw new Error(bad)
    const from = boundOf(fromIso, 'from')
    const to   = boundOf(toIso, 'to')
    if (from != null && to != null && from > to) throw new Error(`from (${fromIso}) is after to (${toIso})`)

    const all = await filesOf(routeId)
    // A log with every file outside the window is an empty report, not this.
    if (!all.length) throw new Error(`no access log for route '${routeId}' on this machine`)
    const files = inWindow(all, from, to)

    const hosts = new Map()
    let lines = 0, skipped = 0, read = 0, oldest = null, truncated = false
    reading: for (const file of files) {
      const raw  = await readFile(file.path)
      const text = (file.gzip ? gunzipSync(raw) : raw).toString('utf8')
      const all  = text.split('\n')
      for (let i = all.length - 1; i >= 0; i--) {
        const line = all[i]
        if (!line) continue
        if (read === MAX_LINES) { truncated = true; break reading }
        read++
        let entry
        try { entry = JSON.parse(line) } catch { skipped++; continue }
        const ts   = entry?.ts
        const host = entry?.request?.host
        // A line without either is not an access line, and counting it under
        // a blank host would draw traffic nobody sent.
        if (typeof ts !== 'number' || typeof host !== 'string') { skipped++; continue }
        // Caddy appends as each request finishes, so reading backwards the
        // first line before the window is the last one worth reading.
        if (from != null && ts < from) break reading
        if (to != null && ts > to) continue
        lines++
        if (oldest == null || ts < oldest) oldest = ts
        const key = host.toLowerCase()
        if (!hosts.has(key)) hosts.set(key, tally())
        count(hosts.get(key), entry)
      }
    }

    return {
      route_id: routeId,
      from:     fromIso ?? null,
      to:       toIso ?? null,
      files:    files.length,
      lines,
      skipped,
      // Set when MAX_LINES cut the read: the report covers `oldest` onward,
      // not the window asked for.
      truncated,
      oldest:   iso(oldest),
      // How far back the roll reaches, whatever the window: the deepest
      // history this machine can answer for, since nothing else keeps one.
      kept_since: iso(await firstTs(all.at(-1))),
      hosts:    [...hosts].map(([host, t]) => panels(host, t)).sort((a, b) => b.requests - a.requests),
    }
  }

  return { report }
}
