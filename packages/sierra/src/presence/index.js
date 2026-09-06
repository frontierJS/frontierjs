/**
 * @frontierjs/sierra/presence — Presence API
 *
 * presence() returns a Sierra signal whose value is:
 *   { members, others, self, count }
 *
 * In Mesa components, `const members = presence(...)` compiles to a reactive
 * const — template reads members.count, members.others etc. stay reactive.
 *
 * WHAT THE SERVER ACTUALLY DOES, because this module spoke to a client that
 * did not exist for its whole life (`FJS-811`):
 *
 *   · Channel MEMBERSHIP is the app's, decided in its own `channels()` setup.
 *     Nothing a browser sends joins a channel, so nothing here can. What
 *     `client.presence.announce()` sends is *here is my meta, send me the
 *     roster*, and a channel this connection was never joined to answers
 *     nothing — in silence, which is why a screen showing no members is the
 *     shape to expect when a channel is misspelled or presence is not enabled
 *     for it.
 *   · An ANONYMOUS connection is not tracked: junction's tracker returns early
 *     for a session with no userId, so it neither appears in a roster nor
 *     receives one.
 *   · Frames arrive under their own names — `presence:sync`, `presence:join`,
 *     `presence:diff`, `presence:leave`, `presence:update` — with the channel
 *     inside the payload. There is no channel-suffixed event name; this module
 *     used to bind five of them and heard nothing.
 */

import { signal } from '../router/signals.js'
import { getClient } from '../junction/index.js'
import { onDestroy } from '@frontierjs/mesa/runtime'

// ── Normalize ─────────────────────────────────────────────────────────────────

function normaliseMember(raw) {
  return {
    connectionId: raw.connectionId,
    userId:       raw.userId,
    joinedAt:     raw.joinedAt instanceof Date ? raw.joinedAt : new Date(raw.joinedAt),
    meta:         raw.meta ?? {},
  }
}

// Build the enriched snapshot that is the signal value
function buildSnapshot(memberList, connectionId) {
  const self   = connectionId
    ? (memberList.find(m => m.connectionId === connectionId) ?? null)
    : null
  const others = self
    ? memberList.filter(m => m.connectionId !== connectionId)
    : memberList
  return {
    members: memberList,
    others,
    self,
    count: memberList.length,
  }
}

// ── Who else on this page wants this channel ─────────────────────────────────
//
// One connection has one presence meta per channel, but a page can render
// several views of the same one — an avatar strip in the header and a list in
// the sidebar is the obvious pair. The first of those to unmount used to send
// `unsubscribe` for the channel the other one is still showing (`FJS-824`), so
// the count is held here: the release goes out when the LAST holder leaves.
//
// Module-level rather than per-client because there is one client per page.

const _holders = new Map()

function _hold(channelId) {
  _holders.set(channelId, (_holders.get(channelId) ?? 0) + 1)
}

/** True when this was the last holder — i.e. the caller should release. */
function _drop(channelId) {
  const n = (_holders.get(channelId) ?? 0) - 1
  if (n > 0) { _holders.set(channelId, n); return false }
  _holders.delete(channelId)
  return true
}

/** Test seam — a suite that boots several times must not inherit a count. */
export function _resetPresenceHolders() {
  _holders.clear()
}

// ── presence() ───────────────────────────────────────────────────────────────

/**
 * Register interest in presence for a channel.
 *
 * Returns a Sierra signal. In a Mesa component script:
 *   const members = presence('workspace:42', { meta: { name: user.name } })
 *
 * Template access (auto-reactive via Mesa's reactive const):
 *   {members.count}
 *   {#each members.others as m}{m.meta.name}{/each}
 *
 * @param {string} channelId
 * @param {{ meta?: Record<string, unknown> }} [options]
 */
