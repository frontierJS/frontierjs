// Who walked in. A figure in presence carries a member id; the client reads
// the nick here. Created by the login (`IDEAS/haven.md` 1.3), so no create.
// `inventory` is what the caller carries (`shared/inventory.ts`): it is kept in
// memory and is nobody's but the caller's, so the call names no member.
import { createService, $, BadRequest } from '@frontierjs/junction'

import type { HavenApp } from '../app.ts'

export default createService({
  model:   'Member',
  methods: ['find', 'get', 'patch', 'inventory'],

  /** `{ arrow: 7 }` — a count per item the caller holds. */
  async inventory () {
    const me = Number(($.user as { id?: string } | undefined)?.id)
    if (!Number.isInteger(me)) throw new BadRequest('Walk in first: nobody is carrying anything')
    $.dispatch = false
    return ($.app as HavenApp).inventory.held(me)
  },
})
