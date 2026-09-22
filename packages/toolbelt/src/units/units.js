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
 * A value that is genuinely a number, or NaN.
 *
 * `Number(null)`, `Number('')` and `Number([])` are all 0 — the one place
 * JavaScript hands you a plausible answer to a question nobody asked, and the
 * reason every function here has to ask before it divides. Only a number or a
 * non-blank string is one; what each caller then DOES about NaN is its own
 * surface's answer, and they differ.
 */
function asNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return NaN
}

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
  // not know* reads as *an empty file*.
  const n = asNumber(bytes)
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
  const n = asNumber(amount)
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
 * Not a number answers NaN rather than 0, and it does not throw. This is the
 * READ side: the value came out of a nullable column and its sink is
 * `formatMoney`, which already answers `''` for a number it cannot render — so
 * NaN carries *we do not know* all the way to the cell, where 0 rendered it as
 * `$0.00` and a throw would take a screen down over one missing amount. The
 * currency is still resolved first, so a typo in the CODE is loud either way.
 * `toMinor` below is the opposite surface and answers the opposite way.
 *
 * @param {number} minor  a whole number of minor units, e.g. 1299
 * @param {string} currency  ISO 4217
 * @returns {number}  the major-unit amount, e.g. 12.99
 */
export function fromMinor(minor, currency) {
  const n = asNumber(minor)
  const scale = 10 ** minorUnits(currency)
  if (!Number.isFinite(n)) return NaN
  return n / scale
}

/**
 * The other direction — what a person typed, as the integer a column stores.
 *
 * Rounds, and that is the point: `8.29 * 100` is 828.9999999999999 in binary
 * floating point, so the truncation a caller reaches for first loses a cent on
 * a number that looks exact. Every amount entering the Data boundary goes
 * through here; nothing downstream of it is a float.
 *
 * Not a number THROWS, where `fromMinor` above answers NaN and `formatMoney`
 * answers `''`. One rule resolved per surface, by what a mistake destroys, and
 * this is the write side: 0 is a plausible answer to a question nobody asked,
 * and the question here is what to charge, so a missing amount booked a free
 * order and nothing said anything. A caller that means *blank is no amount*
 * decides that before the call, because only it knows.
 *
 * @param {number} major  e.g. 12.99
 * @param {string} currency  ISO 4217
 * @returns {number}  minor units, e.g. 1299
 */
export function toMinor(major, currency) {
  const n = asNumber(major)
  if (!Number.isFinite(n))
    throw new Error(`toMinor: ${JSON.stringify(major)} is not a finite number of ${String(currency).toUpperCase()}`)
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

  const n = asNumber(value)
  // Arithmetic rather than display, so a caller handed NaN has a bug upstream
  // and a silent 0 buries it in a total.
  if (!Number.isFinite(n)) throw new Error(`roundMinor: ${JSON.stringify(value)} is not a finite number`)

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

// ─── length ───────────────────────────────────────────────────────────────
//
// A radius is stated with its unit — `within: '5mi'` — so that nobody writes
// `radius * 1609.34` by hand, which is what a meters-only API produces: two
// files of one real application do exactly that, each with its own constant.
// The vocabulary is here rather than in `/geo` because what a quantity MEANS is
// this kit's question; `/geo` is the math over numbers, and it reads these.

const LENGTH = Object.freeze({
  mm: 0.001,
  cm: 0.01,
  m:  1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
  nmi: 1852,
})

/** Every unit `parseLength` accepts, longest spelling first. */
export const LENGTH_UNITS = Object.freeze(Object.keys(LENGTH))

/**
 * `'5mi'` → metres.
 *
 * A bare number is METRES rather than an error, because a caller who computed
 * one has already made the choice this function exists to record; a string
 * without a unit is refused, since `'5'` in a URL is a radius somebody meant to
 * spell and the silent reading of it is the bug the unit suffix prevents.
 *
 * The unit is matched case-insensitively and `KM`/`Km` are the same unit. A
 * negative or zero radius is refused: a filter that admits nothing is a mistake
 * with no second reading.
 *
 * @param {string|number} value
 * @returns {number} metres
 */
export function parseLength(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`parseLength: a distance must be a positive number, got ${value}`)
    return value
  }
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error('parseLength: expected a string like \'5mi\' or a number of metres')

  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(value)
  if (!m)
    throw new Error(
      `parseLength: cannot read '${value}' — expected a number and a unit, one of ${LENGTH_UNITS.join(', ')}`)

  const [, magnitude, rawUnit] = m
  const unit = rawUnit.toLowerCase()
  if (!(unit in LENGTH))
    throw new Error(`parseLength: unknown unit '${rawUnit}' — one of ${LENGTH_UNITS.join(', ')}`)

  const metres = Number(magnitude) * LENGTH[unit]
  if (!(metres > 0))
    throw new Error(`parseLength: a distance must be greater than zero, got '${value}'`)
  return metres
}

/**
 * Metres → the shortest honest string, in the caller's system.
 *
 * Adaptive the way `formatBytes` is: one decimal while the number is small
 * enough for the decimal to carry information, none once it is not. `imperial`
 * reads feet under a tenth of a mile and miles above it, which is the split a
 * person doing the reading already has in their head.
 *
 * @param {number} metres
 * @param {{ imperial?: boolean, decimals?: number }} [opts]
 * @returns {string}
 */
