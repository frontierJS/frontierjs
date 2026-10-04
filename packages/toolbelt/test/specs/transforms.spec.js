/*
 * transforms.spec.js
 *
 * Three realms read this table, so the cases are the orders they must agree on:
 * declaration order, and a transform before any length is counted.
 */

import { transform, isTransform, TRANSFORM_NAMES } from '../../src/transforms/transforms.js'

test('transforms: each name does what its attribute says', function () {
  assert.equal(transform(['trim'], '  ab  '), 'ab')
  assert.equal(transform(['lower'], 'UP1'), 'up1')
  assert.equal(transform(['upper'], 'up1'), 'UP1')
  assert.equal(transform(['slug'], 'Café au Lait'), 'cafe-au-lait')
})

test('transforms: declaration order is the order they run', function () {
  assert.equal(transform(['trim', 'upper'], '  ab '), 'AB')
  // slug lowercases, so what follows it sees the slug
  assert.equal(transform(['slug', 'upper'], 'Hello World'), 'HELLO-WORLD')
  assert.equal(transform(['upper', 'slug'], 'Hello World'), 'hello-world')
})

test('transforms: no names, or an unknown one, leaves the value alone', function () {
  assert.equal(transform(undefined, ' x '), ' x ')
  assert.equal(transform([], ' x '), ' x ')
  assert.equal(transform(['reverse', 'trim'], ' x '), 'x')
})

test('transforms: the names are the ones a schema can declare', function () {
  assert.deepEqual(TRANSFORM_NAMES, ['trim', 'lower', 'upper', 'slug'])
  assert.equal(isTransform('lower'), true)
  assert.equal(isTransform('toString'), false)
  assert.equal(isTransform('__proto__'), false)
})