export function presence(channelId, options = {}) {
  const client = getClient()

  // Which member of the roster this connection IS. The server states it on
  // `presence:sync` and nothing else can: a browser is never told its own
  // connection id, so before the first sync arrives every member is an
  // "other", which is the safe way round for an avatar strip.
  let _selfId = null

  const sig = signal(buildSnapshot([], null))
  let _rawMembers = []
  let _debounceTimer = null
  let _pendingMeta   = null
  let _left          = false

  // ── Helpers ──────────────────────────────────────────────────────────────

  function push(newList) {
    _rawMembers = newList
    sig.set(buildSnapshot(newList, _selfId))
  }

  // ── Junction event handlers ──────────────────────────────────────────────

  function onSync(payload) {
    if (payload.you) _selfId = payload.you
    push((payload.members ?? []).map(normaliseMember))
  }
  function onJoin(payload)   { push([..._rawMembers, normaliseMember(payload.member)]) }
  function onLeave(payload)  { push(_rawMembers.filter(m => m.connectionId !== payload.member.connectionId)) }

  // Several joins and leaves in one frame. Junction batches them per channel
  // over a window, because a join used to send one frame to every existing
  // member and N connections cost N x (N-1) frames — 251 500 of them for 500
  // users (`FJS-703`). `presence:join`/`presence:leave` are still sent under
  // `presenceFlushMs: 0`, so both are handled and neither is legacy.
  //
  // Leaves are applied BEFORE joins: a connection that left and rejoined
  // inside one window is in both lists, and the other order removes the row it
  // had just added.
  function onDiff(payload) {
    const gone = new Set((payload.left ?? []).map(m => m.connectionId))
    const kept = _rawMembers.filter(m => !gone.has(m.connectionId))
    const here = new Set(kept.map(m => m.connectionId))
    // Deduplicated against what is already held: a diff is what MOVED, and a
    // reconnect can put a connection in a batch that a `presence:sync` already
    // reported.
    const added = (payload.joined ?? [])
      .map(normaliseMember)
      .filter(m => !here.has(m.connectionId))
    push([...kept, ...added])
  }
  function onUpdate(payload) {
    push(_rawMembers.map(m =>
      m.connectionId === payload.connectionId
        ? { ...m, meta: payload.meta ?? {} }
        : m
    ))
  }

  const HANDLERS = {
    'presence:sync':   onSync,
    'presence:join':   onJoin,
    'presence:diff':   onDiff,
    'presence:leave':  onLeave,
    'presence:update': onUpdate,
  }

  // One listener on the client's own re-emit, filtered by the channel the
  // frame already carries. Junction emits every inbound push as
  // `('event', name, data)` and has never emitted anything else, so binding
  // five names — the shape this module shipped with — heard nothing at all.
  function onEvent(name, data) {
    if (_left) return
    if (!data || data.channelId !== channelId) return
    HANDLERS[name]?.(data)
  }

  // ── Announce with Junction ───────────────────────────────────────────────

  if (client) {
    client.on('event', onEvent)
    _hold(channelId)
    // Unconditional. This used to be gated on `client.token || client.connected`
    // — which is false for every cookie-mode app, and false for the ordinary
    // case of a component mounting before the socket is up. The client queues
    // the announcement and re-sends it on every connect, because a reconnect is
    // a new connection with no meta and no roster.
    client.presence.announce(channelId, options.meta ?? {})
  }

  // ── leave() ──────────────────────────────────────────────────────────────

  function leave() {
    if (_left) return
    _left = true

    // Flush pending debounced meta before leaving
    if (_debounceTimer !== null) {
      clearTimeout(_debounceTimer)
      _debounceTimer = null
      if (client && _pendingMeta !== null) {
        client.presence.announce(channelId, _pendingMeta)
        _pendingMeta = null
      }
    }

    if (client) {
      client.off('event', onEvent)
      // Only when nothing else on this page is still showing the channel.
      if (_drop(channelId)) client.presence.release(channelId)
    }

    push([])
  }

  // ── updateMeta ───────────────────────────────────────────────────────────

  function updateMeta(meta, opts = {}) {
    if (_left || !client) return
    const debounce = opts.debounce ?? 0
    if (debounce > 0) {
      _pendingMeta = meta
      if (_debounceTimer !== null) clearTimeout(_debounceTimer)
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null
        const m = _pendingMeta
        _pendingMeta = null
        if (!_left) client.presence.announce(channelId, m)
      }, debounce)
    } else {
      client.presence.announce(channelId, meta)
    }
  }

  // ── Auto-cleanup via Mesa onDestroy ────────────────────────────────────────
  // onDestroy registers `leave` with the current component's cleanup list.
  // Works when presence() is called at component init scope (same constraint as onMount).

  onDestroy(leave)

  // ── Expose as enriched signal with updateMeta / leave ────────────────────

  sig.updateMeta = updateMeta
  sig.leave      = leave

  return sig
}
