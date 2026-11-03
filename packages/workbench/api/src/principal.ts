// api/src/principal.ts
// The one read of a member's standing for a request and for a socket frame
// alike. Workbench has one tier -- the signed-in member -- so the standing is
// only that the row still exists: a session outliving its member is no
// principal.

import type { PrincipalResolver } from '@frontierjs/junction'

type Db = { asSystem: () => any }

/** `createApp({ principal })` -- puts the member on every signed-in caller. */
export function standing (db: Db): PrincipalResolver {
  return async function standing (_ctx, user) {
    if (!user) return {}
    const row = await db.asSystem().member.findFirst({ where: { id: Number(user.id) }, select: { id: true, nick: true } })
    return row ? { nick: row.nick } : {}
  }
}
