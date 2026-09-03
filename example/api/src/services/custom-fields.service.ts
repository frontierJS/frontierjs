import { createBaseService, $ } from '@frontierjs/junction'
import { allocateSlot }         from '../domain/shop/custom-fields.ts'

// `CustomField` is a model, so it gets a service and derived CRUD like every
// other one. The only thing this file adds is the slot.
//
// It is a HOOK and not a `create` override. The override this replaced existed
// for one reason — `slot` is `@system`, so the write has to name it — and it
// paid for that with the whole of the derived create: `$select`/`$include`, the
// bulk protocol, the not-found and shape rules. It also had the signature
// wrong, taking the payload where an override is handed the CONTEXT, so
// `POOL[ctx.type]` was undefined and every declaration over HTTP was a 500 for
// the life of the feature (`FJS-660`) — invisible because `verify:custom-fields`
// is a bun drive that writes through the client and never calls the service.
//
// `ctx.system.add('slot')` is what makes the hook enough (`FJS-644`). It keeps
// the gate, the row policies, `@@softDelete` and the audit actor, where
// `asSystem()` would drop all four in order to set one column.
export function createCustomFieldsService() {
  return createBaseService({
    model:   'CustomField',
    channel: 'customFields',

    hooks: {
      /**
       * Bind this declaration to a pooled column, if one is free.
       *
       * `validated:` because the slot is chosen from `type`, which has to be a
       * value the model accepts before it can index `POOL` — and because it
       * reads the database, which wants a caller the gate has already graded.
       *
       * A full pool is NOT an error. The row is written with `slot: null` and
       * the field stores, displays and edits exactly like the others; only an
       * audience naming it degrades to a scan, which `customers.segment`
       * reports as `unindexed` and the settings screen says out loud. Refusing
       * here would tell a shop about a pool they cannot see and cannot enlarge.
       */
      validated: {
        create: [async ctx => {
          const declared = await $.db.customField.findMany({})
          ctx.data.slot  = allocateSlot(declared, ctx.data.type as 'text' | 'number')
          ctx.system.add('slot')
        }],
      },
    },
  })
}
