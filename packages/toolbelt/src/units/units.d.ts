/*
 * units.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. A kit imported by a TypeScript
 * package needs a declaration or it is a TS7016 in that package's build, and
 * four connectors under `packages/conduits/` import this one for `formatBytes`.
 * Same reason as `/mime`, `/gate` and `/redact`.
 */

// ─── bytes ────────────────────────────────────────────────────────────────

export interface FormatBytesOptions {
  /** Fixed decimal places. Default adapts: one below ten of a unit, none above, none for bytes. */
  decimals?: number
}

/** Bytes → `'5.0 MB'`, binary steps under the familiar labels. Not a number answers `''`. */
export function formatBytes(bytes: number | string, opts?: FormatBytesOptions): string

/** The steps `formatBytes` counts in: `B`, `KB`, `MB`, `GB`, `TB`, `PB`. */
export const BYTE_UNITS: readonly string[]

// ─── money ────────────────────────────────────────────────────────────────

export interface FormatMoneyOptions {
  /** BCP 47 locale. Default `'en-US'`. */
  locale?: string
  /** Fraction digits. Default is ISO 4217's exponent for the currency. */
  decimals?: number
}

/** A major-unit amount → `'$28.00'`. Not a number answers `''`; an unknown code falls back to `'28.00 XYZ'`. */
export function formatMoney(amount: number | string, currency?: string, opts?: FormatMoneyOptions): string

/** The ISO 4217 codes, as a new Set each call. */
export function knownCurrencies(): Set<string>

/** Is this an ISO 4217 code? Case-insensitive. */
export function isKnownCurrency(code: unknown): boolean

/** Decimal places for a currency: 2 for USD, 0 for JPY, 3 for KWD. Throws on a code ISO does not carry or one with no minor unit. */
export function minorUnits(currency: string): number

/** A stored `@money` integer → the major-unit number. Not a number answers NaN; a bad currency throws. */
export function fromMinor(minor: number | string, currency: string, places?: number): number

export interface FormatMinorOptions {
  /** Digits past the minor unit, from `@money(USD, places: n)`. Default 0. */
  places?: number
  /** BCP 47 locale. Default `'en-US'`. */
  locale?: string
}

/** A stored `@money` integer → `'$12.99'`: `fromMinor` then `formatMoney`. */
export function formatMinor(minor: number | string, currency: string, opts?: FormatMinorOptions): string

/** A typed major-unit amount → the integer a column stores, rounded. Not a number throws. */
export function toMinor(major: number | string, currency: string, places?: number): number

export interface RoundingOptions {
  /** Default `'half-away'`. */
  mode?: 'half-away' | 'half-even'
}

/** A value that is not a whole number of minor units → one that is. Not a number throws. */
export function roundMinor(value: number | string, opts?: RoundingOptions): number

/** `roundMinor` for a BigInt quotient. Both arguments must be bigints; a zero divisor throws. */
export function divRound(numerator: bigint, divisor: bigint, opts?: RoundingOptions): bigint

/** Split a whole amount across `ratios` so the parts sum to it exactly. Integers in, integers out. */
export function allocate(amount: number, ratios: number[]): number[]

// ─── length ───────────────────────────────────────────────────────────────

/** Every unit `parseLength` accepts: `mm`, `cm`, `m`, `km`, `in`, `ft`, `yd`, `mi`, `nmi`. */
export const LENGTH_UNITS: readonly string[]

/** `'5mi'` → metres. A bare number, a missing unit or a non-positive radius throws. */
export function parseLength(value: string): number

export interface FormatDistanceOptions {
  /** Feet and miles rather than metres and kilometres. Default false. */
  imperial?: boolean
  /** Fixed decimal places. Default adapts: one while the number is small, none above ten. */
  decimals?: number
}

/** Metres → `'1.2 km'` or `'0.7 mi'`. Not a number answers `'—'`. */
export function formatDistance(metres: number | string, opts?: FormatDistanceOptions): string

// ─── the measure table ────────────────────────────────────────────────────

export type Dimension = 'duration' | 'information' | 'length' | 'mass' | 'pixel' | 'ratio'

export interface UnitInfo {
  symbol: string
  dimension: Dimension
  /** Multiplier to the dimension's base unit; `null` for a calendar unit (`mo`, `yr`) with no fixed length. */
  factor: number | null
}

/** Every unit symbol a schema may declare, grouped by what it measures. */
export const MEASURE_UNITS: Readonly<Record<Dimension, readonly string[]>>

/** `'ms'` → `{ symbol, dimension, factor }`, or `null`. The match is exact and case-sensitive. */
export function unitInfo(symbol: unknown): UnitInfo | null

/** Is this a unit this framework knows? Exact match. */
export function isKnownUnit(symbol: unknown): boolean

/** The base unit of a dimension (`'s'`, `'B'`, `'m'`, `'g'`, `'px'`, `'1'`), or `null`. */
export function baseUnit(dimension: unknown): string | null

/** The known unit a misspelling most likely meant, by case alone: `'MS'` → `'ms'`. Otherwise `null`. */
export function suggestUnit(symbol: unknown): string | null

/** Convert between two units of one dimension. Throws across dimensions and on a calendar unit. */
export function convertUnit(value: number | string, from: string, to: string): number
