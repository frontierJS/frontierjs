// api/src/principal.ts
// The one read of a member's ban, for a request and for a socket frame alike.
//
// `bannedAt` is `@guarded`, so the schema cannot declare it as a claim read off
// the row, and a session carries what was true at sign-in. Read per call
// instead: a ban lands on the member's next request and their next frame.

import type { PrincipalResolver } from '@frontierjs/junction'

type Db = { asSystem: () => any }

export async function bannedAtOf (db: Db, userId: string | number | undefined): Promise<string | null> {
  if (userId == null) return null
  const row = await db.asSystem().member.findFirst({ where: { id: Number(userId) }, select: { bannedAt: true } })
  return row?.bannedAt ?? null
}

/** `createApp({ principal })` — puts `bannedAt` on every signed-in caller. */
export function banned (db: Db): PrincipalResolver {
  return async function banned (_ctx, user) {
    return user ? { bannedAt: await bannedAtOf(db, user.userId) } : {}
  }
}
