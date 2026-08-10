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
