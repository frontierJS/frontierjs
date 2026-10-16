/*
 * mailbox.spec.js
 *
 * The rows that split the three old copies: `( )` quoted by one and not the
 * other, and a `"` or `<` dropped from the name instead of escaped.
 */

import { formatMailbox } from '../../src/mailbox/mailbox.js'

test('no name is the bare address', () => {
  assert.equal(formatMailbox('a@x.test'), 'a@x.test')
  assert.equal(formatMailbox('a@x.test', null), 'a@x.test')
  assert.equal(formatMailbox('a@x.test', '   '), 'a@x.test')
})

test('a name of atoms is written bare, trimmed', () => {
  assert.equal(formatMailbox('a@x.test', ' Ada Lovelace '), 'Ada Lovelace <a@x.test>')
  assert.equal(formatMailbox('a@x.test', "O'Brien Jr."), "O'Brien Jr. <a@x.test>")
})

test('a name holding a special is a quoted-string', () => {
  for (const name of ['Lovelace, Ada', 'Ada (ops)', 'a@b', 'x;y', 'Ada <ops>'])
    assert.equal(formatMailbox('a@x.test', name), `"${name}" <a@x.test>`)
})

test('a quote and a backslash in the name are escaped, not dropped', () => {
  assert.equal(formatMailbox('a@x.test', 'Ada "the" Lovelace'), '"Ada \\"the\\" Lovelace" <a@x.test>')
  assert.equal(formatMailbox('a@x.test', 'back\\slash'), '"back\\\\slash" <a@x.test>')
})

test('a non-ASCII name is quoted as given, not encoded', () => {
  assert.equal(formatMailbox('a@x.test', 'José'), '"José" <a@x.test>')
})
