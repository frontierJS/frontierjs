/*
 * fill.spec.js
 *
 * `fill` -- merge fields into text a user wrote (`FJS-2680`, `FJS-D980`).
 *
 * The risk is one sentence: a value an app holds (a client's name, typed by
 * somebody else) lands in an HTML body, and `<img onerror>` in it runs where
 * the mail is read. So the escaping is asserted against that exact value, and
 * every other rule is the part of the ruling that makes the output predictable.
 */

import { fill, check } from '../../src/fill/fill.js'

const CTX = {
  contact: { name: 'Ann', first: null, visits: 0, active: false, evil: '<img src=x onerror=alert(1)>' },
  link:    { url: { html: '<a href="/r/1">here</a>', text: 'https://x.test/r/1' } },
}

test('fill: a hole is a dotted field name', function () {
  assert.equal(fill('Hi {contact.name}!', CTX, { mode: 'text' }), 'Hi Ann!')
})

test('fill: html mode escapes the value and never the author\'s markup', function () {
  assert.equal(fill('<p>{contact.evil}</p>', CTX, { mode: 'html' }), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(fill('<p>{contact.evil}</p>', CTX, { mode: 'text' }), '<p><img src=x onerror=alert(1)></p>')
  assert.equal(fill('{contact.evil}', { contact: { evil: `"'&` } }, { mode: 'html' }), '&quot;&#39;&amp;')
})

test('fill: the caller states the mode and it is never sniffed', function () {
  assert.throws(() => fill('x', CTX), /mode/)
  assert.throws(() => fill('x', CTX, { mode: 'markdown' }), /mode/)
})

test('fill: a value built as markup is { html, text } and read by mode', function () {
  assert.equal(fill('See {link.url}', CTX, { mode: 'html' }), 'See <a href="/r/1">here</a>')
  assert.equal(fill('See {link.url}', CTX, { mode: 'text' }), 'See https://x.test/r/1')
})

test('fill: a falsy value fills as written, null fills empty', function () {
  assert.equal(fill('[{contact.visits}][{contact.active}][{contact.first}]', CTX, { mode: 'text' }), '[0][false][]')
})

test('fill: a name the context lacks is left as written', function () {
  assert.equal(fill('{contact.nope} {ghost.name} {nobody}', CTX, { mode: 'text' }), '{contact.nope} {ghost.name} {nobody}')
})

test('fill: a name reads own properties only', function () {
  assert.equal(fill('[{contact.constructor}][{contact.toString}]', CTX, { mode: 'text' }), '[{contact.constructor}][{contact.toString}]')
})

test('fill: a hole may be a values expression', function () {
  assert.equal(fill("Hi {contact.first != null ? contact.first : 'there'}", CTX, { mode: 'text' }), 'Hi there')
  assert.equal(fill("Hi {contact.name != null ? contact.name : 'there'}", CTX, { mode: 'text' }), 'Hi Ann')
})

test('fill: an expression reaching past values is left as written', function () {
  assert.equal(fill('{auth().id}|{now()}', CTX, { mode: 'text' }), '{auth().id}|{now()}')
})

test('fill: a literal brace is written \\{', function () {
  assert.equal(fill('a \\{contact.name} b {contact.name}', CTX, { mode: 'text' }), 'a {contact.name} b Ann')
})

test('fill: braces that are not a hole survive', function () {
  assert.equal(fill('{} { oops } {"a":1} {', CTX, { mode: 'text' }), '{} { oops } {"a":1} {')
})

test('fill: a closing brace inside a quoted string does not end the hole', function () {
  assert.equal(fill("{contact.first ? '}' : contact.name}", CTX, { mode: 'text' }), 'Ann')
})

test('fill: a value is filled once and never read as a hole', function () {
  assert.equal(fill('{a.b}', { a: { b: '{a.c}', c: 'X' } }, { mode: 'text' }), '{a.c}')
})

test('fill: a path reaches below two segments', function () {
  assert.equal(fill('{trigger.body.amount}', { trigger: { body: { amount: 5 } } }, { mode: 'text' }), '5')
})

test('fill: a value that is not a scalar is left as written', function () {
  assert.equal(fill('{contact}', CTX, { mode: 'text' }), '{contact}')
})

test('check: a clean source answers nothing', function () {
  assert.equal(check('Hi {contact.name} \\{ok}', { contact: ['name'] }).length, 0)
})

test('check: an unknown name is refused by name', function () {
  const bad = check('{contact.name} {contact.nope} {ghost.x}', { contact: ['name'] })
  assert.equal(bad.length, 2)
  assert.match(bad[0].message, /contact\.nope/)
  assert.equal(bad[0].hole, 'contact.nope')
  assert.match(bad[1].message, /ghost\.x/)
})

test('check: an expression is graded the way a value is', function () {
  const bad = check("{auth().id} {contact.name != null ? contact.name : 'x'}", { contact: ['name'] })
  assert.equal(bad.length, 1)
  assert.match(bad[0].message, /auth/)
})

test('check: a brace that opens nothing is refused, so a stray one is written \\{', function () {
  assert.equal(check('cost { oops', { contact: ['name'] }).length, 1)
  assert.equal(check('{ oops }', { contact: ['name'] }).length, 1)
})
