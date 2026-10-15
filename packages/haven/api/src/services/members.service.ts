// Who walked in. A figure in presence carries a member id; the client reads
// the nick here. Created by the login (`IDEAS/haven.md` 1.3), so no create.
// `inventory` is what the caller carries (`api/src/inventory.ts`): it is kept in
// memory and is nobody's but the caller's, so the call names no member.
import { createService, $, BadRequest } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'

export function createMembersService (app: HavenApp) {
  return createService({
    model:   'Member',
    methods: ['find', 'get', 'patch', 'inventory'],

    /** `{ arrow: 7 }` — a count per item the caller holds. */
    async inventory () {
      const me = Number(($.auth?.user as { userId?: string } | undefined)?.userId)
      if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is carrying anything')
      $.dispatch = false
      return app.inventory.held(me)
    },
  })
}
