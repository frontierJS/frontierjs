import { createBaseService, $ }             from '@frontierjs/junction'
import type { ServiceContext }             from '@frontierjs/junction'
import { compileSegment, projectSlots }    from '../domain/shop/custom-fields.ts'
import type { CustomField, SegmentTerm }   from '../domain/shop/custom-fields.ts'

// `notes` is `@allow('read', auth().role == 'admin')` in the schema — a field
// policy, not `@guarded`, which takes no level — so it is stripped from this
// service's responses for anyone the predicate rejects without a line here.
//
// The custom-field half is `api/src/domain/shop/custom-fields.ts`. This file
// owns only WHERE the declarations come from and WHEN the mirror is rebuilt;
// the translation itself is over there, because a segment has to compile in a
// test with no database and no request.
//
// `ctx.system.add('slots')` is what makes the mirror writable from here at all.
// `Customer.slots` is `@system`, so the Data boundary refuses a payload naming
// it; the value is derived rather than sent, and this is the call saying so.
// Without it every customer create and every customer patch carrying `fields`
// is a 403 (`FJS-644`).

/** Every field this shop has declared. One read, reused across a call. */
const declared = (): Promise<CustomField[]> => $.db.customField.findMany({})

/**
 * Re-key this payload's `fields` onto the slot pool, and say who is writing it.
 *
 * The two lines belong together and separating them is the bug: the mirror is
 * derived here, so `slots` is not a value the caller sent, and the Data boundary
 * refuses a `@system` column a payload names unless the call states it.
 */
const rebuildSlots = async (ctx: ServiceContext) => {
  const data = ctx.data as Record<string, unknown>
  data.slots = projectSlots(data.fields as Record<string, unknown> | null, await declared())
  ctx.system.add('slots')
}

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

    hooks: {
      // `validated:` and not `before:`. The mirror is derived from the payload,
      // so it needs a `ctx.data` the validator has already coerced, and it reads
      // the database, so it needs a caller the gate has already graded. Before
      // FJS-D124 there was nowhere in a service to say both.
      validated: {
        // A create and an update both state the whole row, so the mirror is
        // rebuilt from whatever `fields` is — including absent, which projects
        // to `{}` and is what a replace dropping the blob means.
        create: [rebuildSlots],
        update: [rebuildSlots],
        patch:  [async ctx => {
          // Absent means leave the stored blob alone; an explicit null clears it.
          // Testing key presence rather than `??` is Invariant 9 — a `??` here
          // would rebuild the mirror from nothing on every unrelated patch and
          // empty every slot the row held.
          if (!ctx.data || !('fields' in ctx.data)) return
          await rebuildSlots(ctx)
        }],
      },
    },


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
