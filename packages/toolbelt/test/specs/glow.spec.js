/*
 * glow.spec.js — the highlighter may not change the code it highlights.
 *
 * A highlighter has exactly one way to be catastrophically wrong and it is
 * silent: it drops or mangles a character, the output still looks like code,
 * and the reader copies a sample that does not work. Every test below is
 * ultimately that one property; the rest pin the contract the CSS theme in
 * @frontierjs/css depends on.
 *
 * The corpus is 137 real samples from the @frontierjs/css guide — CSS, HTML,
 * JS, shell — refreshed by test/fixtures/extract.mjs. Hand-written cases test
 * what the corpus happens not to contain.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { glow } from '../../src/glow/glow.js'

const here = dirname(fileURLToPath(import.meta.url))
const SAMPLES = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'guide-samples.json'), 'utf8'))

const LANGS = ['css', 'html', 'js', 'ts', 'bash', 'json', 'yaml', 'md']

/*
 * Strip EVERY tag, not just the ones glow is supposed to emit. That is what
 * makes this a real test: if glow ever failed to escape a `<div>` in the
 * source, a whitelist strip would leave it alone and the comparison would
 * pass, while a strip-all removes it and the text comes back short.
 */
function textOf(html) {
  return html
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/* ── The one property that matters ─────────────────────────────────── */

test('glow: every guide sample survives every language, unchanged', function () {
  const broken = []

  SAMPLES.forEach(function (src, n) {
    LANGS.forEach(function (language) {
      const got = textOf(glow(src, { language, prefix: false }))
      if (got !== src) broken.push('#' + n + ' as ' + language)
    })
  })

  assert.equal(
    broken.length,
    0,
    'glow changed the source text of:\n        ' + broken.slice(0, 12).join('\n        ')
  )
})

test('glow: the corpus is not empty', function () {
  /*
   * The test above passes trivially over an empty array, and the fixture is
   * generated — a broken extractor would write [] and turn the suite green
   * while testing nothing.
   */
  assert.ok(SAMPLES.length > 100, 'expected the full guide corpus, got ' + SAMPLES.length)
})

/* ── Escaping ──────────────────────────────────────────────────────── */

test('glow: markup in the source is escaped, not emitted', function () {
  const out = glow('<div class="card">hi</div>', { language: 'html' })
  assert.ok(!/<div/.test(out), 'a raw <div> reached the output')
  assert.ok(out.includes('&lt;'), 'the < was not escaped')
})

test('glow: an unclosed angle bracket does not swallow the rest', function () {
  const src = 'if (a < b && c > d) return'
  assert.equal(textOf(glow(src, { language: 'js' })), src)
})

test('glow: an ampersand is escaped, in a token and between tokens', function () {
  /*
   * encode() handled `<` and `>` and left `&` alone, so a source line reading
   * `&amp;` came back as `&amp;` in the HTML and rendered as a bare `&` — the
   * text the author wrote was not the text the reader saw. `&` is escaped
   * FIRST now, or the ampersand of `&lt;` would be escaped a second time.
   */
  const cases = ['a && b', 'const s = "&amp;"', 'x = a&b', '&nbsp;']
  cases.forEach(function (src) {
    assert.equal(textOf(glow(src, { language: 'js', prefix: false })), src, 'lost: ' + src)
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(glow(src, { language: 'js', prefix: false })),
      'a bare & reached the output for: ' + src)
  })
})

test('glow: a language that does not tokenise a bracket still escapes it', function () {
  /*
   * The slice BETWEEN two tokens is as raw as a token is. It passed for years
   * because `<`, `>` and `&` are punctuation rules in most languages and so
   * arrive as tokens; a language whose rules skip them sent them to the page.
   */
  const src = 'plain text with <b>markup</b> & an ampersand'
  const out = glow(src, { language: 'bash', prefix: false })
  assert.ok(!/<b>markup<\/b>/.test(out), 'raw markup reached the output')
  assert.equal(textOf(out), src)
})

/* ── The line-prefix trap ──────────────────────────────────────────── */

