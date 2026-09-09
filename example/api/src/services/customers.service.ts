import { createBaseService, $ }             from '@frontierjs/junction'
import { compileSegment }                  from '../domain/shop/custom-fields.ts'
import type { CustomField, SegmentTerm }   from '../domain/shop/custom-fields.ts'

// `notes` is `@allow('read', auth().role == 'admin')` in the schema — a field
// policy, not `@guarded`, which takes no level — so it is stripped from this
// service's responses for anyone the predicate rejects without a line here.
//
// The custom-field half is `api/src/domain/shop/custom-fields.ts`. This file
// owns only WHERE the declarations come from; the translation itself is over
// there, because a segment has to compile in a test with no database and no
// request.
//
// It also owned WHEN the slot mirror was rebuilt, on three `validated:` hooks
// that are gone. `Customer` declares `@@extensible(fields, declaredBy:
// CustomField, max: …)`, so the mirror is derived in `writeData` — the one
// funnel every payload passes through — and a create, an update and a patch
// cannot take it in three directions. The hook version was three hand-restated
// copies of one rule and it had already cost a 403: the column is `@system`, so
// deriving it here meant saying `ctx.system.add('slots')` on every one of them,
// and the write that forgot was every customer create over HTTP (`FJS-644`).

/**
 * Every field this shop has declared ON A CUSTOMER. One read, reused across a call.
 *
 * `$declaredFields()` and not a `findMany` over `CustomField`, because the
 * narrowing is the whole of it: one declaring table carries the declarations for
 * every model that has any, and unnarrowed a key declared on a product becomes
 * an accepted segment term over customers that matches nobody. The accessor
 * cannot be widened — the model is the one it was called on.
 */
const declared = (): Promise<CustomField[]> => $.db.customer.$declaredFields()

export function createCustomersService() {
  return createBaseService({
    channel: 'customers',

    // Declaring `methods:` narrows the surface — anything absent answers 405 —
    // so this list is the committed `surface.snapshot.md` verbatim plus the two
    // below it. `restore` is in it because `Customer` soft-deletes and the
    // customers screen has a button for it; leaving it out is a dead button
    // that reports a routing failure as a permissions one.
    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove', 'restore',
      { method: 'segment', input: 'SegmentQuery' },
    ],

    /**
     * Who is in this audience.
     *
     * Answers the rows AND what it could not index, because a term on an
     * unpromoted field is a term this query did not apply: silently widening an
     * audience is how a discount reaches people it was never meant for, and
     * nothing downstream can tell that from a segment that legitimately matches
     * more rows.
     */
    async segment() {
      // A method on a service definition is handed the CONTEXT, exactly like a
      // derived one — `(data, params)` is Feathers' shape and junction does not
      // have it. This read is `$.data` for the same reason every other custom
      // method in this app uses the ambient.
      const { terms, limit } = ($.data ?? {}) as { terms?: SegmentTerm[]; limit?: number }
      const { where, unindexed, unknown } = compileSegment(terms ?? [], await declared())

      if (unknown.length) {
        throw Object.assign(
          new Error(`No custom field named ${unknown.map(k => `'${k}'`).join(', ')}`),
          { status: 400, errors: unknown.map(key => ({ field: 'terms', message: `unknown field '${key}'` })) },
        )
      }

      // An ordinary `where`, so the model's @@gate, both row policies and
      // @@softDelete all still apply — the caller gets the audience they are
      // allowed to see rather than the audience that matched.
      const rows = await $.db.customer.findMany({ where, limit: limit ?? 100 })
      return { rows, unindexed }
    },
  })
}
