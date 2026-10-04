// cells.js — one cell of text, read as the type a column declares, or a reason
// it cannot be.
//
// A file somebody else wrote is dirty in ways a form never is: a date in the
// wrong order, a number with a thousands separator, a status nobody declared.
// The reader that meets it must not GUESS, because a guess is a wrong value in
// a row that looks right — `1.234` read as one thousand two hundred and
// thirty-four is a German amount loaded a thousand times too small, and nothing
// downstream can tell. So every reader here either answers the exact value or
// answers why not, and the caller sets the row aside with that reason.
//
// A reason NEVER quotes the cell. The text may be what a column encrypts or
// guards, and a reason is stored and shown where the column's protection does
// not reach. It names what was expected instead, which is the schema's and
// safe to say.
//
// Blank is not a value of any type but text: `''` reads as `null` for every
// kind except `string`, and whether a null is allowed is the column's to say,
// not the cell's.

const INT      = /^[+-]?\d+$/
const DECIMAL  = /^[+-]?(\d+)(?:\.(\d+))?$/
const FLOAT    = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
// 1,234 · 12,345.67 · -1,234,567 — grouped thousands, in the one locale whose
// grouping looks like this. Named so the reason can say what it saw.
const GROUPED  = /^[+-]?\d{1,3}(?:[,. ']\d{3})+(?:[.,]\d+)?$/
const ISO      = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i

const ok   = (value)  => ({ value })
const fail = (reason) => ({ reason })

/**
 * Read one cell.
 *
 * @param {string} text
 * @param {'string'|'int'|'float'|'scaled'|'boolean'|'datetime'|'enum'|'json'} kind
 * @param {{ scale?: number, values?: readonly string[] }} [opts]
 *   `scale` for `scaled` — the places after the point a whole-number column
 *   holds (`@scale(n)`, or `@money`'s currency); `values` for `enum`.
 * @returns {{ value: unknown } | { reason: string }}
 */
export function parseCell(text, kind, opts = {}) {
  if (typeof text !== 'string') throw new TypeError(`parseCell: expected text, got ${typeof text}`)
  if (kind === 'string') return ok(text)
  const t = text.trim()
  if (t === '') return ok(null)

  switch (kind) {
    case 'int':      return readInt(t)
    case 'float':    return readFloat(t)
    case 'scaled':   return readScaled(t, opts.scale)
    case 'boolean':  return readBoolean(t)
    case 'datetime': return readDateTime(t)
    case 'enum':     return readEnum(t, opts.values)
    case 'json':     return readJson(t)
    default: throw new Error(`parseCell: unknown kind '${kind}'`)
  }
}

function readInt(t) {
  if (!INT.test(t)) return fail(notANumber(t, 'a whole number'))
  const n = Number(t)
  if (!Number.isSafeInteger(n)) return fail('a whole number too large to hold exactly')
  return ok(n)
}

function readFloat(t) {
  if (!FLOAT.test(t)) return fail(notANumber(t, 'a number'))
  const n = Number(t)
  if (!Number.isFinite(n)) return fail('a number too large to hold')
  return ok(n)
}

// A decimal read as a whole number of its smallest unit, by string arithmetic:
// `8.29 * 100` is 828.9999999999999, and a loader that multiplies loses a cent
// on a value that looks exact. More places than the column holds is refused,
// not rounded — rounding is a decision about money, and not this reader's.
function readScaled(t, scale) {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`parseCell: 'scaled' needs a scale, got ${scale}`)
  const m = DECIMAL.exec(t)
  if (!m) return fail(notANumber(t, `a number with at most ${scale} decimal places`))
  const frac = m[2] ?? ''
  if (frac.length > scale) {
    // Trailing zeros past the scale say nothing: 12.500 at scale 2 is 12.50.
    if (/[^0]/.test(frac.slice(scale))) return fail(`more than ${scale} decimal place${scale === 1 ? '' : 's'}`)
  }
  const digits = m[1] + frac.slice(0, scale).padEnd(scale, '0')
  const n = Number(digits) * (t.startsWith('-') ? -1 : 1)
  if (!Number.isSafeInteger(n)) return fail('a number too large to hold exactly')
  return ok(n === 0 ? 0 : n)
}

function notANumber(t, expected) {
  if (GROUPED.test(t)) return `${expected}, without a thousands separator`
  return `not ${expected}`
}

function readBoolean(t) {
  const v = t.toLowerCase()
  if (v === 'true'  || v === '1') return ok(true)
  if (v === 'false' || v === '0') return ok(false)
  return fail('not true or false')
}

// ISO 8601 with a zone, and nothing else. A date with no zone is an instant
// nobody can place — `2026-01-01T09:00` is nine in the morning somewhere — and
// a day-first or month-first date is the same ambiguity one level up, so both
// are reasons, never guesses. The calendar is checked as well as the shape:
// `2026-02-30` passes every pattern and names no day.
function readDateTime(t) {
  const m = ISO.exec(t)
  if (!m) return fail('not an ISO 8601 date and time')
  const [, y, mo, d, h, mi, s, frac, zone] = m
  if (h === undefined) return fail('a date with no time or zone, so not one instant')
  if (!zone)           return fail('a time with no zone, so not one instant')
  const year = +y, month = +mo, day = +d, hour = +h, minute = +mi, second = +(s ?? 0)
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59)
    return fail('not a date on the calendar')
  const ms = Number(((frac ?? '') + '000').slice(0, 3))
  let at = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  if (zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
    const off = (+z[2] * 60 + +z[3]) * (z[1] === '+' ? 1 : -1)
    if (+z[2] > 23 || +z[3] > 59) return fail('not a time zone offset')
    at -= off * 60_000
  }
  return ok(new Date(at).toISOString())
}

function daysIn(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// Exact, and case counts: `PAID` is not `paid`, because a status column is
// read back by code that compares it exactly. A source spelling its states in
// capitals is mapped where it lands, by somebody who knows that it does.
function readEnum(t, values) {
  if (!Array.isArray(values) || !values.length) throw new Error(`parseCell: 'enum' needs its values`)
  return values.includes(t) ? ok(t) : fail(`not one of ${values.join(', ')}`)
}

function readJson(t) {
  try { return ok(JSON.parse(t)) }
  catch { return fail('not JSON') }
}
