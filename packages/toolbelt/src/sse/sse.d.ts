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
 *  event name or id that is not a string or holds a line break, on a retry that
 *  is not a whole number, and on data JSON cannot carry (a function, a symbol). */
export function formatEvent(e?: SseEvent): string

/** What a reader carries from one chunk to the next. Opaque but for `held` and
 *  `open`; hand back the one the last call answered. */
export interface ParseState {
  /** Characters read and not yet dispatched. */
  readonly held: number
  /** A line of an event is read and its blank line has not come. */
  readonly open: boolean
}

/** The complete events in the next decoded chunk of a stream, and the state to
 *  read the chunk after it with. Only the new chunk is scanned. */
export function parseEvents(chunk: string, state?: ParseState): {
  events: ReadEvent[]
  state:  ParseState
}
