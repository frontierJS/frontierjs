/*
 * units.js — a magnitude with a unit, as the string a person reads.
 *
 * Here because four copies of the same function disagreed. `@frontierjs/ui`'s
 * FileUpload answered `5.0 MB` and three of basecamp's screens answered `5 MB`
 * for the same number, so one application showed one disk two ways (`FJS-408`).
 *
 * It is in toolbelt rather than in the component that had it first because
 * three of those four callers are formatting DISKS, not uploads, and the server
 * reports the same sizes over the wire — a `.mesa` import needs the Mesa build
 * plugin and cannot cross that line (`FJS-D116`, boundary 2).
 *
 * Binary, with the familiar labels: 1024 to the step, and the step is called MB
 * rather than MiB. That is what all four copies already did and what almost
 * every tool a person has used shows them. It is MiB wearing MB's name, and the
 * alternative is a correct label most readers take for a typo.
 */

const STEP  = 1024
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Bytes → the shortest honest string.
 *
 * Precision is ADAPTIVE: one decimal below ten of a unit, none above it —
 * `5.0 MB` carries information that `503.2 GB` does not, and the reader of a
 * long list is scanning magnitudes rather than reading digits. `decimals`
 * overrides it for a caller who needs a fixed shape (a column that must not
 * jitter, a total that has to add up on screen).
 *
 * Bytes themselves never take a decimal: there is no such thing as half a byte.
 *
 * @param {number} bytes
 * @param {{ decimals?: number }} [opts]
 * @returns {string}
 */
export function formatBytes(bytes, opts = {}) {
  // Not a number is not zero. Answering '0 B' for a missing size is how *we do
  // not know* reads as *an empty file*. `null` and `''` are checked by hand
  // because `Number(null)` and `Number('')` are both 0, which is the one place
  // JavaScript will hand you a plausible answer to a question nobody asked.
  if (bytes == null || bytes === '') return ''
  const n = Number(bytes)
  if (!Number.isFinite(n)) return ''

  const sign = n < 0 ? '-' : ''
  let value  = Math.abs(n)
  let unit   = 0

  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP
    unit++
  }

  const decimals = opts.decimals ?? (unit === 0 ? 0 : value < 10 ? 1 : 0)

  return `${sign}${value.toFixed(decimals)} ${UNITS[unit]}`
}

/** The steps this kit counts in, for a caller building its own axis or legend. */
export const BYTE_UNITS = Object.freeze(UNITS)

// ─── Money ────────────────────────────────────────────────────────────────
//
// The other magnitude every app formats by hand. `example` wrote
// `` `£${n.toFixed(2)}` `` in five files and its API wrote a bare `toFixed(2)`
// into two email bodies — an amount with no currency at all, in the one place a
// reader is being told what they were charged.
//
// It is `Intl.NumberFormat` and not a symbol table, because what separates
// currencies is not the glyph: it is which side the glyph sits on, whether
// there is a space, how the thousands are grouped and how many decimals the
// currency HAS. JPY takes none and a hand-rolled `toFixed(2)` invents two.

/**
 * An amount, as the string a person reads.
 *
 * ONE locale by default, and that is deliberate. `en-US` with
 * `currencyDisplay: 'narrowSymbol'` answers `$28.00`, `£28.00`, `€28.00` — the
 * bare symbol in every case. Asking for the currency's own home locale instead
 * would answer `US$28.00` for dollars read from London, which is correct and is
 * not what a shop's price tag says. Pass `locale` where the reader's own
 * convention is the point (an invoice, a statement).
 *
 * The amount is a NUMBER of major units — 28.5 is twenty-eight fifty, not
 * twenty-eight and a half cents. This kit does not do minor units, because a
 * caller storing integer cents knows it and a caller storing a float does not,
 * and guessing between them is how a price gains two zeroes.
 *
 * Not a number answers `''`, for `formatBytes`'s reason: `Number(null)` is 0,
 * and *nothing was answered* must not read as *free*.
 *
 * @param {number} amount
 * @param {string} [currency]  ISO 4217, e.g. 'USD'. Default 'USD'.
 * @param {{ locale?: string, decimals?: number }} [opts]
 * @returns {string}
 */
export function formatMoney(amount, currency = 'USD', opts = {}) {
  if (amount == null || amount === '') return ''
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''

  const code = String(currency || 'USD').toUpperCase()

  try {
    return new Intl.NumberFormat(opts.locale ?? 'en-US', {
      style:           'currency',
      currency:        code,
      currencyDisplay: 'narrowSymbol',
      ...(opts.decimals !== undefined
        ? { minimumFractionDigits: opts.decimals, maximumFractionDigits: opts.decimals }
        : {}),
    }).format(n)
  } catch {
    // An unknown code is a RangeError from Intl, and a thrown formatter takes
    // the screen with it. The code itself is the honest fallback — it says
    // which currency and admits it could not be rendered.
    return `${code} ${n.toFixed(opts.decimals ?? 2)}`
  }
}

