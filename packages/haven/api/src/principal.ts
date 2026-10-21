// api/src/principal.ts
// The one read of a member's standing — the ban and the role — for a request
// and for a socket frame alike.
//
// `role` is `@guarded`, so the schema cannot declare it as a claim read off the
// row, and a session carries what was true at sign-in. Read per call instead:
// a ban lands on the member's next request and their next frame, and a mod
// appointed by the login is a mod on the call after it.

import type { PrincipalResolver } from '@frontierjs/junction'

type Db = { asSystem: () => any }

export type Standing = { bannedAt: string | null, role: string | null }

export async function standingOf (db: Db, userId: string | number | undefined): Promise<Standing> {
  if (userId == null) return { bannedAt: null, role: null }
  const row = await db.asSystem().member.findFirst({ where: { id: Number(userId) }, select: { bannedAt: true, role: true } })
  return { bannedAt: row?.bannedAt ?? null, role: row?.role ?? null }
}

/** `createApp({ principal })` — puts the standing on every signed-in caller. */
export function standing (db: Db): PrincipalResolver {
  return async function standing (_ctx, user) {
    return user ? await standingOf(db, user.id) : {}
  }
}
