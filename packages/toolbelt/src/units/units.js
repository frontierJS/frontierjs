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
// there is a space and how the thousands are grouped. The decimals are the one
// thing NOT taken from it — they are ISO's, below — because JPY takes none, a
// hand-rolled `toFixed(2)` invents two, and the two runtimes do not agree about
// several more.

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

  // ISO's exponent, not the locale's convention. CLDR prints the Lebanese pound
  // with no decimals and node and bun disagree about the dinar, so the same
  // stored amount would render differently on the machine that reads it than on
  // the one that wrote it. `null` where ISO states none, which leaves the
  // formatter's own answer alone.
  const digits = opts.decimals !== undefined ? opts.decimals : isoDigits(code)

  try {
    return new Intl.NumberFormat(opts.locale ?? 'en-US', {
      style:           'currency',
      currency:        code,
      currencyDisplay: 'narrowSymbol',
      ...(digits !== null
        ? { minimumFractionDigits: digits, maximumFractionDigits: digits }
        : {}),
    }).format(n)
  } catch {
    // An unknown code is a RangeError from Intl, and a thrown formatter takes
    // the screen with it. The code itself is the honest fallback — it says
    // which currency and admits it could not be rendered.
    return `${code} ${n.toFixed(opts.decimals ?? 2)}`
  }
}

// ─── ISO 4217 ─────────────────────────────────────────────────────────────────
//
// The table is SHIPPED and the host's is not consulted. Two measurements are why.
//
// `resolvedOptions().maximumFractionDigits` answers a DISPLAY question — CLDR's
// convention for how an amount is written — and `@money` asks a STORAGE one,
// which is ISO 4217's exponent. They are different questions and the runtimes
// answer them differently: node says the Iraqi dinar has 0 decimal places where
// ISO says 3, and 0 for thirteen more where ISO says 2. A dinar amount written
// on one machine and read on the other is out by a thousand.
//
// `Intl.supportedValuesOf('currency')` is not one list either. node reports 162
// codes and bun 306 — they differ on 145: bun carries every withdrawn code back
// to the Austrian schilling, node carries `ZWG`, which bun does not. So the same
// `@money(ZWG)` parses on one runtime and is refused as a typo on the other.
//
// A host ICU table is a dependency the manifest cannot declare, and declaring
// nothing is this package's whole license to be imported by litestone and mesa
// (`FJS-D26`). Shipped, the answer moves when this package moves; read off the
// host, it moves when somebody upgrades node.

// ISO 4217 active codes — the currencies and funds, the four metals, the bond
// and testing codes, and XXX itself. Being generous here is safe and being
// host-dependent is not: a code ISO has withdrawn is still one somebody holds
// rows in, and refusing it buys nothing.
const ACTIVE = `
  AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND
  BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU
  CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS
  GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD
  JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL
  MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR
  NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG
  SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY
  TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG
  XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR
  ZMW ZWG ZWL
`.trim().split(/\s+/)

// Exponents that are not 2. Every other code in ACTIVE has two places.
const MINOR_UNITS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
}

// Codes ISO gives no minor unit at all — a troy ounce of gold, a bond-market
// unit, the testing code. Known, and not an amount: there is no whole number of
// them to store, so `minorUnits` refuses instead of answering the 2 that would
// let `toMinor` invent a hundredth of an ounce.
const NO_MINOR_UNIT = new Set([
  'XAU', 'XAG', 'XPD', 'XPT', 'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XSU', 'XUA',
  'XTS', 'XXX',
])

let _known = null

/** The ISO 4217 codes, as a Set. The same set on every runtime. */
export function knownCurrencies() {
  return _known ??= new Set(ACTIVE)
}

/** Is this an ISO 4217 code? */
export function isKnownCurrency(code) {
  return knownCurrencies().has(String(code ?? '').toUpperCase())
}

/**
 * Decimal places for a currency — 2 for USD, 0 for JPY, 3 for KWD.
 *
 * ISO 4217's exponent, which is the STORAGE fact `@money` derives its scale
 * from. Not what a locale prints: CLDR shows the Lebanese pound with no
 * decimals because fractions of it are not used in practice, and the column
 * still holds hundredths.
 *
 * Throws on a code ISO does not carry, because the alternative is answering 2
 * for a typo — `Intl.NumberFormat` does not throw on `UDS` or `BTC`, it answers
 * two places, and a mistyped `@money(UDS)` would then be wrong by a hundred
 * wherever the real currency has none. A caller that wants the lenient reading
 * asks `isKnownCurrency` first.
 *
 * @param {string} currency  ISO 4217, e.g. 'USD'
 * @returns {number}
 */
export function minorUnits(currency) {
  const code = String(currency ?? '').toUpperCase()
  if (!/^[A-Z]{3}$/.test(code))
    throw new Error(`minorUnits: '${currency}' is not an ISO 4217 code — three letters, e.g. 'USD'`)
  if (!isKnownCurrency(code))
    throw new Error(`minorUnits: '${code}' is not an ISO 4217 currency`)
  if (NO_MINOR_UNIT.has(code))
    throw new Error(`minorUnits: '${code}' is an ISO 4217 code with no minor unit — a metal, a reserved code or a testing code, so there is no whole number of them to store`)

  return isoDigits(code)
}

/** The exponent, or `null` where the code is not one ISO gives an amount to. */
function isoDigits(code) {
  if (!isKnownCurrency(code) || NO_MINOR_UNIT.has(code)) return null
  return MINOR_UNITS[code] ?? 2
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