// ─── Minor units ──────────────────────────────────────────────────────────────
//
// How many decimal places a currency HAS. The fact `@money` derives its scale
// from, and the one `formatMoney` above already turns on: JPY has none, KWD has
// three, and a hand-rolled `toFixed(2)` invents a minor unit the yen does not
// have (`FJS-440`).
//
// Read off ICU rather than shipped as a table. Two platform facts do the work,
// and both update with the runtime rather than with this package:
//
//   Intl.supportedValuesOf('currency')  — 306 ISO 4217 codes, which is what
//                                         makes a TYPO refusable
//   resolvedOptions().maximumFractionDigits — the minor units
//
// The first one is load-bearing. `Intl.NumberFormat` does NOT throw on an
// unknown code — `ZZZ` and `BTC` both resolve to 2 decimals in silence — so a
// mistyped `@money(UDS)` would take scale 2 and be wrong by a factor of a
// hundred wherever the real currency has none. Asking whether ICU knows the code
// is the only way to tell those apart, and there are 26 currencies where it
// matters.

let _known = null

/** The ISO 4217 codes this runtime knows, as a Set. */
export function knownCurrencies() {
  if (_known) return _known
  try {
    _known = new Set(Intl.supportedValuesOf('currency'))
  } catch {
    // An older runtime without supportedValuesOf: everything is "known", which
    // degrades to the pre-existing behaviour rather than refusing every code.
    _known = null
  }
  return _known ?? new Set()
}

/** Does this runtime recognise the code? Always true where ICU cannot be asked. */
export function isKnownCurrency(code) {
  const set = knownCurrencies()
  if (!set.size) return true
  return set.has(String(code ?? '').toUpperCase())
}

/**
 * Decimal places for a currency — 2 for USD, 0 for JPY, 3 for KWD.
 *
 * Throws on a code this runtime does not know, because the alternative is
 * answering 2 for a typo. A caller that wants the lenient reading asks
 * `isKnownCurrency` first.
 *
 * @param {string} currency  ISO 4217, e.g. 'USD'
 * @returns {number}
 */
export function minorUnits(currency) {
  const code = String(currency ?? '').toUpperCase()
  if (!/^[A-Z]{3}$/.test(code))
    throw new Error(`minorUnits: '${currency}' is not an ISO 4217 code — three letters, e.g. 'USD'`)
  if (!isKnownCurrency(code))
    throw new Error(`minorUnits: '${code}' is not a currency this runtime knows`)

  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    .resolvedOptions().maximumFractionDigits
}

/**
 * A stored `@money` amount → the number a formatter reads.
 *
 * `@money` stores a whole number of MINOR units and `formatMoney` above takes
 * MAJOR ones, so something has to divide — and the divisor is the currency's,
 * never the caller's. A hand-rolled `/ 100` is right for the dollar, wrong for
 * the yen by a factor of a hundred, and wrong for the dinar by ten; it is the
 * same mistake `formatMoney` exists to stop, one step earlier in the pipe.
 *
 * @param {number} minor  a whole number of minor units, e.g. 1299
 * @param {string} currency  ISO 4217
 * @returns {number}  the major-unit amount, e.g. 12.99
 */
export function fromMinor(minor, currency) {
  const n = Number(minor)
  if (!Number.isFinite(n)) return 0
  return n / 10 ** minorUnits(currency)
}

/**
 * The other direction — what a person typed, as the integer a column stores.
 *
 * Rounds, and that is the point: `8.29 * 100` is 828.9999999999999 in binary
 * floating point, so the truncation a caller reaches for first loses a cent on
 * a number that looks exact. Every amount entering the Data boundary goes
 * through here; nothing downstream of it is a float.
 *
 * @param {number} major  e.g. 12.99
 * @param {string} currency  ISO 4217
 * @returns {number}  minor units, e.g. 1299
 */
export function toMinor(major, currency) {
  const n = Number(major)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10 ** minorUnits(currency))
}

/*
 * ─── Rounding and allocation (`FJS-D154`) ─────────────────────────────────
 *
 * `@scale`/`@money` make storage exact and stop there: the schema does not
 * decide a rounding mode and does not decide which line of a split bill gets
 * the leftover unit. Both live here, as functions over integers, because a
 * Money value object would have to be wrapped on every read and unwrapped on
 * every write at four boundaries an app already has — the wire, a form control,
 * an `@@check` the database evaluates, and a `SUM` the client compiles.
 *
 * The two are separate because they answer different questions. A rounding mode
 * belongs to a MULTIPLICATION — a rate applied to a base — and there is a real
 * disagreement about it, so it is an option. A remainder belongs to a SPLIT,
 * where the only requirement is that the parts add up, and a second answer
 * there would produce two receipts for one basket.
 */