test('glow: a CSS custom property keeps both dashes with prefixes on', function () {
  /*
   * `-` at the start of a line marks a removed line and the marker is
   * stripped, so `--tint-surface: …` used to render as `-tint-surface: …`.
   * Two dashes are never a diff marker, so the two features can coexist.
   */
  const src = '--tint-surface: color-mix(in srgb, var(--bg-mix) 10%, var(--surface));'
  assert.equal(textOf(glow(src, { language: 'css', prefix: true })), src)
})

test('glow: the diff markers still work', function () {
  const out = glow(['+ added', '- removed', '> noted'].join('\n'), { language: 'js', prefix: true })
  assert.ok(out.includes('<ins>'), 'a + line is not an <ins>')
  assert.ok(out.includes('<del>'), 'a - line is not a <del>')
  assert.ok(out.includes('<dfn>'), 'a > line is not a <dfn>')
  /* The marker itself is consumed — that is the feature, not a leak. */
  assert.ok(!textOf(out).includes('+ added'), 'the + marker was left in the text')
})

test('glow: prefix:false leaves the first column alone', function () {
  const src = ['+ .sibling { color: red }', '> .child { color: blue }'].join('\n')
  assert.equal(textOf(glow(src, { language: 'css', prefix: false })), src)
})

/* ── The contract components/code.css relies on ────────────────────── */

test('glow: every emitted tag is bare — no classes, no attributes', function () {
  /*
   * The theme in @frontierjs/css is written entirely as `code[language] em`
   * and friends. An attribute on an emitted tag would mean a consumer has to
   * import a class contract to style highlighted code, and would put a name
   * in the vocabulary that vocabulary.js does not carry.
   *
   * Checking the raw string for `class=` does not work: the samples are
   * mostly HTML, so `class="card"` appears constantly as escaped *content*.
   * The question is about the tags glow itself opens.
   */
  const bare = /^<\/?[a-z]+>$/
  const offenders = []

  SAMPLES.forEach(function (src, n) {
    const out = glow(src, { language: 'html', prefix: false })
    const body = out.replace(/^<code language="[^"]*">/, '').replace(/<\/code>$/, '')
    ;(body.match(/<\/?[a-zA-Z][^>]*>/g) || []).forEach(function (tag) {
      if (!bare.test(tag)) offenders.push('#' + n + ' ' + tag)
    })
  })

  assert.equal(offenders.length, 0, 'tag with an attribute:\n        ' + offenders.slice(0, 8).join('\n        '))
})

test('glow: the wrapper names the language', function () {
  assert.ok(glow('a { color: red }', { language: 'css' }).startsWith('<code language="css">'))
  /* No language is `*`, so a theme can still key on the attribute. */
  assert.ok(glow('hello').startsWith('<code language="*">'))
})

test('glow: numbered mode wraps each line in a span', function () {
  const out = glow('one\ntwo\nthree', { language: 'js', numbered: true })
  assert.equal((out.match(/<span>/g) || []).length, 3)
})

/* ── Purity ────────────────────────────────────────────────────────── */

test('glow: same input, same output', function () {
  const src = SAMPLES[0]
  assert.equal(glow(src, { language: 'css' }), glow(src, { language: 'css' }))
})

test('glow: an array argument is not mutated', function () {
  const lines = ['a { color: red }', 'b { color: blue }']
  const copy = lines.slice()
  glow(lines, { language: 'css' })
  assert.equal(lines.join('\n'), copy.join('\n'))
})

test('glow: empty input is an empty string, not a throw', function () {
  assert.equal(glow(''), '')
  assert.equal(glow(null), '')
  assert.equal(glow([]), '')
})

/* ── Comments ──────────────────────────────────────────────────────── */

