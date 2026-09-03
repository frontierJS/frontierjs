// api/src/domain/shop/custom-fields.ts — the one owner of the translation
// between a key a SHOP invented and a column the schema declared.
//
// Three functions, and they are one fact read three ways: `allocateSlot` binds a
// key to a pooled column, `projectSlots` re-keys a payload into `Customer.slots`,
// `compileSegment` rewrites an audience's terms into a `where`. Anything that
// learns two of the three is a screen showing values that no query can find —
// which is silent, because both halves look correct on their own.
//
// It is pure and takes no client, so `verify:custom-fields` can assert the
// allocation and the compilation without a database, and the service is the only
// thing that has to know where a `CustomField` row comes from.
//
// ─── Why a compiled `where` and not SQL ───────────────────────────────────
//
// The output is an ordinary litestone `where` over declared columns. That keeps
// the model's `@@gate`, both row policies and `@@softDelete` on a segment for
// free, and it is why `IDEAS/scoped-sql.md`'s refusal — raw SQL is `asSystem()`
// only — costs this feature nothing. A segment builder that emitted SQL would
// have had to re-derive every one of those rules in application code.

import { matchesQuery } from '@frontierjs/toolbelt/match'

/** `CustomFieldType` as the seed declares it. */
export type CustomFieldType = 'text' | 'number'

/** A `CustomField` row, narrowed to what this module reads. */
export type CustomField = {
  key:  string
  type: CustomFieldType
  slot: string | null
}

/**
 * The pool, exactly as `Customer` declares it, in the order a slot is handed
 * out. Order is load-bearing rather than cosmetic: the model carries ONE
 * composite index and a leading prefix is what serves a one- or two-term
 * segment, so the field a shop declares first has to land leftmost.
 *
 * Twelve single-column indexes were measured at 139 ms on a three-term segment
 * against the composite's 2.7 ms — SQLite picks one index and filters the rest,
 * which is the same sentence that sinks the index-sidecar design.
 */
export const POOL: Record<CustomFieldType, readonly string[]> = {
  text:   ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
  number: ['n1', 'n2', 'n3', 'n4'],
}

/**
 * Which pooled column a newly-declared field takes, or `null` when its pool is
 * full.
 *
 * `null` is an answer and not a failure. The field still stores, still displays
 * and still edits; only a segment naming it degrades to a scan, and the service
 * says so rather than pretending. Refusing the declaration instead would tell a
 * shop about an implementation detail they can neither see nor act on.
 */
export function allocateSlot(declared: CustomField[], type: CustomFieldType): string | null {
  const taken = new Set(declared.map(d => d.slot).filter(Boolean))
  return POOL[type].find(slot => !taken.has(slot)) ?? null
}

/**
 * The slot-keyed mirror of a customer's `fields`, rebuilt whole on every save.
 *
 * Whole rather than merged, because a key REMOVED from `fields` has to leave the
 * mirror too — merging would leave the old value in its slot and a segment would
 * keep matching a row that no longer holds the value.
 *
 * An unpromoted or absent key is omitted rather than written as null: a missing
 * JSON path and a null one both read as NULL through `json_extract`, so writing
 * it costs bytes on every row and buys nothing.
 */
export function projectSlots(
  fields:   Record<string, unknown> | null | undefined,
  declared: CustomField[],
): Record<string, unknown> {
  const slots: Record<string, unknown> = {}
  if (!fields) return slots

  for (const def of declared) {
    if (!def.slot) continue
    const value = fields[def.key]
    if (value === undefined || value === null || value === '') continue

    // The column's affinity is REAL or TEXT and nothing coerces on the way in,
    // so a number arriving as a string would sort as text and compare wrong.
    if (def.type === 'number') {
      const n = Number(value)
      if (Number.isFinite(n)) slots[def.slot] = n
    } else {
      slots[def.slot] = String(value)
    }
  }
  return slots
}

/** One condition of an audience, in the shop's own vocabulary. */
export interface SegmentTerm {
  key:   string
  op:    'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith'
  value: unknown
}

export interface CompiledSegment {
  /** Ready for `db.customer.findMany({ where })` — gate and policies still apply. */
  where:     Record<string, unknown>
  /** Terms on a field that exists but holds no slot. The caller decides. */
  unindexed: SegmentTerm[]
  /** Keys no `CustomField` row declares. The caller should refuse. */
  unknown:   string[]
}

/**
 * An audience's terms → a litestone `where`.
 *
 * A term on an UNPROMOTED field is returned in `unindexed` rather than dropped.
 * Dropping it would widen the audience in silence, which is the one failure mode
 * that cannot be seen from either side: the request succeeds, the count looks
 * plausible, and a discount goes to people it was never meant for.
 */
/**
 * The shape map `matchesQuery` needs, built from the pool rather than from the
 * JSON Schema.
 *
 * The pool's types are a fact about this module — a `t` slot is TEXT and an `n`
 * slot is REAL — so deriving them here keeps this file pure and keeps the two
 * readers of a segment reading the same table.
 */
export const SLOT_SHAPES: Record<string, { type: string; nullable: true }> =
  Object.fromEntries([
    ...POOL.text  .map(s => [s, { type: 'string', nullable: true as const }]),
    ...POOL.number.map(s => [s, { type: 'number', nullable: true as const }]),
  ])

export function compileSegment(terms: SegmentTerm[], declared: CustomField[]): CompiledSegment {
  const byKey     = new Map(declared.map(d => [d.key, d]))
  const where:     Record<string, unknown> = {}
  const unindexed: SegmentTerm[] = []
  const unknown:   string[]      = []

  for (const term of terms) {
    const def = byKey.get(term.key)
    if (!def)      { unknown.push(term.key); continue }
    if (!def.slot) { unindexed.push(term);   continue }

    const value = def.type === 'number' ? Number(term.value) : term.value

    // Two terms on one field would overwrite each other as plain keys, so the
    // second and later ones are ANDed the way litestone spells it.
    const existing = where[def.slot]
    const clause   = term.op === 'eq' ? value : { [term.op]: value }
    where[def.slot] = existing === undefined
      ? clause
      : { ...(typeof existing === 'object' && existing !== null ? existing : { equals: existing }),
          ...(typeof clause   === 'object' ? clause : { equals: clause }) }
  }

  return { where, unindexed, unknown }
}

/**
 * Is THIS customer in that audience?
 *
 * The second reader of a compiled segment, and the reason `compileSegment`
 * answers a `where` rather than SQL: the same object that goes to
 * `findMany({ where })` for the list goes to `matchesQuery` for one row, so a
 * shopper at checkout and a merchant reading the audience cannot be told
 * different things by two implementations of one rule.
 *
 * Three-valued like `matchesQuery` itself. `null` means undecidable from this
 * record — the row arrived through a `select` that dropped a slot column, which
 * is the case a boolean would have to guess at, and guessing wrong here either
 * refuses a valid code or honours an invalid one.
 */
export function matchesAudience(
  where:    Record<string, unknown>,
  customer: Record<string, unknown> | null | undefined,
): boolean | null {
  if (!where || Object.keys(where).length === 0) return true   // no audience is everybody
  if (!customer) return null
  return matchesQuery(SLOT_SHAPES, customer, where)
}
