// Who walked in. A figure in presence carries a member id; the client reads
// the nick here. Created by the login (`IDEAS/haven.md` 1.3), so no create.
import { createService } from '@frontierjs/junction'

export function createMembersService () {
  return createService({ model: 'Member', methods: ['find', 'get', 'patch'] })
}