test('glow: a trailing block comment does not swallow the code before it', function () {
  /*
   * `/* … *\/` after a declaration is the ordinary way to annotate one line
   * of CSS, and the whole line used to come back as a single <sup> — which
   * renders as a disabled line and hides the declaration being annotated.
   * A whole-line comment must still be one, and a block that runs on must
   * still run on, so all three shapes are asserted together.
   */
  const out = glow(
    ['/* a whole line */', '  --x: 1;   /* trailing */', '/* opens', '   and closes */'].join('\n'),
    { language: 'css', prefix: false }
  )
  const lines = out.replace(/^<code[^>]*>/, '').replace(/<\/code>$/, '').split('\n')

  assert.ok(lines[0].startsWith('<sup>'), 'a whole-line comment is a comment')
  assert.ok(/<em>--x<\/em>/.test(lines[1]), 'the annotated declaration is still highlighted')
  assert.ok(/<sup>\/\* trailing \*\/<\/sup>/.test(lines[1]), 'the trailing comment is a comment')
  assert.ok(lines[2].startsWith('<sup>'), 'a block that runs on is not stolen')
  assert.ok(lines[3].startsWith('<sup>'), 'and its second line stays inside it')
})

test('glow: a multi-character token is escaped', function () {
  /*
   * Every token is a raw slice of the source. elem() encoded a token that
   * was a lone < or >, which held for as long as no rule matched more than
   * one character — a comment carrying a tag then reached the page as live
   * markup rather than as text.
   */
  const cases = [
    ['const a = 1 // see <div> here', 'js'],
    ['<p>x</p><!-- <script>bad</script> -->', 'html']
  ]

  cases.forEach(function ([src, language]) {
    const out = glow(src, { language, prefix: false })
    const body = out.replace(/^<code[^>]*>/, '').replace(/<\/code>$/, '')
    ;(body.match(/<\/?[a-zA-Z][^>]*>/g) || []).forEach(function (tag) {
      assert.ok(
        /^<\/?(b|i|u|em|del|ins|sup|dfn|mark|span|label|strong)>$/.test(tag),
        'source markup reached the output as a tag: ' + tag + ' in ' + language
      )
    })
  })
})

test('glow: JSON has three keywords and they are not the strings that spell them', function () {
  /*
   * `getTags` withholds the COMMON_WORDS keyword pass from json, yaml and html
   * — rightly, since in a JSON document every other bare word is inside a
   * string. That left `true`, `false` and `null` as the only values in a
   * highlighted document with no colour at all (FJS-405).
   *
   * The half that matters is the negative one: a document where the same three
   * words appear inside strings has to come back with those strings whole.
   * Nothing in the tag ORDER protects them — a rule added to RULES.json is
   * unshifted to the front of the list — so this is asserting the property
   * renderRow provides instead, that a token opening inside one already
   * emitted is dropped.
   */
  const src = JSON.stringify(
    { ok: true, off: false, none: null, null: 'is null', note: 'true story' },
    null,
    2
  )
  const out = glow(src, { language: 'json', prefix: false })

  assert.ok(out.includes('<strong>true</strong>'), 'true is not marked as a keyword')
  assert.ok(out.includes('<strong>false</strong>'), 'false is not marked as a keyword')
  assert.ok(out.includes('<strong>null</strong>'), 'null is not marked as a keyword')

  assert.ok(out.includes('<em>"is null"</em>'), 'a keyword inside a string broke the string')
  assert.ok(out.includes('<em>"true story"</em>'), 'a keyword inside a string broke the string')
  assert.ok(out.includes('<b>"null"</b>'), 'a key spelled like a keyword stopped being a key')

  // The three are keywords in every other language already, through
  // COMMON_WORDS. This is the language that had to be told.
  assert.ok(glow('const a = null', { language: 'js', prefix: false }).includes('<strong>null</strong>'))
})

/* ── The languages this repo writes ────────────────────────────────── */

test('glow: a .lite schema is highlighted as one', function () {
  /*
   * Litestone's seed language went through the generic pass, where the two
   * things a schema is made of both came out wrong: a model-level attribute
   * is written `@@gate` and the generic attribute rule can only take one
   * `@`, so it matched at the second one and left the first as a stray
   * punctuation mark; and a field's TYPE was coloured only when the common
   * keyword list happened to contain it case-insensitively, so `Int` and
   * `String` were lit and `DateTime` and `Json` were not.
   */
  const src = [
    'model Lead {',
    '  createdAt DateTime @default(now())',
    '  payload   Json?',
    '  @@gate("0.4.4.5")',
    '}'
  ].join('\n')
  const out = glow(src, { language: 'lite', prefix: false })

  assert.equal(textOf(out), src)
  assert.ok(out.includes('<strong>model</strong>'), 'model is not a keyword')
  assert.ok(out.includes('<label>@@gate</label>'), 'a model attribute lost its first @')
  assert.ok(out.includes('<label>@default</label>'), 'a field attribute is not an attribute')
  assert.ok(out.includes('<strong>DateTime</strong>'), 'a field type is not marked')
  assert.ok(out.includes('<strong>Json</strong>'), 'a field type is not marked')
})

