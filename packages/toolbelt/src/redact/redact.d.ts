/*
 * redact.d.ts — the kit's types, hand-written.
 *
 * This package is plain JS with no build step. A kit imported by a TypeScript
 * package needs a declaration or it is a TS7016 in that package's build, and
 * junction — which is TypeScript and whose `tsc` an app can run — is the caller.
 * Same reason as `/gate` and `/query`.
 */

/** The normalised credential name set: lower-cased, `-` and `_` removed. */
export const SECRET_KEY_NAMES: ReadonlySet<string>

/** What a redacted value reads as. */
export const REDACTED: '[redacted]'

/** Is this key name a credential by convention? Case- and separator-insensitive. */
export function isSecretKey(name: string): boolean

/** Is this ENVIRONMENT VARIABLE name a credential? Matched per `_`-segment. */
export function isSecretEnvName(name: string): boolean

/**
 * A copy of `value` with every key `isSecret` answers true for replaced.
 * Cycles answer `'[circular]'`; a non-plain object is returned untouched.
 */
export function redactBy(
  value:    unknown,
  isSecret: (key: string) => boolean,
  seen?:    WeakSet<object>
): unknown

/** `redactBy` with the credential name list. */
export function redactSecrets(value: unknown): unknown

/** A URL string with its password removed and its user and host kept. */
export function redactUrl(text: string): string
export function redactUrl<T>(text: T): T

/** A value safe to quote back in a message about it. */
export function redactValue(value: unknown): unknown
