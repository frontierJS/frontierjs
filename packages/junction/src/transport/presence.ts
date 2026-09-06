// transport/presence.ts
// Presence tracking for channels — who is in which channel, with join /
// sync / leave broadcasts. Extracted from channels.ts (which had grown to
// ~750 lines of unrelated concerns); the manager injects its own send
// primitives so this module owns state + protocol only.

import type { Connection, PresenceMember } from './channels.ts'

export interface PresenceDeps {
  broadcast:  (channelId: string, excludeConnId: string | null, event: string, data: unknown) => void
  sendToConn: (conn: Connection, event: string, data: unknown) => void
  /**
   * How long join and leave events are held before one `presence:diff` goes
   * out to the channel. 0 sends each one immediately, which is what shipped.
   *
   * A timer and not a microtask: every socket opens in its own tick, so a
   * reconnect storm is N separate ticks and a microtask batch would coalesce
   * nothing. Presence is an affordance — a member appearing 50ms late is not a
   * failure, and it is the difference between N frames per join and one per
   * flush.
   */
  flushMs?:   number
}

export function createPresenceTracker(deps: PresenceDeps) {
  const presence = new Map<string, Map<string, PresenceMember>>()

  // Pending join/leave per channel, and the timer that will flush it.
  const pending = new Map<string, {
    joined: PresenceMember[]
    left:   PresenceMember[]
    timer:  ReturnType<typeof setTimeout>
  }>()

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

  /**
   * Put one join or leave on the channel's pending diff.
   *
   * A connection that joins and leaves inside one window cancels out and no
   * frame goes at all — which is what a flapping socket is, and announcing
   * both halves of it is the amplifier this exists to remove.
   */
  function queueDiff(channelId: string, kind: 'joined' | 'left', member: PresenceMember): void {
    const flushMs = deps.flushMs ?? 50
    if (flushMs <= 0) {
      deps.broadcast(channelId, kind === 'joined' ? member.connectionId : null,
        kind === 'joined' ? 'presence:join' : 'presence:leave', { channelId, member })
      return
    }

    let p = pending.get(channelId)
    if (!p) {
      p = { joined: [], left: [], timer: setTimeout(() => flushDiff(channelId), flushMs) }
      // The timer must not hold the process open: a channel with a pending
      // diff would otherwise keep a shutting-down app alive for the window.
      p.timer.unref?.()
      pending.set(channelId, p)
    }

    const other = kind === 'joined' ? p.left : p.joined
    const at    = other.findIndex(m => m.connectionId === member.connectionId)
    if (at !== -1) { other.splice(at, 1); return }

    p[kind].push(member)
  }

  function flushDiff(channelId: string): void {
    const p = pending.get(channelId)
    if (!p) return
    pending.delete(channelId)
    clearTimeout(p.timer)
    if (p.joined.length === 0 && p.left.length === 0) return

    // Excludes nobody: a joiner already has the full roster from its own
    // `presence:sync`, and a batch is about several connections at once, so
    // there is no single connection to leave out.
    deps.broadcast(channelId, null, 'presence:diff', {
      channelId, joined: p.joined, left: p.left,
    })
  }

  /** Flush everything now — for shutdown, and for a test that cannot wait. */
  function flushAll(): void {
    for (const channelId of [...pending.keys()]) flushDiff(channelId)
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

    // Send presence:sync to the new member — full list including themselves.
    //
    // `you` is which of those members the recipient IS. A sync is the only
    // frame sent to exactly one connection, so it is the only one that can
    // carry it — and without it a client cannot split the roster into self and
    // others at all, because nothing else tells a browser its connection id.
    deps.sendToConn(conn, 'presence:sync', {
      channelId,
      you:     conn.id,
      members: presenceMembers(channelId),
    })

    // Batched: N joins used to be N x (N-1) frames.
    queueDiff(channelId, 'joined', member)
  }

  function presenceLeave(conn: Connection, channelId: string): void {
    const map    = presence.get(channelId)
    const member = map?.get(conn.id)
    if (!member) return

    map!.delete(conn.id)
    if (map!.size === 0) presence.delete(channelId)

    queueDiff(channelId, 'left', member)
  }


  return {
    presenceFor,
    members:  presenceMembers,
    get:      presenceGet,
    byUser:   presenceByUser,
    join:     presenceJoin,
    leave:    presenceLeave,
    flushAll,
  }
}
