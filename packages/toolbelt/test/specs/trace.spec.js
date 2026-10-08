/*
 * trace.spec.js
 *
 * Junction files a request under the trace id this returns and conduit
 * continues the trace with it (`FJS-D660`), so a header one accepts and the
 * other refuses splits one request into two ids. Every refusal below is a
 * header a client could send; each answers null rather than a guess.
 */

import { parseTraceparent } from '../../src/trace/trace.js'

const GOOD = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

test('trace: a well-formed header parses into its three parts', function () {
  assert.deepEqual(parseTraceparent(GOOD), {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_id: '00f067aa0ba902b7', sampled: true,
  })
  assert.equal(parseTraceparent(GOOD.replace(/-01$/, '-00')).sampled, false)
})

test('trace: surrounding whitespace and upper-case hex are read, not refused', function () {
  assert.equal(parseTraceparent('  ' + GOOD.toUpperCase() + ' ').trace_id,
    '4bf92f3577b34da6a3ce929d0e0e4736')
})

test('trace: absent or malformed answers null', function () {
  const refused = [
    undefined, null, '', 42,
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',      // unknown version
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',      // the forbidden version
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',      // all-zero trace
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',      // all-zero parent
    '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01',       // short trace
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz',      // flags not hex
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
    '00-4bf92f3577b34da6a3ce929d0e0e47g6-00f067aa0ba902b7-01',      // not hex
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\nx: y", // a header split
  ]
  for (const h of refused) assert.equal(parseTraceparent(h), null, JSON.stringify(h))
})
