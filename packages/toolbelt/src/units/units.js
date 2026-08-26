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
