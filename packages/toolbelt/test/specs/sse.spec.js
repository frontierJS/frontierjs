/*
 * sse.spec.js
 *
 * The reader is graded against the writer, because the defect this kit exists
 * to prevent is the two halves disagreeing about one format. The chunk-boundary
 * sweep is the assertion a hand reader fails: portal's split on `\n\n` alone, so
 * a CRLF stream never dispatched and a boundary between CR and LF was two lines.
 */

import { formatEvent, parseEvents } from '../../src/sse/sse.js'

// Every way `text` can arrive, one cut at a time, read incrementally.
function readInChunks(text, cut) {
  const events = []
  let rest = ''
  let lastId = ''
  for (const chunk of [text.slice(0, cut), text.slice(cut)]) {
    const out = parseEvents(rest + chunk, lastId)
    events.push(...out.events)
    rest = out.rest
    lastId = out.lastId
  }
  return events
}

// ─── the round trip ───────────────────────────────────────────────────────────

test('sse: what formatEvent writes, parseEvents reads back', function () {
  const sent = [
    { data: { hits: [1, 2], q: 'line\nbreak' } },
    { event: 'land', data: 'text', id: '7' },
    { event: 'done', data: null, retry: 3000 },
  ]
  const { events, rest } = parseEvents(sent.map(formatEvent).join(''))
  assert.equal(rest, '')
  assert.deepEqual(events, [
    { event: 'message', data: { hits: [1, 2], q: 'line\nbreak' }, id: '' },
    { event: 'land', data: 'text', id: '7' },
    { event: 'done', data: null, id: '7' },
  ])
})

test('sse: a chunk boundary at every offset reads the same events', function () {
  const text = [
    formatEvent({ event: 'a', data: { n: 1 }, id: 'x' }),
    ': a comment\r\n',
    'data: 2\r\ndata: 3\r\n\r\n',
    'event: c\rdata: "é"\r\r',
    formatEvent({ data: 'last' }),
  ].join('')
  const whole = parseEvents(text).events
  assert.equal(whole.length, 4)
  for (let cut = 0; cut <= text.length; cut++) {
    assert.deepEqual(readInChunks(text, cut), whole, `cut at ${cut}`)
  }
})

// ─── the grammar ──────────────────────────────────────────────────────────────

test('sse: several data lines join with a line break, and the result is decoded once', function () {
  const { events } = parseEvents('data: {"a":\ndata: 1}\n\n')
  assert.deepEqual(events, [{ event: 'message', data: { a: 1 }, id: '' }])
})

test('sse: data that is not JSON arrives as its text', function () {
  const { events } = parseEvents('data: [DONE]\n\ndata:no-space\n\n')
  assert.deepEqual(events.map((e) => e.data), ['[DONE]', 'no-space'])
})

test('sse: an empty data line dispatches an empty string; a block with no data dispatches nothing', function () {
  const { events } = parseEvents('data:\n\nevent: lonely\n\ndata: 1\n\n')
  assert.deepEqual(events, [
    { event: 'message', data: '', id: '' },
    // The event name of the dataless block does not leak into the next one.
    { event: 'message', data: 1, id: '' },
  ])
})

test('sse: an id persists across events until another replaces it, and one holding NUL is ignored', function () {
  const { events, lastId } = parseEvents('id: 1\ndata: a\n\ndata: b\n\nid: 2\u0000\ndata: c\n\nid\ndata: d\n\n')
  assert.deepEqual(events.map((e) => e.id), ['1', '1', '1', ''])
  assert.equal(lastId, '')
})

test('sse: an unfinished event stays in rest and commits nothing', function () {
  const out = parseEvents('data: 1\n\nid: 9\ndata: 2\n', 'prev')
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0].id, 'prev')
  assert.equal(out.rest, 'id: 9\ndata: 2\n')
  assert.equal(out.lastId, 'prev', 'the id line of an unfinished event has not been read yet')
})

test('sse: a CR that ends the text is held, since the LF of its CRLF may be the next chunk', function () {
  const out = parseEvents('data: a\r')
  assert.equal(out.rest, 'data: a\r')
  // Read as two breaks, the LF would be a blank line and dispatch `a` alone.
  const { events } = parseEvents(out.rest + '\ndata: b\r\n\r\n')
  assert.deepEqual(events.map((e) => e.data), ['a\nb'], 'the CRLF is one line break, not two')
})

test('sse: unknown fields and a field with no colon are ignored', function () {
  const { events } = parseEvents('foo: bar\nretry: 10\ndata\n\n')
  assert.deepEqual(events, [{ event: 'message', data: '', id: '' }])
})

// ─── the writer's refusals ────────────────────────────────────────────────────

test('sse: a line break in an event name or id is refused, the same name without one is written', function () {
  assert.throws(() => formatEvent({ event: 'a\nb', data: 1 }), /line break/)
  assert.throws(() => formatEvent({ id: 'a\rb', data: 1 }), /line break/)
  assert.throws(() => formatEvent({ retry: 1.5, data: 1 }), /whole number/)
  assert.equal(formatEvent({ event: 'ab', id: '0', retry: 0, data: 1 }), 'id: 0\nevent: ab\nretry: 0\ndata: 1\n\n')
})

test('sse: undefined data is written as null, never as the word undefined', function () {
  assert.equal(formatEvent({}), 'data: null\n\n')
})
