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
  if (event != null && BREAK.test(event)) throw new TypeError(`sse: an event name cannot hold a line break (${JSON.stringify(event)})`)
  if (id != null && (BREAK.test(id) || id.includes('\0'))) throw new TypeError(`sse: an id cannot hold a line break or NUL (${JSON.stringify(id)})`)
  if (retry != null && !(Number.isInteger(retry) && retry >= 0)) throw new TypeError(`sse: retry is a whole number of ms, not ${JSON.stringify(retry)}`)

  let out = ''
  if (id != null) out += `id: ${id}\n`
  if (event) out += `event: ${event}\n`
  if (retry != null) out += `retry: ${retry}\n`
  // JSON never holds a raw line break, so one data line carries any value.
  return out + `data: ${JSON.stringify(data ?? null)}\n\n`
}

/**
 * The complete events at the front of `text`, and what is left over.
 *
 * Incremental: append the next decoded chunk to `rest` and call again with the
 * `lastId` this call answered. An event is complete at its blank line; what
 * follows the last one is returned untouched, so a chunk boundary anywhere —
 * mid-line, mid-event, between the CR and LF of one line break — changes
 * nothing about what is read.
 *
 * @param {string} text
 * @param {string} [lastId]  the id the previous call answered
 * @returns {{ events: Array<{ event: string, data: unknown, id: string }>, rest: string, lastId: string }}
 */
export function parseEvents(text, lastId = '') {
  const events = []
  let data = []
  let type = ''
  let id = lastId
  let consumed = 0
  let i = 0
  const n = text.length

  while (i < n) {
    let j = i
    while (j < n && text[j] !== '\n' && text[j] !== '\r') j++
    if (j === n) break
    // A CR that ends the text may be the first half of a CRLF.
    if (text[j] === '\r' && j + 1 === n) break
    const line = text.slice(i, j)
    i = text[j] === '\r' && text[j + 1] === '\n' ? j + 2 : j + 1

    if (line === '') {
      lastId = id
      if (data.length) events.push({ event: type || 'message', data: decode(data.join('\n')), id })
      data = []
      type = ''
      consumed = i
      continue
    }

    const colon = line.indexOf(':')
    if (colon === 0) continue
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value[0] === ' ') value = value.slice(1)

    if (field === 'data') data.push(value)
    else if (field === 'event') type = value
    else if (field === 'id' && !value.includes('\0')) id = value
  }

  return { events, rest: text.slice(consumed), lastId }
}

function decode(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
