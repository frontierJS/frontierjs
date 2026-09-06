/*
 * cron.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. Every other kit gets away with
 * that because its consumers set `allowJs`; this one is read by Caravan and by
 * Junction's scheduler, which are TypeScript and whose own typecheck infers `{}`
 * for a JS export with no declaration — the field sets then satisfy nothing.
 */

export type CronFieldKey = 'minutes' | 'hours' | 'date' | 'month' | 'day'

/** Every value each field admits, computed at parse. */
export type CronFields = Record<CronFieldKey, Set<number>>

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
}

export const CRON_FIELDS: readonly CronFieldDef[]

/**
 * A five-field cron expression into the values each field admits.
 *
 * Throws on anything it cannot mean, naming the field and the bound.
 */
export function parseCron(line: string): CronFields

/** Does this clock reading match? */
export function cronMatches(fields: CronFields, parts: CronParts): boolean
