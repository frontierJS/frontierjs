/*
 * env.d.ts — the kit's types, hand-written. Junction is a TypeScript caller.
 */

export type EnvSource =
  | { value: string | undefined }
  | { file: string; fileKey: string }
  | { error: string }

/** `{ value }` for the variable, `{ file, fileKey }` to read, or `{ error }` when both are set. */
export function envSource(key: string, env: Record<string, string | undefined>): EnvSource

/** A file's text as the key's value: trailing newlines dropped, empty is unset. */
export function fileValue(text: string): string | undefined