export function formatDistance(metres, opts = {}) {
  const n = asNumber(metres)
  if (!Number.isFinite(n)) return '—'
  const { imperial = false, decimals } = opts
  const fixed = (v, d) => v.toFixed(decimals ?? d)

  if (imperial) {
    const miles = n / LENGTH.mi
    if (miles < 0.1) return `${fixed(n / LENGTH.ft, 0)} ft`
    return `${fixed(miles, miles < 10 ? 1 : 0)} mi`
  }
  if (n < 1000) return `${fixed(n, 0)} m`
  const km = n / 1000
  return `${fixed(km, km < 10 ? 1 : 0)} km`
}

// ─── the measure table ────────────────────────────────────────────────────
//
// What a number COUNTS, as a symbol a schema can declare and a tool can read.
// A column holding grams is an `Int` and the unit lives in the identifier
// (`weightGrams`), which nothing parses — so the fact is stated and no form,
// no agent and no atlas can act on it. `@unit(g)` in `.lite` is the declaration
// and this is the vocabulary behind it, here for the reason `LENGTH` is: what a
// quantity MEANS is this kit's question.
//
// `factor` converts to the dimension's base and is `null` where no fixed one
// exists. A month is not a number of seconds — its length depends on which
// month — so a factor for it would be a lie a caller could not see. That is why
// the table carries the absence rather than leaving `mo` out: the FACT is
// expressible and only the arithmetic is refused, at the point somebody tries
// it.
//
// Length and information read their spellings from the two tables above rather
// than restating them, so a unit added there is a unit a schema can declare.

const BASE = Object.freeze({
  duration:    's',
  information: 'B',
  length:      'm',
  mass:        'g',
  ratio:       '1',
})

const DURATION = { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800, mo: null, yr: null }
const MASS     = { mg: 0.001, g: 1, kg: 1000, t: 1e6, oz: 28.349523125, lb: 453.59237 }
const RATIO    = { '%': 0.01 }

const MEASURES = Object.freeze(Object.fromEntries([
  ...Object.entries(DURATION).map(([symbol, factor]) => [symbol, { symbol, dimension: 'duration', factor }]),
  ...UNITS.map((symbol, i) => [symbol, { symbol, dimension: 'information', factor: STEP ** i }]),
  ...Object.entries(LENGTH).map(([symbol, factor]) => [symbol, { symbol, dimension: 'length', factor }]),
  ...Object.entries(MASS).map(([symbol, factor]) => [symbol, { symbol, dimension: 'mass', factor }]),
  ...Object.entries(RATIO).map(([symbol, factor]) => [symbol, { symbol, dimension: 'ratio', factor }]),
].map(([symbol, info]) => [symbol, Object.freeze(info)])))

/** Every unit symbol a schema may declare, grouped by what it measures. */
export const MEASURE_UNITS = Object.freeze(Object.fromEntries(
  Object.keys(BASE).map((dimension) => [
    dimension,
    Object.freeze(Object.values(MEASURES).filter((u) => u.dimension === dimension).map((u) => u.symbol)),
  ])))

/**
 * `'ms'` → `{ symbol, dimension, factor }`, or `null`.
 *
 * The match is EXACT and deliberately not case-folded: `MB` is a megabyte and
 * `Mb` a megabit in every tool a reader has used, and `m` and `min` differ by
 * more than a spelling. A near miss is answered by `suggestUnit` so a refusal
 * can name the unit that was meant.
 */
export function unitInfo(symbol) {
  return MEASURES[symbol] ?? null
}

/** Is this a unit this framework knows? */
export function isKnownUnit(symbol) {
  return typeof symbol === 'string' && symbol in MEASURES
}

/** The base unit of a dimension — what `factor` converts to. */
export function baseUnit(dimension) {
  return BASE[dimension] ?? null
}

/**
 * The known unit an unknown spelling most likely meant, or `null`.
 *
 * Case alone is the common miss (`MS` for `ms`, `Kg` for `kg`), and it is the
 * one worth answering by name: every other kind of typo is better served by the
 * dimension's own list, which the refusal prints anyway.
 */
export function suggestUnit(symbol) {
  if (typeof symbol !== 'string') return null
  const want = symbol.toLowerCase()
  return Object.keys(MEASURES).find((k) => k.toLowerCase() === want) ?? null
}

/**
 * Convert between two units of ONE dimension.
 *
 * Refuses by name across dimensions, and refuses a calendar unit rather than
 * inventing a length for it — *3 months in days* has no answer that does not
 * depend on which months.
 */
export function convertUnit(value, from, to) {
  const a = unitInfo(from), b = unitInfo(to)
  if (!a) throw new Error(`convertUnit: unknown unit '${from}'`)
  if (!b) throw new Error(`convertUnit: unknown unit '${to}'`)
  if (a.dimension !== b.dimension)
    throw new Error(`convertUnit: '${from}' measures ${a.dimension} and '${to}' measures ${b.dimension}`)
  for (const u of [a, b])
    if (u.factor === null)
      throw new Error(`convertUnit: '${u.symbol}' is a calendar unit and has no fixed length — convert a date, not a number`)
  const n = asNumber(value)
  if (!Number.isFinite(n)) throw new Error(`convertUnit: expected a number, got ${value}`)
  return (n * a.factor) / b.factor
}
