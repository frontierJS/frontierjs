/** One event as a writer states it. `data` is JSON-encoded. */
export interface SseEvent {
  data?:  unknown
  /** Named event type; a reader sees `message` when absent. */
  event?: string
  /** Last-Event-ID a reader resumes from. */
  id?:    string
  /** Reconnect delay hint in ms. */
  retry?: number
}

/** One event as a reader receives it. `data` is JSON-decoded, or the raw text
 *  when it is not JSON; `id` is the stream's last id, `''` before any. */
export interface ReadEvent {
  event: string
  data:  unknown
  id:    string
}

/** The bytes one event is on the wire, ending in its blank line. Throws on an
 *  event name or id holding a line break, and on a retry that is not a whole
 *  number. */
export function formatEvent(e?: SseEvent): string

/** The complete events at the front of `text`, and the unread tail to prepend
 *  to the next chunk. */
export function parseEvents(text: string, lastId?: string): {
  events: ReadEvent[]
  rest:   string
  lastId: string
}
