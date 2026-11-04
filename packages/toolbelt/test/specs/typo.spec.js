/*
 * typo.spec.js
 *
 * The property under test is the CUTOFF: what is close enough to be offered as
 * "did you mean". Too loose and a short word is corrected to something its
 * author never meant; too tight and the swap typo, the commonest one, gets no
 * answer.
 */

import { nearest, nearestAll } from '../../src/typo/typo.js'

test('typo: a swap of two letters is one edit', function () {
  assert.equal(nearest('emial', ['name', 'email', 'phone']), 'email')
  assert.equal(nearest('naem', ['name', 'email']), 'name')
  assert.equal(nearest('dov', ['build', 'dev', 'deploy']), 'dev')
})

test('typo: a case-only difference wins outright', function () {
  assert.equal(nearest('Email', ['emails', 'email']), 'email')
  assert.equal(nearest('MS', ['m', 'ms', 's']), 'ms')
})

test('typo: the cutoff is a third of the word, at least one edit', function () {
  // length 3–5 → 1 edit, 6–8 → 2, 9–11 → 3
  assert.equal(nearest('dxv', ['dev']), 'dev')
  assert.equal(nearest('dxx', ['dev']), null)
  assert.equal(nearest('selcet', ['select']), 'select')
  assert.equal(nearest('slcxt', ['select']), null)
  assert.equal(nearest('ordrBy', ['orderBy']), 'orderBy')
  assert.equal(nearest('ordxrBx', ['orderBy']), 'orderBy')
  assert.equal(nearest('oxdxrBx', ['orderBy']), null)
  assert.equal(nearest('middlewar', ['middleware']), 'middleware')
  assert.equal(nearest('midlewxre', ['middleware']), 'middleware')
  assert.equal(nearest('mxdlewxre', ['middleware']), 'middleware')
  assert.equal(nearest('mxdlxwxre', ['middleware']), null)
})

test('typo: nothing close is nothing, and one letter is not corrected to another', function () {
  assert.equal(nearest('xyz', ['dev', 'build']), null)
  assert.equal(nearest('x', ['y', 'xy']), null)
  assert.equal(nearest('X', ['y', 'x']), 'x')
  assert.equal(nearest('', ['a']), null)
  assert.equal(nearest('dev', []), null)
  assert.equal(nearest(undefined, ['dev']), null)
})

test('typo: closest first, a tie in the order given, duplicates once', function () {
  assert.deepEqual(nearestAll('cat', ['bat', 'cart', 'cat', 'hat', 'bat']), ['cat', 'bat', 'cart', 'hat'])
  assert.equal(nearest('cat', ['hat', 'bat']), 'hat')
})

test('typo: any iterable, and the arguments are not touched', function () {
  const set = new Set(['email', 'name'])
  assert.equal(nearest('emial', set), 'email')
  assert.deepEqual([...set], ['email', 'name'])
  const list = ['b', 'a']
  nearestAll('a', list)
  assert.deepEqual(list, ['b', 'a'])
})
