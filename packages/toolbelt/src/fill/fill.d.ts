/*
 * fill.d.ts -- the kit's types, hand-written, because orion (TypeScript) reads it.
 */

export type FillMode = 'html' | 'text'

/** A value built as markup: `html` in an HTML body, `text` in a plain one. */
export interface Markup { html: string; text: string }

/**
 * `source` with each `{path}` or `{values expression}` filled from `ctx`. The
 * caller states `mode`; a value is escaped in `html` and plain in `text`. A hole
 * the context cannot fill is left as written.
 */
export function fill(source: string, ctx: Record<string, unknown>, options: { mode: FillMode }): string

/** A hole in `source` that could never fill. */
export interface FillProblem { hole: string; message: string }

/** Every refusal for `source` against the closed list `{ owner: ['field', …] }`; empty is clean. */
export function check(source: string, names: Record<string, string[]>): FillProblem[]
