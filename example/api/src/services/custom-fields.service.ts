import { createBaseService } from '@frontierjs/junction'

// `CustomField` is a model, so it gets a service and derived CRUD like every
// other one — and now that is the whole file.
//
// It carried a hook that chose the slot. Three things went with the hook when
// `Customer` and `Product` started declaring `@@extensible`: the allocator, the
// pool it allocated out of (derived by parsing `db/schema.lite` back), and
// `ctx.system.add('slot')`. The boundary fills `slot` on create out of the pool
// the named model declares, so a shop declaring a field over HTTP is an
// ordinary create with nothing added.
//
// Two defects lived in that hook and both were invisible from one side
// (`FJS-644`, `FJS-660`): it had junction's signature wrong, taking the payload
// where a hook is handed the CONTEXT, so `POOL[ctx.type]` was undefined and
// every declaration over HTTP was a 500 for the life of the feature; and it
// wrote a `@system` column without saying so, which is a 403. Neither is
// reachable now, because neither is written here.
export function createCustomFieldsService() {
  return createBaseService({
    model:   'CustomField',
    channel: 'customFields',
  })
}