/**
 * A value that is not a whole number of minor units → one that is.
 *
 * Half away from zero by default, which is what a person checking a sum on
 * paper expects: `Math.round` alone breaks ties towards positive infinity, so
 * −0.5 would go the other way from 0.5 and a refund would not mirror its
 * charge.
 *
 * `mode: 'half-even'` is banker's rounding, required of tax in several
 * jurisdictions. It is a per-call option and never a module setting, because an
 * application that needs both needs them in one process — and because the
 * reader of one line can then see which rule produced it.
 *
 * @param {number} value
 * @param {{ mode?: 'half-away' | 'half-even' }} [opts]
 * @returns {number}  a whole number
 */
export function roundMinor(value, opts = {}) {
  const mode = opts.mode ?? 'half-away'
  if (mode !== 'half-away' && mode !== 'half-even')
    throw new Error(`roundMinor: unknown mode '${mode}' — 'half-away' or 'half-even'`)

  const n = Number(value)
  // Not a number is not zero anywhere else in this file, and it is not zero
  // here either — but this one is arithmetic rather than display, so a caller
  // handed NaN has a bug upstream and a silent 0 buries it in a total.
  if (!Number.isFinite(n)) throw new Error(`roundMinor: ${value} is not a finite number`)

  const sign = n < 0 ? -1 : 1
  const mag  = Math.abs(n)
  const low  = Math.floor(mag)
  const frac = mag - low

  if (frac > 0.5) return sign * (low + 1)
  if (frac < 0.5) return sign * low
  if (mode === 'half-away') return sign * (low + 1)
  return sign * (low % 2 === 0 ? low : low + 1)
}

/**
 * Split a whole amount across lines so the parts sum to it EXACTLY.
 *
 * The proration case: a third of a monthly price across three lines is
 * 333.333… each, and three lines of 333 is a receipt that is a unit short of
 * what was charged. Every line is floored to its exact share and the leftover
 * units go one each to the lines with the largest fractional part — Fowler's
 * answer, fair by size rather than by position, and deterministic given the
 * ratios, so two runs and two machines agree. **Ties break by position**,
 * because a rule that leaves them open is one that produces two receipts for
 * one basket.
 *
 * Integers in, integers out. `amount` is minor units (or a `@scale(n)` column's
 * stored value — it is the same statement, that the unit is 1). There is no
 * `scale` parameter and no currency: the smallest thing this can hand out is
 * one of whatever `amount` is counted in, which the caller has already decided
 * by holding an integer.
 *
 * A negative amount allocates by magnitude and comes back negative, so a refund
 * splits the way its charge did.
 *
 * @param {number} amount  a whole number, may be negative
 * @param {number[]} ratios  non-negative weights; need not sum to anything
 * @returns {number[]}  same length, summing to `amount`
 */
export function allocate(amount, ratios) {
  const n = Number(amount)
  if (!Number.isInteger(n))
    throw new Error(`allocate: amount must be a whole number of minor units, got ${amount}`)
  if (!Number.isSafeInteger(n))
    throw new Error(`allocate: ${amount} is past 2^53, where a JS number stops being exact`)

  const list = Array.isArray(ratios) ? ratios.map(Number) : null
  if (!list || !list.length)
    throw new Error('allocate: ratios must be a non-empty array')
  if (list.some((r) => !Number.isFinite(r) || r < 0))
    throw new Error('allocate: every ratio must be a finite number >= 0')

  const total = list.reduce((a, b) => a + b, 0)
  // Nothing to be proportional TO. Splitting evenly here would be a guess about
  // what the caller meant, and a guess that sums correctly is the worst kind.
  if (total <= 0)
    throw new Error('allocate: ratios sum to 0, so there is no share to divide by')

  const sign  = n < 0 ? -1 : 1
  const mag   = Math.abs(n)
  const exact = list.map((r) => (mag * r) / total)
  const parts = exact.map(Math.floor)

  // What the floors left behind. Rounded because the subtraction is over
  // floats: it is a whole number by construction and strictly less than the
  // number of lines, and `Math.round` is what stops 2.9999999999 becoming 2.
  let left = Math.round(mag - parts.reduce((a, b) => a + b, 0))

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)

  for (let k = 0; k < left && k < order.length; k++) parts[order[k].i] += 1

  return parts.map((v) => v * sign)
}
