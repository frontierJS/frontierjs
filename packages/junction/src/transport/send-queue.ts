// transport/send-queue.ts
// One owner for "put this frame on that socket".
//
// **A WebSocket send can fail without failing.** Bun's `ws.send()` returns the
// bytes written, `-1` when the frame was buffered under backpressure, and `0`
// when it was DROPPED — the socket's buffer is past `maxBackpressureLimit`
// (16MB by default) and the frame is discarded. Junction ignored that number at
// all five send sites, so a dropped `service_result` left the caller's promise
// pending until its own 30s timeout: no error, no close, no retry, and a screen
// that sits on "Loading…" while the server believes it answered. A dropped
// `event` frame is worse — nothing is waiting on it, so the row is simply never
// updated and every open tab is quietly stale.
//
// Measured, not theorised: 200 concurrent reads of a 1MB payload over one
// socket drop 193 of them. The buffer climbs to ~17MB and stops, and from there
// every send returns 0.
//
// So: try to send; if the frame was dropped, hold it and flush on `drain`. Once
// anything is held, everything queues behind it — a frame that jumped the queue
// would arrive out of order, and an event stream that reorders is worse than
// one that pauses.
//
// The queue is bounded. A consumer that never drains is a memory leak with a
// polite name, so past the cap the socket is closed with 1013 (Try Again
// Later): the browser client rejects every in-flight call on close and
// reconnects with backoff, and the server re-joins it to its channels on the
// way back in. A caller then gets an error it can act on, which is the whole
// point — the failure this module exists for is the one nobody was told about.

export interface SendQueueSocket {
  send:               (data: string) => number
  close:              (code?: number, reason?: string) => void
  readyState:         number
  getBufferedAmount?: () => number
}

/** Past this many bytes held for one socket, close it rather than grow. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024

/**
 * The channel broadcast path has no access to the app's config — it holds a
 * socket and nothing else — so the cap is set once when the transport starts
 * and read from here. One number, one owner, whichever side sends.
 */
let maxQueuedDefault = MAX_QUEUED_BYTES
export function setMaxQueuedBytes(bytes: number | undefined): void {
  maxQueuedDefault = bytes ?? MAX_QUEUED_BYTES
}

interface FrameQueue {
  frames: string[]
  bytes:  number
}

// Keyed on the socket object so a closed socket's queue is collectable without
// anything having to remember to clean it up.
const queues = new WeakMap<object, FrameQueue>()

/** Frames currently held for this socket. 0 when it is keeping up. */
export function queuedFrames(ws: SendQueueSocket): number {
  return queues.get(ws as object)?.frames.length ?? 0
}

/**
 * Send, or hold until the socket drains.
 *
 * Returns `sent` when it went out, `queued` when it is held, `closed` when the
 * socket was over the cap (or already gone) and has been closed.
 */
export function wsSend(ws: SendQueueSocket, payload: string): 'sent' | 'queued' | 'closed' {
  if (ws.readyState !== 1) return 'closed'

  const held = queues.get(ws as object)

  // Anything held means everything queues — see the ordering note above.
  if (held && held.frames.length > 0) return holdFrame(ws, held, payload)

  let result: number
  try { result = ws.send(payload) } catch { return 'closed' }

  // 0 is the drop. -1 is backpressure with the frame safely buffered, which
  // needs nothing from us: Bun delivers it.
  if (result !== 0) return 'sent'

  return holdFrame(ws, held ?? newQueue(ws), payload)
}

/**
 * Called from the transport's `drain` handler: the socket has room again.
 * Sends what is held, in order, and stops at the first frame that is dropped
 * again — that frame stays at the head and the next drain picks it up.
 */
export function flushSendQueue(ws: SendQueueSocket): void {
  const held = queues.get(ws as object)
  if (!held || held.frames.length === 0) return

  if (ws.readyState !== 1) {
    queues.delete(ws as object)
    return
  }

  while (held.frames.length > 0) {
    const frame = held.frames[0]!
    let result: number
    try { result = ws.send(frame) } catch { queues.delete(ws as object); return }
    if (result === 0) return
    held.frames.shift()
    held.bytes -= frame.length
  }

  queues.delete(ws as object)
}

/** Forget a socket's queue — the connection is gone. */
export function dropSendQueue(ws: SendQueueSocket): void {
  queues.delete(ws as object)
}

function newQueue(ws: SendQueueSocket): FrameQueue {
  const queue: FrameQueue = { frames: [], bytes: 0 }
  queues.set(ws as object, queue)
  return queue
}

function holdFrame(ws: SendQueueSocket, held: FrameQueue, payload: string): 'queued' | 'closed' {
  if (held.bytes + payload.length > maxQueuedDefault) {
    queues.delete(ws as object)
    // 1013 Try Again Later. The client's own close handler rejects every
    // pending call, so a caller learns the truth instead of waiting on a frame
    // that is never coming.
    try { ws.close(1013, 'backpressure') } catch {}
    return 'closed'
  }
  held.frames.push(payload)
  held.bytes += payload.length
  return 'queued'
}
