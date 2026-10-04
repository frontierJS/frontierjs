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

/** A day in no zone — 'YYYY-MM-DD', what a `String @date` column holds. */
export type PlainDate = string

/** Temporal's `PlainDate.add` fields. Integers, all one sign. */
export interface DateDuration {
  years?:  number
  months?: number
  weeks?:  number
  days?:   number
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
/** Where `timeZone`'s UTC offset is constant across `[from, to]`: each span's offset (ms east of UTC) holds from its `from` (epoch ms) until the next span's. */
export function offsetSpans(from: InstantInput, to: InstantInput, timeZone: string): { from: number; offset: number }[]
export function resolveWall(fields: WallFields, timeZone: string): number[]
export function fromWall(fields: WallFields, timeZone: string, options?: { disambiguation?: Disambiguation }): number
export function format(instant: InstantInput, pattern: string, options: FormatOptions): string
export function relative(instant: InstantInput, now: InstantInput, options?: RelativeOptions): string
export function plainDateIn(instant: InstantInput, timeZone: string): PlainDate
export function addToDate(date: PlainDate, duration: DateDuration): PlainDate
export function daysBetween(from: PlainDate, to: PlainDate): number
export function startOfDay(date: PlainDate, timeZone: string): number

/** A `.lite` `@@commitment` as `x-commitments` carries it. */
export interface CommitmentTime {
  on:     string
  kind:   'instant' | 'day'
  offset: null
        | { sign: 1 | -1; value: number; unit: string }
        | { sign: 1 | -1; field: string; unit: string }
}
/** When the commitment falls due on `row` — ISO text for an instant, 'YYYY-MM-DD' for a day, null when not owed yet. */
export function dueAt(commitment: CommitmentTime, row: Record<string, unknown> | null | undefined): string | null

export interface Datetime {
  readonly locale:   string
  readonly timeZone: string
  format(instant: InstantInput, pattern: string, options?: Partial<FormatOptions>): string
  partsIn(instant: InstantInput, timeZone?: string): WallParts
  resolveWall(fields: WallFields, timeZone?: string): number[]
  fromWall(fields: WallFields, options?: { disambiguation?: Disambiguation; timeZone?: string }): number
  relative(instant: InstantInput, now: InstantInput, options?: RelativeOptions): string
  relativeToNow(instant: InstantInput, options?: RelativeOptions): string
  plainDateIn(instant: InstantInput, timeZone?: string): PlainDate
  startOfDay(date: PlainDate, timeZone?: string): number
  /** The day `now()` falls on in the instance's zone, or the one given. */
  today(timeZone?: string): PlainDate
}

export function createDatetime(options: {
  timeZone: string
  /** The app's clock — `Date.now`. The kit reads none of its own. */
  now:      () => number | Date | string
  locale?:  string
}): Readonly<Datetime>