test('glow: a shell line has a command and no keywords', function () {
  /*
   * `my`, `use`, `end`, `local`, `next`, `get` and `set` are all in the
   * common keyword list and all ordinary argument text, so `cd my-app` came
   * out with `my` coloured as a keyword and `-app` as punctuation after it —
   * the directory name the reader is meant to type, in three pieces.
   */
  const src = '$ npm create frontier@latest my-app && cd my-app --force'
  const out = glow(src, { language: 'sh', prefix: false })

  assert.equal(textOf(out), src)
  assert.ok(!out.includes('<strong>my</strong>'), 'an argument word was coloured as a keyword')
  assert.ok(out.includes('<b>my-app</b>'), 'a hyphenated argument was split')
  assert.ok(out.includes('<strong>npm</strong>'), 'the command is not marked')
  assert.ok(out.includes('<strong>cd</strong>'), 'the command after && is not marked')
  assert.ok(out.includes('<label>--force</label>'), 'a flag is not marked')

  // The three spellings are one language.
  for (const language of ['bash', 'shell'])
    assert.ok(glow('$ cd my-app', { language, prefix: false }).includes('<b>my-app</b>'),
      language + ' does not get the shell rules')
})

test('glow: a SQL statement is highlighted by its keywords', function () {
  /*
   * The shape of DDL is its keywords, and they were the only part of it not
   * marked: nothing in the common word list is SQL, so a CREATE TABLE came
   * out as one unlit line with its string literals coloured. `--` is the
   * line comment, which the generic `//` would have missed as well.
   */
  const src = [
    '-- generated',
    'CREATE TABLE leads (',
    "  status TEXT NOT NULL DEFAULT 'new'",
    ');'
  ].join('\n')
  const out = glow(src, { language: 'sql', prefix: false })

  assert.equal(textOf(out), src)
  assert.ok(out.includes('<sup>-- generated</sup>'), '-- is not a comment')
  for (const kw of ['CREATE', 'TABLE', 'NOT', 'NULL', 'DEFAULT', 'TEXT'])
    assert.ok(out.includes(`<strong>${kw}</strong>`), kw + ' is not a keyword')
  assert.ok(out.includes("<em>'new'</em>"), 'the literal stopped being a value')
})

test('glow: a transcript may name more than one language', function () {
  /*
   * A command and the SQL it compiled to is one block and two languages, and
   * given either one alone half of it goes dark: under `js` the `--` comment
   * is two punctuation marks and SELECT is a bare word, under `sql` the `//`
   * comment is not a comment. The first entry stays the primary one — it is
   * what the wrapper's `language` attribute carries.
   */
  const src = [
    'await db.lead.findMany()   // as user 42',
    '-- the SQL actually executed:',
    "SELECT * FROM leads WHERE ownerId = 42"
  ].join('\n')
  const out = glow(src, { language: ['js', 'sql'], prefix: false })

  assert.equal(textOf(out), src)
  assert.ok(out.includes('<code language="js">'), 'the primary language is not the attribute')
  assert.ok(out.includes('<sup>// as user 42</sup>'), 'the js comment was lost')
  assert.ok(out.includes('<sup>-- the SQL actually executed:</sup>'), 'the sql comment was lost')
  assert.ok(out.includes('<strong>SELECT</strong>'), 'the sql keywords were lost')
  assert.ok(out.includes('<strong>await</strong>'), 'the js keywords were lost')

  // A lone language is the same call it always was.
  assert.equal(glow(src, { language: 'js', prefix: false }),
    glow(src, { language: ['js'], prefix: false }))
})
