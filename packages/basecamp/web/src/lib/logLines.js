// web/src/lib/logLines.js — a container's log, as lines a screen can tone.
//
// Two shapes arrive in one stream: Junction's JSON lines and whatever a CLI
// wrote with ANSI escapes (litestone's migrate, caravan's banner). Shown raw,
// the first is a wall of braces and the second is `[2m` litter, which is the
// state that sent somebody back to ssh.
//
// A part is `{ text, tone, bold, dim }` and a tone is a NAME the stylesheet
// maps (`danger`, `success`, …) — never a color (Invariant 13).

// A copy that lost its ESC still carries `[2m`, so a bare one matches too —
// but only with digits, or the `[m` of `[main]` is read as a reset.
const SGR = /\x1b\[([\d;]*)m|\[(\d{1,3}(?:;\d{1,3})*)m/g

const FG = {
  30: 'muted', 90: 'muted',
  31: 'danger', 91: 'danger',
  32: 'success', 92: 'success',
  33: 'warning', 93: 'warning',
  34: 'info', 94: 'info', 35: 'info', 95: 'info', 36: 'info', 96: 'info',
}

function applySgr(state, codes) {
  const list = codes ? codes.split(';').map(Number) : [0]
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c === 0) { state.tone = null; state.bold = false; state.dim = false }
    else if (c === 1) state.bold = true
    else if (c === 2) state.dim = true
    else if (c === 22) { state.bold = false; state.dim = false }
    else if (c === 39) state.tone = null
    else if (c in FG) state.tone = FG[c]
    // 256-color and truecolor carry their arguments in the same list; skipped
    // whole, or `38;5;196` reads 196 as a code of its own.
    else if (c === 38 || c === 48) i += list[i + 1] === 5 ? 2 : 4
  }
}

/** One string → parts, carrying SGR `state` across calls (an escape can span lines). */
function ansiParts(text, state = { tone: null, bold: false, dim: false }) {
  const parts = []
  let last = 0
  for (const m of text.matchAll(SGR)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), ...state })
    applySgr(state, m[1] ?? m[2])
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), ...state })
  return parts
}

// pino writes a number, Junction a word.
const LEVEL_NUM = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }
const LEVEL_TONE = { fatal: 'danger', error: 'danger', warn: 'warning', warning: 'warning', info: 'info', debug: 'muted', trace: 'muted' }

const ACCESS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) (\d{3}) (\S+)(?: - (.*))?$/

function statusTone(code) {
  return code >= 500 ? 'danger' : code >= 400 ? 'warning' : code >= 300 ? 'info' : 'success'
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

function clock(time) {
  const d = new Date(time)
  if (Number.isNaN(d.getTime())) return String(time)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function messageParts(msg) {
  const m = ACCESS.exec(msg)
  if (!m) return ansiParts(msg)
  const [, method, path, status, ms, ip] = m
  return [
    { text: method + ' ', bold: true },
    { text: path + ' ' },
    { text: status, tone: statusTone(Number(status)), bold: true },
    { text: ' ' + ms, dim: true },
    ...(ip ? [{ text: ' ' + ip, tone: 'muted' }] : []),
  ]
}

function jsonLine(raw) {
  if (raw[0] !== '{') return null
  let rec
  try { rec = JSON.parse(raw) } catch { return null }
  if (!rec || typeof rec !== 'object') return null
  const msg = rec.message ?? rec.msg
  if (rec.level == null && msg == null) return null

  const level = typeof rec.level === 'number' ? (LEVEL_NUM[rec.level] ?? String(rec.level)) : String(rec.level ?? 'log')
  const time  = rec.time ?? rec.timestamp
  const { level: _l, time: _t, timestamp: _ts, message: _m, msg: _mm, ns, data, ...rest } = rec
  const extra = data !== undefined ? data : Object.keys(rest).length ? rest : undefined

  const parts = []
  if (time != null) parts.push({ text: clock(time) + ' ', tone: 'muted', title: String(time) })
  parts.push({ text: level.toUpperCase().padEnd(5) + ' ', tone: LEVEL_TONE[level] ?? null, bold: true })
  if (ns) parts.push({ text: `[${ns}] `, tone: 'muted' })
  if (msg != null) parts.push(...messageParts(String(msg)))
  if (extra !== undefined) parts.push({ text: '  ' + JSON.stringify(extra), dim: true })
  return { level: LEVEL_TONE[level] ?? null, parts }
}

/**
 * A log's text → `[{ level, parts }]`. `level` is the line's tone when it has
 * one (a JSON line's level), which is what a row-wide marker reads.
 */
export function logLines(text) {
  if (!text) return []
  const state = { tone: null, bold: false, dim: false }
  const lines = text.replace(/\n$/, '').split('\n')
  return lines.map(raw => jsonLine(raw) ?? { level: null, parts: ansiParts(raw, state) })
}

/** The text with every SGR escape removed — what Copy and the raw view show. */
export function stripAnsi(text) {
  return (text ?? '').replace(SGR, '')
}
