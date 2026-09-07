/*
 * cron.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. Every other kit gets away with
 * that because its consumers set `allowJs`; this one is read by Caravan and by
 * Junction's scheduler, which are TypeScript and whose own typecheck infers `{}`
 * for a JS export with no declaration — the field sets then satisfy nothing.
 */

export type CronFieldKey = 'minutes' | 'hours' | 'date' | 'month' | 'day'

/**
 * Every value each field admits, computed at parse — plus which fields were
 * WRITTEN as a star, which is what decides whether the two date fields OR.
 * Cron's own test is the first character, so `0-6` names every day and is not
 * a star; see `cronMatches`.
 */
export type CronFields = { [K in CronFieldKey]: Set<number> } & {
  stars: Set<CronFieldKey>
}

/** A clock reading, as the field names have it: month is 1-12, day is 0-6. */
export type CronParts = Record<CronFieldKey, number>

export interface CronFieldDef {
  key:  CronFieldKey
  name: string
  min:  number
  max:  number
  /** Wider than `max` where a field takes an alias — day of week takes 7. */
  accepts?: number
  /** Applied to every parsed value; folds an alias onto the canonical set. */
  fold?: (v: number) => number
  /**
   * This field's own names, lowercase and in value order — `january` at index
   * 0 for a field whose `min` is 1. Resolved per field and never over the
   * line, or a name written in the wrong one lands as a number.
   */
  names?: readonly string[]
}

export const CRON_FIELDS: readonly CronFieldDef[]

/**
 * A five-field cron expression into the values each field admits.
 *
 * Throws on anything it cannot mean, naming the field and the bound.
 */
export function parseCron(line: string): CronFields

/**
 * Does this clock reading match?
 *
 * Day of month and day of week are OR'd with each other where BOTH are
 * restricted, and AND'd with the other three — cron's own asymmetry, so a line
 * copied out of a crontab schedules here what it scheduled there.
 *
 * Throws where `parts` is missing a key or carries one that is not a whole
 * number. `CronParts` already requires all five, so this bites a JS caller or
 * one whose reading crossed an `any` — where it used to answer `false` for
 * ever instead.
 */
export function cronMatches(fields: CronFields, parts: CronParts): boolean
