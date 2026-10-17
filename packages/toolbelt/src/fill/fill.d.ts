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

/** One piece of `source`: literal text (`\{` already `{`), a brace pair, or a `{` that never closes. */
export type Segment = { text: string } | { hole: string; raw: string } | { open: string }

/** The pieces `fill` and `check` read `source` as, in order. */
export function segments(source: string): Generator<Segment>

/** A hole in `source` that could never fill. */
export interface FillProblem { hole: string; message: string }

/** Every refusal for `source` against the closed list `{ owner: ['field', …] }`; empty is clean. */
export function check(source: string, names: Record<string, string[]>): FillProblem[]

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'money'

/** One declared merge field. Keys beyond these ride along for the app's own `filter`. */
export interface MergeField {
  /** `owner.field` -- two dotted names. */
  key: string
  label: string
  description?: string
  /** What the preview shows; a scalar or `{ html, text }`. */
  example?: string | number | boolean | Markup
  /** What a render uses when the data has no value (`undefined`, `null` or `''`). */
  default?: string | number | boolean | Markup
  type: FieldType
  [extra: string]: unknown
}

export interface MergeFields<F extends MergeField = MergeField> {
  /** The fields for an editor's list, in declared order. */
  list(filter?: (field: F) => boolean): F[]
  /** `{ owner: { field: example } }` for a preview. */
  example(filter?: (field: F) => boolean): Record<string, Record<string, unknown>>
  /** The closed list `check` grades against. */
  names(filter?: (field: F) => boolean): Record<string, string[]>
  /** `check(source, names(filter))`. */
  check(source: string, filter?: (field: F) => boolean): FillProblem[]
  /** `data` with each declared default laid under a missing value; `data` is not changed. */
  context(data?: Record<string, unknown>): Record<string, unknown>
  /** `fill` over `context(data)`. */
  fill(source: string, data: Record<string, unknown> | undefined, options: { mode: FillMode }): string
  /** The same fields plus a template row's own; a key declared twice throws. */
  with(more: F[]): MergeFields<F>
}

/** The fields a template may name, declared once; a malformed declaration throws. */
export function mergeFields<F extends MergeField>(declared?: F[]): MergeFields<F>
