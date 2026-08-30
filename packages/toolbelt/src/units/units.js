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
