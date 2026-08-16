// Channel registry — Harbor-side pub/sub bookkeeping.
//
// Responsibilities:
//   - Track which ports are subscribed to which channels
//   - Refcount: subscribe to Junction once per channel (regardless of how
//     many ports listen); unsubscribe when last port leaves
//   - Fan out incoming Junction events to all subscribed ports as
//     `channel:event` messages
//   - Auto-cleanup all subscriptions when a port disconnects
//
// Multi-tab Islands subscribing to the same channel: one Junction subscription,
// many ports. When the SW terminates, ports disconnect (lazy reconnect on next
// send from Page side), entries are cleaned up, Junction subs released.

import { safeSubscribe } from '../junction/adapter.js'

export function makeChannelRegistry({ adapter }) {
  // channel name → { ports: Set<port>, unsubscribe: (() => Promise<void>) | null }
  const channels = new Map()

  // `event` is carried, not dropped. A channel and an event are not the same
  // thing — you join `posts` and receive `posts created` — so a fan-out that
  // forwards only the channel leaves the page unable to tell a create from a
  // remove, and a delete then reads as an upsert (`FJS-059`).
  function fanOut(channel, data, event) {
    const entry = channels.get(channel)
    if (!entry) return 0
    let delivered = 0
    for (const port of entry.ports) {
      try {
        port.postMessage({ type: 'channel:event', payload: { channel, data, event } })
        delivered++
      } catch { /* port closed; will be cleaned via disconnect handler */ }
    }
    return delivered
  }

  return {
    /**
     * Page-side request: this port wants events from `channel`.
     * If first subscriber, opens upstream Junction subscription.
     */
    async subscribePort(port, channel) {
      let entry = channels.get(channel)
      if (!entry) {
        entry = { ports: new Set(), unsubscribe: null }
        channels.set(channel, entry)
        // First subscriber → open upstream sub. If adapter doesn't support
        // subscribe(), this throws — caller decides what to surface.
        try {
          entry.unsubscribe = await safeSubscribe(adapter, channel, (data, event) => {
            fanOut(channel, data, event)
          })
        } catch (e) {
          channels.delete(channel)
          throw e
        }
      }
      entry.ports.add(port)
    },

    async unsubscribePort(port, channel) {
      const entry = channels.get(channel)
      if (!entry) return
      entry.ports.delete(port)
      if (entry.ports.size === 0) {
        if (typeof entry.unsubscribe === 'function') {
          try { await entry.unsubscribe() }
          catch (e) { console.warn(`[jetty] channel "${channel}" upstream unsubscribe threw:`, e.message) }
        }
        channels.delete(channel)
      }
    },

    /**
     * Called from port.onDisconnect — cleans up everything for this port.
     */
    async unsubscribeAllForPort(port) {
      const toUnsub = []
      for (const [channel, entry] of channels) {
        if (entry.ports.has(port)) toUnsub.push(channel)
      }
      for (const channel of toUnsub) {
        await this.unsubscribePort(port, channel)
      }
    },

    /**
     * Harbor-side direct publish — fans out to subscribed ports without
     * going through Junction. Useful for harbor-only events like cache
     * invalidation that other ports should react to.
     */
    publish(channel, data) {
      return fanOut(channel, data) > 0
    },

    /** Test introspection — not part of public API. */
    _channels() { return channels },
    countSubscribers(channel) { return channels.get(channel)?.ports.size ?? 0 },
    activeChannels() { return [...channels.keys()] },
  }
}

/**
 * channels API exposed in Harbor's run() ctx.
 *
 * Surface:
 *   channels.on(eventName, fn)         — lifecycle events (currently: 'connection')
 *   channels.subscribe(channel, fn)    — harbor-side direct subscribe via Junction
 *   channels.publish(channel, data)    — fan out to ports subscribed to this channel
 */
export function makeChannelsApi({ adapter, channelRegistry, lifecycleHooks }) {
  return {
    on(eventName, fn) {
      const set = lifecycleHooks[eventName]
      if (!set) {
        throw new Error(`channels.on: unknown event "${eventName}". Known: ${Object.keys(lifecycleHooks).join(', ')}`)
      }
      set.add(fn)
      return () => set.delete(fn)
    },

    /**
     * Direct subscribe — useful when harbor.run() itself wants to listen to a
     * channel. Independent of port-side subscriptions; returns adapter's
     * unsubscribe fn.
     */
    async subscribe(channel, handler) {
      return safeSubscribe(adapter, channel, handler)
    },

    /**
     * Publish to all ports currently subscribed to this channel. Doesn't
     * round-trip through Junction — pure local fan-out.
     */
    publish(channel, data) {
      return channelRegistry.publish(channel, data)
    },
  }
}
