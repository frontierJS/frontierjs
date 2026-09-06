/*
 * gate.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. Most kits are imported from a
 * package whose tsconfig sets `allowJs`, which is what `@frontierjs/config`
 * gives an app. This one is re-exported from `@frontierjs/junction`, whose
 * public type surface an app may compile under its OWN options — so a kit with
 * no declaration is a TS7016 in somebody else's build. Same reason as `/query`.
 */

/** The 0–9 ladder. 0–7 are rungs; 8 and 9 are sentinels. */
export const LEVELS: Readonly<{
  STRANGER:      0
  VISITOR:       1
  READER:        2
  CREATOR:       3
  USER:          4
  ADMINISTRATOR: 5
  OWNER:         6
  SYSADMIN:      7
  SYSTEM:        8
  LOCKED:        9
}>

/** The name a schema may write instead of a digit. Derived from `LEVELS`. */
export const LEVEL_NAMES: Readonly<Record<string, number>>

/** `4 → 'USER'`, for a message somebody has to read. */
export function levelName(level: number): string

/**
 * Does a caller at `userLevel` pass a gate of `required`?
 * 9 refuses everything, 8 admits only 8, everything else is `>=`.
 */
export function levelPasses(required: number, userLevel: number): boolean

/**
 * The session shape the ladder grades. Every field is optional, because absence
 * is a meaningful answer: it means the app does not model that stage.
 *
 * Structural, and with NO index signature. Both halves are load-bearing: it has
 * to be a supertype of Junction's `SessionContext` and of Litestone's
 * `LitestoneAuth` so one grader serves both without either package importing the
 * other's types — and a `[key: string]: unknown` here would defeat that, since
 * TypeScript gives an interface no implicit index signature and `SessionContext`
 * would stop being assignable.
 */
export interface GradableUser {
  verifiedAt?:    Date | string | null
  activatedAt?:   Date | string | null
  isAdmin?:       boolean
  isOwner?:       boolean
  isSystemAdmin?: boolean
  role?:          string | null
}

/** A caller's standing. Explicit standing first, then lifecycle, then `role`. */
export function gradeStanding(user?: GradableUser | null): number
