/**
 * sse — the `text/event-stream` frame, written and read by one kit.
 *
 * Junction's `ctx.sse()` writes it and a page reads it, and the two halves are
 * one format: a reader written beside the writer rather than from it is a
 * second origin of the framing, and every page that read a stream wrote its own
 * (`FJS-1581`). `EventSource` would read it for free, but it cannot carry a
 * bearer token, so an authenticated stream is read over `fetch`.
 *
 * `data` is JSON both ways — the writer encodes it and the reader decodes it.
 * A data line that is not JSON reaches the reader as its text, so a stream this
 * framework did not write still reads.
 *
 * The grammar is the WHATWG one (html.spec.whatwg.org § server-sent events).
 * `retry` is written and ignored when read: it tunes a reconnect, and nothing
 * here reconnects.
 */

const BREAK = /[\r\n]/

/**
 * One event as the bytes a stream carries, ending in the blank line that
 * dispatches it.
 *
 * @param {{ data?: unknown, event?: string, id?: string, retry?: number }} e
 * @returns {string}
 */
export function formatEvent({ data, event, id, retry } = {}) {
  // A line break in a field ends the field, so the rest of it would be read as
  // a field of its own — a name that frames a second event nobody sent.
  if (event != null && typeof event !== 'string') throw new TypeError(`sse: an event name must be a string, not ${typeof event}`)
  if (id != null && typeof id !== 'string') throw new TypeError(`sse: an id must be a string, not ${typeof id}`)
  if (event != null && BREAK.test(event)) throw new TypeError(`sse: an event name cannot hold a line break (${JSON.stringify(event)})`)
  if (id != null && (BREAK.test(id) || id.includes('\0'))) throw new TypeError(`sse: an id cannot hold a line break or NUL (${JSON.stringify(id)})`)
  if (retry != null && !(Number.isInteger(retry) && retry >= 0)) throw new TypeError(`sse: retry is a whole number of ms, not ${JSON.stringify(retry)}`)

  let out = ''
  if (id != null) out += `id: ${id}\n`
  if (event) out += `event: ${event}\n`
  if (retry != null) out += `retry: ${retry}\n`
  // A function or symbol encodes to undefined, and `data: undefined` is a frame
  // a reader gets as the text "undefined".
  const body = JSON.stringify(data ?? null)
  if (body === undefined) throw new TypeError(`sse: data of type ${typeof data} cannot be written as JSON`)
  // JSON never holds a raw line break, so one data line carries any value.
  return out + `data: ${body}\n\n`
}

/**
 * The complete events in the next chunk of a stream, and the state to read the
 * chunk after it with.
 *
 * Incremental: hand over each decoded chunk as it arrives and the `state` the
 * previous call answered. Only the new chunk is scanned, so one event spread
 * over k chunks costs O(k) rather than rescanning everything held so far. A
 * chunk boundary anywhere — mid-line, mid-event, between the CR and LF of one
 * line break — changes nothing about what is read.
 *
 * `state` is opaque but for `held` (characters read and not yet dispatched, for
 * a caller capping an event's size) and `open` (a line of an event is read and
 * its blank line has not come, so a stream that ends now ended inside one).
 *
 * @param {string} chunk
 * @param {ParseState} [state]  the state the previous call answered
 * @returns {{ events: Array<{ event: string, data: unknown, id: string }>, state: ParseState }}
 */
export function parseEvents(chunk, state = START) {
  const events = []
  let { tail, data, type, id, skipLf, open } = state
  const n = chunk.length
  let i = 0

  // A CR ended the last chunk, so its line is already read; an LF first here is
  // the other half of that one break.
  if (skipLf && n > 0) {
    if (chunk[0] === '\n') i = 1
    skipLf = false
  }

  while (i < n) {
    let j = i
    while (j < n && chunk[j] !== '\n' && chunk[j] !== '\r') j++
    if (j === n) {
      tail += chunk.slice(i)
      break
    }
    const line = tail + chunk.slice(i, j)
    tail = ''
    if (chunk[j] === '\r') {
      if (chunk[j + 1] === '\n') i = j + 2
      else {
        i = j + 1
        skipLf = i === n
      }
    } else i = j + 1

    if (line === '') {
      if (data !== null) events.push({ event: type || 'message', data: decode(data), id })
      data = null
      type = ''
      open = false
      continue
    }

    open = true
    const colon = line.indexOf(':')
    if (colon === 0) continue
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value[0] === ' ') value = value.slice(1)

    if (field === 'data') data = data === null ? value : data + '\n' + value
    else if (field === 'event') type = value
    else if (field === 'id' && !value.includes('\0')) id = value
  }

  const held = tail.length + (data === null ? 0 : data.length)
  return { events, state: { tail, data, type, id, skipLf, open: open || tail !== '', held } }
}

/** @typedef {{ tail: string, data: string | null, type: string, id: string, skipLf: boolean, open: boolean, held: number }} ParseState */

/** @type {ParseState} */
const START = { tail: '', data: null, type: '', id: '', skipLf: false, open: false, held: 0 }

function decode(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
