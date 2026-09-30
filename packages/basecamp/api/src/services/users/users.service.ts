// src/services/users/users.service.ts
// The caller's own User row — what the profile card on /settings/ reads and
// writes.
//
// `account.get('me')` is auth's and answers the SESSION, which is what a request
// is graded as and not the row: it has no `displayName` or `username`, and
// nothing written to it would reach the table. This is the row.
//
//   get    GET   /users/me
//   patch  PATCH /users/me
//
// **Takes no workspace**, for notification-preferences' reason: a person is in
// several. `User` is `@@tenant(none)`, reads and updates at VISITOR(1), and its
// policies confine both to the caller's own row below USER(4). Which columns a
// person may write about themselves is the schema's field policies, never a
// list here: `email`, `accountId` and the graded columns are dropped at the
// Data boundary, whichever door the write came through.
//
// Only `me`. A list of people is a workspace's members or the hub's, and both
// already exist; a `find` here would be every person on the installation to
// any developer, because `User` is not scoped to a workspace.

import { createService, NotFound, Unauthorized, $ } from '@frontierjs/junction'
import type { ServiceContext }                       from '@frontierjs/junction'
import type { BasecampApp }                          from '../../basecamp.types.ts'

/** `me` is the address, and the caller's own id is accepted as its second
 *  spelling. Any other id is a 404, not a 403: whether it exists is not this
 *  service's to say. */
function ownRow(ctx: ServiceContext): void {
  const me = ($.me as { userId?: string } | null | undefined)?.userId
  // The gate reads at 1 and refuses a stranger first. This is what stops a
  // gate lowered to 0 from turning `me` into an id of undefined.
  if (!me) throw new Unauthorized('Sign in to see your profile')
  if (ctx.id !== 'me' && String(ctx.id) !== me) {
    throw new NotFound(`No user '${ctx.id}' — this service answers for the caller ('me')`)
  }
  ctx.id = me
}

export function createUsersService(_app: BasecampApp) {
  return createService({
    name:    'users',
    model:   'User',
    methods: ['get', 'patch'],
    hooks: {
      before: { all: [ownRow] },
    },
  })
}
