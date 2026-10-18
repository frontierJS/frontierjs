/*
 * textedit.spec.js
 *
 * A swap lands where the element's words are written exactly once, or it is
 * refused with a reason. Every refusal row is a case a guess would get wrong:
 * the words in an expression, split by markup, written twice, or new words
 * that would change the source's structure.
 */

import { locateText } from '../../src/textedit/textedit.js'

const MESA = [
  '<script>',
  "  const title = 'Hello'",   // the words inside an expression are not text
  '</script>',
  '',
  '<section title="Hello">',
  '  <h1 id="t">Hello',
  '    world</h1>',
  '  <p>Hello <em>there</em></p>',
  '  <h2>{title}</h2>',
  '  <ul><li>Item</li><li>Item</li></ul>',
  '  <h3>Items</h3>',
  '</section>',
].join('\n')
const at = (o) => locateText(MESA, { ext: 'mesa', next: 'Changed', ...o })
const swap = (src, r, next) => src.slice(0, r.start) + next + src.slice(r.end)

test('textedit: the element\'s text, wrapped across lines, is found once inside its own tags', function () {
  const r = at({ line: 6, col: 3, tag: 'h1', old: 'Hello world' })
  assert.equal(r.why, undefined)
  assert.ok(swap(MESA, r, 'Changed').includes('<h1 id="t">Changed</h1>'))
  assert.equal(MESA.slice(r.from, r.to), '<h1 id="t">Hello\n    world</h1>')
})

test('textedit: not in an attribute, not in an expression, not in a script', function () {
  // "Hello" is in the section's title attribute and the script too; only the
  // text runs of the region count.
  assert.equal(at({ line: 5, col: 1, tag: 'section', old: 'Hello world' }).why, undefined)
})

test('textedit: interpolated text is refused rather than guessed', function () {
  assert.match(at({ line: 9, col: 3, tag: 'h2', old: 'Hello' }).why, /interpolated/)
})

test('textedit: text split by inline markup is refused', function () {
  assert.match(at({ line: 8, col: 3, tag: 'p', old: 'Hello there' }).why, /interpolated, or split/)
})

test('textedit: twice in the region is refused, and a word inside a longer one is not a hit', function () {
  assert.match(at({ line: 10, col: 3, tag: 'ul', old: 'Item' }).why, /2 times/)
  const r = at({ line: 11, col: 3, tag: 'h3', old: 'Items' })
  assert.ok(swap(MESA, r, 'X').includes('<h3>X</h3>'))
  assert.equal(at({ line: 10, col: 7, tag: 'li', old: 'Item' }).why, undefined)
})

test('textedit: new text carrying an expression is refused; HTML\'s three are written as entities', function () {
  assert.match(at({ line: 6, col: 3, tag: 'h1', old: 'Hello world', next: 'a {b}' }).why, /markup/)
  const r = at({ line: 6, col: 3, tag: 'h1', old: 'Hello world', next: 'Fish & <chips>' })
  assert.ok(swap(MESA, r, r.text).includes('<h1 id="t">Fish &amp; &lt;chips&gt;</h1>'))
})

test('textedit: text the source wrote as an entity is found by the character the page shows', function () {
  const src = '<p>Before &amp; after &mdash; done</p>\n'
  const r = locateText(src, { ext: 'mesa', line: 1, col: 1, tag: 'p', old: 'Before & after — done', next: 'Later' })
  assert.equal(swap(src, r, r.text), '<p>Later</p>\n')
})

test('textedit: a loc the source no longer matches is refused', function () {
  assert.match(at({ line: 99, col: 1, tag: 'h1', old: 'Hello' }).why, /changed since/)
  assert.match(at({ line: 4, col: 1, tag: 'h1', old: 'Hello' }).why, /not where/)
})

test('textedit: Markdown — the body is searched, never the frontmatter, and emphasis is not plain text', function () {
  const MD = '---\ntitle: The heading\n---\n\n# The heading\n\nSome *para* text.\n'
  const r = locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: 'New heading' })
  assert.equal(swap(MD, r, 'New heading'), '---\ntitle: The heading\n---\n\n# New heading\n\nSome *para* text.\n')
  assert.match(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'p', old: 'Some para text.', next: 'x' }).why, /split/)
  assert.match(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: '*bold*' }).why, /markup/)
  assert.match(locateText(MD, { ext: 'md', line: 1, col: 1, tag: 'h1', old: 'The heading', next: 'a <b>' }).why, /markup/)
})
