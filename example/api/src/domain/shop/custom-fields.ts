// api/src/domain/shop/custom-fields.ts — the one owner of the translation
// between a key a SHOP invented and a query the boundary can answer.
//
// Two functions, and they are one fact read two ways: `compileSegment` rewrites
// an audience's terms into a `where`, `matchesAudience` asks the same terms of
// ONE row. Anything that learns one of them and not the other is a discount
// advertised to somebody the checkout then declines — which is silent, because
// both halves look correct on their own.
//
// **Nothing here knows a slot exists.** `Customer` declares
// `@@extensible(fields, declaredBy: CustomField, max: { text: 8, number: 4 })`
// and `Product` declares the same word without the `max:`, so the pool, its
// order, the mirror kept beside it and the slot each declaration takes are all
// the Data boundary's. This file used to carry an allocator, a projector and a
// pool derived by parsing `db/schema.lite` back out — the schema's own facts,
// restated where they could drift, and drift there is invisible: an index
// changes no answer.
//
// What is left is the half the framework cannot have, because it is a policy
// rather than a mechanism: a term on a field this shop declared and did not get
// a slot for is REPORTED rather than refused. The boundary refuses one, and it
// is right to — there is no index to read it by. A merchant building an
// audience needs to be told which of their terms did not apply, which is a
// sentence and not an error.
//
// It is pure and touches no client and no file, so `verify:custom-fields` can
// assert the compilation without a database, and the service is the only thing
// that has to know where a `CustomField` row comes from.
//
// ─── Why a compiled `where` and not SQL ───────────────────────────────────
//
// The output is an ordinary litestone `where` over the tenant's own keys. That
// keeps the model's `@@gate`, both row policies and `@@softDelete` on a segment
// for free, and it is why `IDEAS/scoped-sql.md`'s refusal — raw SQL is
// `asSystem()` only — costs this feature nothing. A segment builder that
// emitted SQL would have had to re-derive every one of those rules in
// application code.

import { matchesQuery } from '@frontierjs/toolbelt/match'

/** `CustomFieldType` as the seed declares it. */
export type CustomFieldType = 'text' | 'number'

/** A `CustomField` row, narrowed to what this module reads. */
export type CustomField = {
  key:  string
  type: CustomFieldType
  slot: string | null
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
 * Nested under the blob column and written in the SHOP's own keys, which is the
 * shape `@@extensible` reads: the slot is chosen and rewritten at the Data
 * boundary, so nothing above it can be handed a stale one. Under the column
 * rather than bare because the declarations are DATA — a shop could declare
 * `name` tomorrow, and a bare key would shadow the real column or be shadowed
 * by it depending on which won.
 *
 * A term on an UNPROMOTED field is returned in `unindexed` rather than included.
 * The boundary refuses one and is right to: there is no index to read it by. But
 * refusing the whole audience would take a merchant's other four terms with it,
 * so the promoted terms are applied and the rest are HANDED BACK. Dropping them
 * silently is the one failure mode nothing downstream can see — the request
 * succeeds, the count looks plausible, and a discount goes to people it was
 * never meant for.
 */
export function compileSegment(
  terms:    SegmentTerm[],
  declared: CustomField[],
  blob      = 'fields',
): CompiledSegment {
  const byKey     = new Map(declared.map(d => [d.key, d]))
  const keys:      Record<string, unknown> = {}
  const unindexed: SegmentTerm[] = []
  const unknown:   string[]      = []

  for (const term of terms) {
    const def = byKey.get(term.key)
    if (!def)      { unknown.push(term.key); continue }
    if (!def.slot) { unindexed.push(term);   continue }

    // The promoted column's affinity is REAL or TEXT, so a number arriving as a
    // string would compare as text.
    const value = def.type === 'number' ? Number(term.value) : term.value

    // Two terms on one field would overwrite each other as plain keys, so the
    // second and later ones are ANDed the way litestone spells it.
    const existing = keys[term.key]
    const clause   = term.op === 'eq' ? value : { [term.op]: value }
    keys[term.key] = existing === undefined
      ? clause
      : { ...(typeof existing === 'object' && existing !== null ? existing : { equals: existing }),
          ...(typeof clause   === 'object' ? clause : { equals: clause }) }
  }

  // `{}` and not `{ fields: {} }` — an empty object under the column is a
  // comparison of the document against nothing, where no audience at all is
  // every row.
  const where = Object.keys(keys).length ? { [blob]: keys } : {}
  return { where, unindexed, unknown }
}

/**
 * Is THIS customer in that audience?
 *
 * The second reader of a compiled segment, and the reason `compileSegment`
 * answers a `where` rather than SQL: the same object that goes to
 * `findMany({ where })` for the list is read here for ONE row, so a shopper at
 * checkout and a merchant reading the audience cannot be told different things
 * by two implementations of one rule.
 *
 * It reads the BLOB and not the promoted columns, which is what makes it the
 * same function for a model with a pool and a model without one: `fields` is on
 * every row that has any, where a slot column exists only where `max:` does.
 *
 * Three-valued like `matchesQuery` itself. `null` means undecidable from this
 * record — the row arrived through a `select` that dropped the blob, which is
 * the case a boolean would have to guess at, and guessing wrong here either
 * refuses a valid code or honors an invalid one.
 */
export function matchesAudience(
  declared: CustomField[],
  where:    Record<string, unknown>,
  customer: Record<string, unknown> | null | undefined,
  blob      = 'fields',
): boolean | null {
  if (!where || Object.keys(where).length === 0) return true   // no audience is everybody
  if (!customer) return null

  const terms = where[blob] as Record<string, unknown> | undefined
  if (!terms) return null
  // Absent is undecidable; an empty blob is a decidable no. `null` and `{}` are
  // both legitimate stored values, so the test is key presence.
  if (!(blob in customer)) return null
  const values = (customer[blob] ?? {}) as Record<string, unknown>

  // The shape map comes from the same declarations `compileSegment` read, so the
  // two readers of one segment cannot be handed different types.
  const shapes = Object.fromEntries(declared
    .map(d => [d.key, { type: d.type === 'number' ? 'number' : 'string', nullable: true as const }]))

  return matchesQuery(shapes, values, terms)
}
