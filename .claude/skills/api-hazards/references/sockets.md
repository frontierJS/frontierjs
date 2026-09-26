# Sockets

The full entries behind this section of the `api-hazards` skill's index.

- **A socket stays alive because the SERVER pings it, and an app calls nothing.** The channels plugin pings an idle connection every 15s and evicts one silent for 40s; any frame counts, and the browser client answers from its message handler rather than a timer, because a timer is throttled to ~1/min in a hidden tab, slower than the eviction window (`FJS-366`). `client.startHeartbeat()` is only for a server that does not ping. Ruled: `FJS-D450`.
- **Never call `ws.send()` directly.** Bun answers `-1` for buffered and **`0` for discarded** past ~16.9MB of unacknowledged data on one socket (`maxBackpressureLimit` is accepted and ignored). `transport/send-queue.ts` is the one owner of a send: it holds a dropped frame, flushes on `drain`, preserves order, and past `http.wsMaxQueued` (8MB) closes with 1013 so the client reconnects.
