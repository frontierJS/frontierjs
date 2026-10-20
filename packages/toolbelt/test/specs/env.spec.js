/*
 * env.spec.js
 *
 * Junction's defineEnv and litestone's CLI both answer from these two, so a
 * row here is a row both readers keep.
 */

import { envSource, fileValue } from '../../src/env/env.js'

test('no KEY_FILE answers the variable, set or not', () => {
  assert.deepEqual(envSource('K', { K: 'v' }), { value: 'v' })
  assert.deepEqual(envSource('K', {}), { value: undefined })
  assert.deepEqual(envSource('K', { K: 'v', K_FILE: '' }), { value: 'v' })
})

test('KEY_FILE alone names the file to read', () => {
  assert.deepEqual(envSource('K', { K_FILE: '/run/secrets/K' }), { file: '/run/secrets/K', fileKey: 'K_FILE' })
  assert.deepEqual(envSource('K', { K: '', K_FILE: '/run/secrets/K' }), { file: '/run/secrets/K', fileKey: 'K_FILE' })
})

test('both set is refused, naming both and neither value', () => {
  const r = envSource('K', { K: 'secret-value', K_FILE: '/run/secrets/K' })
  assert.ok(r.error.includes('K and K_FILE are both set'))
  assert.ok(!r.error.includes('secret-value'))
})

test('a file loses its trailing newlines and nothing else', () => {
  assert.equal(fileValue('abc\n'), 'abc')
  assert.equal(fileValue('abc\r\n\n'), 'abc')
  assert.equal(fileValue(' abc '), ' abc ')
  assert.equal(fileValue('a\nb\n'), 'a\nb')
})

test('an empty file is an unset key', () => {
  assert.equal(fileValue(''), undefined)
  assert.equal(fileValue('\n'), undefined)
})
