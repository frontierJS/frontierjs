/**
 * @frontierjs/sierra/presence — Presence API
 *
 * presence() returns a Sierra signal whose value is:
 *   { members, others, self, count }
 *
 * In Mesa components, `const members = presence(...)` compiles to a reactive
 * const — template reads members.count, members.others etc. stay reactive.
 */

import { signal } from '../router/signals.js'
import { getClient } from '../junction/index.js'
import { onDestroy } from '@frontierjs/mesa/runtime'

// ── Normalise ─────────────────────────────────────────────────────────────────

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
  const connId = client?.connectionId ?? null

  const sig = signal(buildSnapshot([], connId))
  let _rawMembers = []
  let _debounceTimer = null
  let _pendingMeta   = null
  let _left          = false

  // ── Helpers ──────────────────────────────────────────────────────────────

  function push(newList) {
    _rawMembers = newList
    sig.set(buildSnapshot(newList, client?.connectionId ?? connId))
  }

  // ── Junction event handlers ──────────────────────────────────────────────

  function onSync(payload)   { if (!_left) push((payload.members ?? []).map(normaliseMember)) }
  function onJoin(payload)   { if (!_left) push([..._rawMembers, normaliseMember(payload.member)]) }
  function onLeave(payload)  { if (!_left) push(_rawMembers.filter(m => m.connectionId !== payload.member.connectionId)) }

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
    if (_left) return
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
    if (_left) return
    push(_rawMembers.map(m =>
      m.connectionId === payload.connectionId
        ? { ...m, meta: payload.meta ?? {} }
        : m
    ))
  }

  // ── Subscribe with Junction ──────────────────────────────────────────────

  if (client) {
    client.on(`presence:sync:${channelId}`,   onSync)
    client.on(`presence:join:${channelId}`,   onJoin)
    client.on(`presence:diff:${channelId}`,   onDiff)
    client.on(`presence:leave:${channelId}`,  onLeave)
    client.on(`presence:update:${channelId}`, onUpdate)

    // Only send subscribe if authenticated
    if (client.token || client.connected) {
      client.send({ type: 'subscribe', channel: channelId, meta: options.meta })
    }
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
        client.send({ type: 'subscribe', channel: channelId, meta: _pendingMeta })
        _pendingMeta = null
      }
    }

    if (client) {
      client.off(`presence:sync:${channelId}`,   onSync)
      client.off(`presence:join:${channelId}`,   onJoin)
      client.off(`presence:diff:${channelId}`,   onDiff)
      client.off(`presence:leave:${channelId}`,  onLeave)
      client.off(`presence:update:${channelId}`, onUpdate)
      client.send({ type: 'unsubscribe', channel: channelId })
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
        if (!_left) client.send({ type: 'subscribe', channel: channelId, meta: m })
      }, debounce)
    } else {
      client.send({ type: 'subscribe', channel: channelId, meta })
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
