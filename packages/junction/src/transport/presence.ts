// transport/presence.ts
// Presence tracking for channels — who is in which channel, with join /
// sync / leave broadcasts. Extracted from channels.ts (which had grown to
// ~750 lines of unrelated concerns); the manager injects its own send
// primitives so this module owns state + protocol only.

import type { Connection, PresenceMember } from './channels.ts'

export interface PresenceDeps {
  broadcast:  (channelId: string, excludeConnId: string | null, event: string, data: unknown) => void
  sendToConn: (conn: Connection, event: string, data: unknown) => void
}

export function createPresenceTracker(deps: PresenceDeps) {
  const presence = new Map<string, Map<string, PresenceMember>>()

  function presenceFor(channelId: string): Map<string, PresenceMember> {
    let map = presence.get(channelId)
    if (!map) { map = new Map(); presence.set(channelId, map) }
    return map
  }

  function presenceMembers(channelId: string): PresenceMember[] {
    return Array.from(presenceFor(channelId).values())
  }

  // ── Lookups ────────────────────────────────────────────────────────────
  // This module owns the `presence` Map, so every read of it lives here.
  // channels.ts used to reach for a bare `presence` identifier in its own
  // scope — which does not exist there (the tracker is `_presence`, and its
  // Map is private). Both `presenceOf()` and `_presenceGet()` threw
  // `ReferenceError: presence is not defined` on every call, so presence
  // never worked at all and the WS `subscribe` handler crashed on the line
  // that looked up the member. Delegating instead of re-reaching keeps that
  // from coming back.

  /**
   * One member, by channel and connection. Read-only: unlike presenceFor(),
   * this does NOT create an empty channel map as a side effect — a lookup for
   * a channel nobody has joined should not allocate one.
   */
  function presenceGet(channelId: string, connId: string): PresenceMember | undefined {
    return presence.get(channelId)?.get(connId)
  }

  /** Every membership for one user, across all channels. */
  function presenceByUser(userId: string | number): PresenceMember[] {
    const results: PresenceMember[] = []
    for (const memberMap of presence.values()) {
      for (const member of memberMap.values()) {
        if (member.userId === userId) results.push(member)
      }
    }
    return results
  }

  function presenceJoin(conn: Connection, channelId: string): void {
    const session = conn.user
    if (!session?.userId) return   // anonymous — not tracked

    const meta = conn.__joinMeta ?? {}
    const member: PresenceMember = {
      connectionId: conn.id,
      userId:       session.userId,
      channelId,
      joinedAt:     new Date(),
      meta,
    }

    presenceFor(channelId).set(conn.id, member)

    // Send presence:sync to the new member — full list including themselves
    deps.sendToConn(conn, 'presence:sync', {
      channelId,
      members: presenceMembers(channelId),
    })

    // Broadcast presence:join to all other members
    deps.broadcast(channelId, conn.id, 'presence:join', { channelId, member })
  }

  function presenceLeave(conn: Connection, channelId: string): void {
    const map    = presence.get(channelId)
    const member = map?.get(conn.id)
    if (!member) return

    map!.delete(conn.id)
    if (map!.size === 0) presence.delete(channelId)

    // Broadcast presence:leave to remaining members
    deps.broadcast(channelId, null, 'presence:leave', { channelId, member })
  }


  return {
    presenceFor,
    members: presenceMembers,
    get:     presenceGet,
    byUser:  presenceByUser,
    join:    presenceJoin,
    leave:   presenceLeave,
  }
}
