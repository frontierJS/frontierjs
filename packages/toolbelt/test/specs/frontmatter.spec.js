/*
 * frontmatter.spec.js
 *
 * Two properties. What the subset admits it reads as YAML reads it — the rows
 * below were checked against js-yaml's core schema, and so was every frontmatter
 * block in this repo and the Kobami client sites (1,466 of them, all equal). What
 * it does not admit it REFUSES, naming the line: the reader this replaced in
 * mesa answered a wrong object without a word (`FJS-1541`).
 */

import { parseFrontmatter, parseFrontmatterBlock as read, splitFrontmatter } from '../../src/frontmatter/frontmatter.js'

const doc = (...lines) => lines.join('\n')

// ─── ksite's shapes ──────────────────────────────────────────────────────────

test('frontmatter: a list of maps at the key\'s own column, two deep (ksite menus)', function () {
  const fm = read(doc(
    'items:',
    '-',
    '  name: About Us',
    '  link: /about-us/',
    '-',
    '  name: Services',
    '  items:',
    '  -',
    '    name: Deep Cleaning',
    '    link: /services/deep-cleaning/',
    '-',
  ))
  assert.deepEqual(fm, {
    items: [
      { name: 'About Us', link: '/about-us/' },
      { name: 'Services', items: [{ name: 'Deep Cleaning', link: '/services/deep-cleaning/' }] },
      null,
    ],
  })
})

test('frontmatter: a map opening on the dash\'s line, and a list inside it', function () {
  const fm = read(doc(
    'categories:',
    '  - name: Kitchen',
    '    items:',
    '      - name: Sink',
    '        deep: included',
    '      - name: Oven',
    '        deep: false',
    '  - name: Bath',
  ))
  assert.deepEqual(fm, {
    categories: [
      { name: 'Kitchen', items: [{ name: 'Sink', deep: 'included' }, { name: 'Oven', deep: false }] },
      { name: 'Bath' },
    ],
  })
})

test('frontmatter: a | block keeps its lines, and a > block folds them', function () {
  const fm = read(doc(
    'hero_text: |',
    '  First line.',
    '  <br /> <br />',
    '  Third line.',
    'summary: >',
    '  one',
    '  two',
    '',
    '  three',
    '    kept as written',
    '  four',
    'title: After',
  ))
  assert.equal(fm.hero_text, 'First line.\n<br /> <br />\nThird line.\n')
  assert.equal(fm.summary, 'one two\nthree\n  kept as written\nfour\n')
  assert.equal(fm.title, 'After')
})

test('frontmatter: chomping and an explicit indent', function () {
  assert.equal(read('a: |-\n  x\n\n').a, 'x')
  assert.equal(read('a: |+\n  x\n\n\nb: 1').a, 'x\n\n\n')
  assert.equal(read('a: |2\n    x\n   y').a, '  x\n y\n')
  assert.equal(read('a: |\n  # not a comment\n  x').a, '# not a comment\nx\n')
})

// ─── scalars ─────────────────────────────────────────────────────────────────

test('frontmatter: scalars resolve by the YAML 1.2 core schema', function () {
  const fm = read(doc(
    'int: 007', 'neg: -3', 'float: 1.10', 'exp: 1e3', 'hex: 0x1F', 'oct: 0o17',
    'yes: yes', 'on: on', 'bool: True', 'nul: ~', 'empty:', 'time: 12:30',
    'date: 2024-01-05', 'stamp: 2024-01-05T10:00:00Z', 'bin: 0b101',
  ))
  assert.deepEqual(fm, {
    int: 7, neg: -3, float: 1.1, exp: 1000, hex: 31, oct: 15,
    // YAML 1.1's booleans and timestamps are text in 1.2, and so is binary.
    yes: 'yes', on: 'on', bool: true, nul: null, empty: null, time: '12:30',
    date: '2024-01-05', stamp: '2024-01-05T10:00:00Z', bin: '0b101',
  })
  assert.equal(read('a: .inf').a, Infinity)
  assert.ok(Number.isNaN(read('a: .NaN').a))
})

test('frontmatter: comments, colons and quotes', function () {
  const fm = read(doc(
    'url: http://x.com/a#b',
    'note: kept # dropped',
    'quoted: "q: r" # dropped',
    "single: 'it''s'",
    'double: "t\\tb\\u00e9\\x41"',
    '"spaced key": 1',
    'long: this is',
    '  continued',
    '',
    '  in two paragraphs',
  ))
  assert.deepEqual(fm, {
    url: 'http://x.com/a#b', note: 'kept', quoted: 'q: r', single: "it's",
    double: 't\tbéA', 'spaced key': 1, long: 'this is continued\nin two paragraphs',
  })
})

