/*
 * devline.spec.js
 *
 * The reader is graded against the writer. The half that matters to fli is the
 * null: a line that is not a well-formed message must come back null, because
 * fli prints a null line as ordinary output and swallows a parsed one.
 */

import { formatDevLine, parseDevLine, DEV_ENV } from '../../src/devline/devline.js'

test('devline: what formatDevLine writes, parseDevLine reads back', function () {
  const ready = { ready: { url: 'http://localhost:8109/api', rows: [{ name: 'Junction', facts: ['29 routes'] }, { name: 'Litestone' }] } }
  assert.deepEqual(parseDevLine(formatDevLine(ready)), {
    ready: { url: 'http://localhost:8109/api', rows: [{ name: 'Junction', facts: ['29 routes'] }, { name: 'Litestone', facts: [] }] },
  })
  const warn = { warn: { file: 'src/routes/users/[id].mesa', text: 'a\nb' } }
  assert.deepEqual(parseDevLine(formatDevLine(warn)), warn)
  assert.equal(formatDevLine(warn).includes('\n'), false, 'one line')
  assert.equal(DEV_ENV, 'FLI_DEV')
})

test('devline: a launcher indenting the line still reads', function () {
  assert.deepEqual(parseDevLine('   ' + formatDevLine({ warn: { text: 'x' } })), { warn: { file: null, text: 'x' } })
})

test('devline: anything that is not a well-formed message is null', function () {
  for (const line of [
    'VITE v8 ready',
    'says ::fli {"warn":{"text":"x"}}',
    '::fli not json',
    '::fli []',
    '::fli {"warn":{"text":"x"},"ready":{"rows":[]}}',
    '::fli {"other":{}}',
    '::fli {"__proto__":{"text":"x"}}',
    '::fli {"warn":{"text":""}}',
    '::fli {"ready":{"rows":[{"facts":["x"]}]}}',
    '::fli {"ready":{"rows":[{"name":"a","facts":[1]}]}}',
    '::fli {"ready":{"url":5,"rows":[]}}',
  ]) assert.equal(parseDevLine(line), null, line)
  assert.equal(parseDevLine(undefined), null)
})

test('devline: the writer refuses what the reader would drop', function () {
  assert.throws(() => formatDevLine({}), /exactly one/)
  assert.throws(() => formatDevLine({ ready: { rows: [] }, warn: { text: 'x' } }), /exactly one/)
  assert.throws(() => formatDevLine({ warn: { text: '' } }), /malformed/)
})
