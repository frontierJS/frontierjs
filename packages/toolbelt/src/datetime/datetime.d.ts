/*
 * datetime.d.ts — the kit's types, hand-written.
 *
 * Caravan is TypeScript and reads a zone's wall clock for cron; without a
 * declaration its typecheck infers `{}` for these exports, and a `WallParts`
 * field misspelled there would pass.
 */

/** Epoch milliseconds, a valid Date, or an ISO string carrying `Z` or an offset. */
export type InstantInput = number | Date | string

/** A wall clock with no zone. Unset time fields are 0. */
export interface WallFields {
  year:         number
  month:        number
  day:          number
  hour?:        number
  minute?:      number
  second?:      number
  millisecond?: number
}

export interface WallParts {
  year:        number
  month:       number
  day:         number
  hour:        number
  minute:      number
  second:      number
  millisecond: number
  /** ISO: Monday 1 … Sunday 7. */
  weekday:     number
  /** Whole minutes east of UTC; Denver in summer is -360. */
  offset:      number
}

export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject'

export interface FormatOptions {
  /** IANA name. Required — a host-zone fallback renders differently on server and browser. */
  timeZone: string
  /** Reaches month, weekday, day-period and zone NAMES only; digits stay Latin. Default en-US. */
  locale?:  string
}

export interface RelativeOptions {
  locale?: string
  style?:  'long' | 'short' | 'narrow'
}

export function partsIn(instant: InstantInput, timeZone: string): WallParts
export function resolveWall(fields: WallFields, timeZone: string): number[]
export function fromWall(fields: WallFields, timeZone: string, options?: { disambiguation?: Disambiguation }): number
export function format(instant: InstantInput, pattern: string, options: FormatOptions): string
export function relative(instant: InstantInput, now: InstantInput, options?: RelativeOptions): string

export interface Datetime {
  readonly locale:   string
  readonly timeZone: string
  format(instant: InstantInput, pattern: string, options?: Partial<FormatOptions>): string
  partsIn(instant: InstantInput, timeZone?: string): WallParts
  resolveWall(fields: WallFields, timeZone?: string): number[]
  fromWall(fields: WallFields, options?: { disambiguation?: Disambiguation; timeZone?: string }): number
  relative(instant: InstantInput, now: InstantInput, options?: RelativeOptions): string
  relativeToNow(instant: InstantInput, options?: RelativeOptions): string
}

export function createDatetime(options: {
  timeZone: string
  /** The app's clock — `Date.now`. The kit reads none of its own. */
  now:      () => number | Date | string
  locale?:  string
}): Readonly<Datetime>