test('frontmatter: flow collections, over several lines', function () {
  const fm = read(doc(
    'tags: [a, "two words", 3, [4, 5], {k: v}]',
    'at: {url: http://y.z, n: null}',
    'multi: [a,',
    '  b, # a comment',
    '  c,]',
    'none: []',
  ))
  assert.deepEqual(fm, {
    tags: ['a', 'two words', 3, [4, 5], { k: 'v' }],
    at: { url: 'http://y.z', n: null },
    multi: ['a', 'b', 'c'],
    none: [],
  })
})

test('frontmatter: `__proto__` is an own key, not the prototype', function () {
  const fm = read('__proto__: 1\nb: 2')
  assert.ok(Object.hasOwn(fm, '__proto__'))
  assert.equal(Object.getPrototypeOf(fm), Object.prototype)
  assert.deepEqual(Object.keys(fm), ['__proto__', 'b'])
})

// ─── refusals ────────────────────────────────────────────────────────────────

test('frontmatter: what YAML has and this does not read is refused by name', function () {
  assert.throws(() => read('a: &x 1'), /line 1: an anchor/)
  assert.throws(() => read('a: 1\nb: *x'), /line 2: an alias/)
  assert.throws(() => read('a: !!str 1'), /a tag/)
  assert.throws(() => read('<<: {a: 1}'), /a merge key/)
  assert.throws(() => read('? a\n: b'), /a complex key/)
  assert.throws(() => read('%YAML 1.2'), /a directive/)
  assert.throws(() => read('a: b\n...'), /a document end/)
  assert.throws(() => read('a:\n\tb: 1'), /line 2: .*tab/)
  assert.throws(() => read('a: @handle'), /quote it/)
  assert.throws(() => read('a: [k: v]'), /inside \{ \}/)
})

test('frontmatter: a block YAML itself would refuse is refused', function () {
  assert.throws(() => read('description: what it is: and why'), /quote this value/)
  assert.throws(() => read('a: 1\n  b: 2'), /line 2: .*indented deeper/)
  assert.throws(() => read('a: 1\nb: 2\na: 3'), /line 3: `a` is declared twice/)
  assert.throws(() => read('a: - b'), /starts on the line after its key/)
  assert.throws(() => read('a: "x" y'), /after the closing quote/)
  assert.throws(() => read('a: [1,,2]'), /an empty entry/)
  assert.throws(() => read('a: [\n'), /never closes/)
  assert.throws(() => read('a: "x'), /never closes/)
  assert.throws(() => read('a: "\\q"'), /not an escape/)
  assert.throws(() => read('- a\n- b'), /`key: value` lines/)
  assert.throws(() => read('just text'), /`key: value` lines/)
})

test('frontmatter: the FJS-821 alias bomb is refused at its first anchor', function () {
  const bomb = doc(
    'a: &a ["x","x","x","x","x","x","x","x","x"]',
    'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
    'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
  )
  assert.throws(() => read(bomb), /line 1: an anchor/)
})

test('frontmatter: nesting is bounded, and refused by name rather than by the stack', function () {
  assert.throws(() => read('a: ' + '['.repeat(5000) + ']'.repeat(5000)), /nested more than 100 deep/)
  const stairs = Array.from({ length: 500 }, (_, k) => ' '.repeat(k) + 'k:').join('\n')
  assert.throws(() => read(stairs), /nested more than 100 deep/)
})

// ─── the fence ───────────────────────────────────────────────────────────────

test('frontmatter: the fence, and line numbers counted from the top of the file', function () {
  assert.deepEqual(parseFrontmatter('---\ntitle: A\n---\nbody'), { frontmatter: { title: 'A' }, body: 'body' })
  assert.deepEqual(parseFrontmatter('---\r\ntitle: W\r\n---\r\n<h1>'), { frontmatter: { title: 'W' }, body: '<h1>' })
  assert.deepEqual(parseFrontmatter('---\n---\nbody'), { frontmatter: {}, body: 'body' })
  assert.deepEqual(parseFrontmatter('---\ntitle: A\n---'), { frontmatter: { title: 'A' }, body: '' })
  assert.deepEqual(parseFrontmatter('<h1>no fence</h1>'), { frontmatter: {}, body: '<h1>no fence</h1>' })
  assert.deepEqual(parseFrontmatter('---\n{}\n---\nx'), { frontmatter: {}, body: 'x' })

  assert.deepEqual(splitFrontmatter('---\na: &x\n---\nbody'), { block: 'a: &x', body: 'body' })
  assert.deepEqual(splitFrontmatter('body'), { block: null, body: 'body' })

  let err = null
  try { parseFrontmatter('---\ntitle: A\nb: &x 1\n---\n') } catch (e) { err = e }
  assert.equal(err && err.line, 3)
  assert.match(err && err.message, /^line 3: /)
})
