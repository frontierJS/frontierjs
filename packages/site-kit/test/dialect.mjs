/*
 * dialect.mjs — site-kit's Markdown dialect, compiled through Mesa's own
 * compileMd with the plugins siteDialect() hands Sierra.
 *
 * The page under test is shaped like a real client page (a ksite site's
 * spa/index.md): a band per `====`, two articles in some, a `====|block`
 * closing the last band before a component. Each case asserts on the HTML the
 * Markdown step produced and parses the module Mesa compiled from it, because
 * a clean compile is not proof of valid JS (Invariant 15).
 *
 * Run: node test/dialect.mjs
 */
import { parse as parseJs } from 'acorn'
import { classesIn, siteDialect } from '../config/dialect.js'
import { telHref } from '../src/tel.js'
// Relative, not the specifier: bun's workspace copy under node_modules/.bun is
// a snapshot from install time, so the specifier would test stale compiler code.
import { compileMd } from '../../mesa/src/compiler-md.js'

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const PAGE = '/site/content/routes/spa/index.md'

async function compile(md, dialect = siteDialect(), filename = PAGE) {
  const ctx = await compileMd(md, {
    filename,
    remarkPlugins: dialect.remarkPlugins,
    rehypePlugins: dialect.rehypePlugins,
  })
  parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  return ctx.markdownHTML
}

async function refuses(label, md, pattern) {
  try {
    await compile(md)
    check(label, false, 'compiled')
  } catch (err) {
    check(label, pattern.test(err.message), err.message)
  }
}

const count = (html, re) => (html.match(re) ?? []).length

// ── Bands and articles ───────────────────────────────────────────────────────
{
  const dialect = siteDialect()
  const html = await compile(`
Intro before any band.

====|.duo.split.muted

WELCOME

## Welcome to the spa

Beyond the doors.

===

<p>photo</p>

====|.prose.align-center

## Flow between experiences

====|block

<p>after the close</p>
`, dialect)

  check('every ==== opens one band, and text ahead of the first is a band too',
    count(html, /<section class="band/g) === 3, html)
  check('a band holds its content in a .container',
    count(html, /<div class="container/g) === 3)
  check('a template word lands on the container, other words on the band',
    html.includes('<section class="band muted duo"><div class="container split">'), html)
  check('align-center is the align axis, emitted as written',
    html.includes('<section class="band align-center prose"><div class="container">'))
  check('=== splits a band into articles, the first taking what came before it',
    count(html, /<article>/g) === 2 && /<article>\s*<p class="kicker">WELCOME<\/p>/.test(html), html)
  check('no divider survives as text', !/===/.test(html))
  check('no positional class is emitted', !/segment|article-\d/.test(html))
  check('====|block returns to plain flow',
    /<\/div><\/section>\s*<p>after the close<\/p>\s*$/.test(html.trim()), html.slice(-200))
  check('the site\'s own words are recorded for the build\'s check, css words are not',
    JSON.stringify(dialect.remarkPlugins[0][1].words.get(PAGE).map((w) => w.word)) === JSON.stringify(['duo', 'prose']))
}

// ── === with no ==== ─────────────────────────────────────────────────────────
{
  const html = await compile('<p>image</p>\n\n===|.featured\n\n# Title\n')
  check('=== alone splits the file into articles',
    /^<article>\s*<p>image<\/p>\s*<\/article>\s*<article class="featured">/.test(html.trim()), html)
  check('=== alone makes no band', !/<section/.test(html))
}

// ── A recompile drops what the file no longer names ─────────────────────────
{
  const dialect = siteDialect()
  const words = dialect.remarkPlugins[0][1].words
  await compile('====|.old\n\ntext\n', dialect)
  await compile('====|.new\n\ntext\n', dialect)
  check('a file\'s words are replaced on each compile', JSON.stringify(words.get(PAGE).map((w) => w.word)) === '["new"]')
  await compile('no dividers\n', dialect)
  check('a file with no dividers left records none', !words.has(PAGE))
}

// ── Refusals ─────────────────────────────────────────────────────────────────
await refuses('a word before the first "." is refused, naming the spelling to use',
  '====|aside.duo\n\ntext\n', /"aside" before the first "\." names nothing — write ====\|\.aside/)
await refuses('two words on one axis are refused',
  '====|.muted.danger\n\ntext\n', /two tone words, "muted" and "danger"/)
await refuses('a word that is not a class name is refused',
  '====|.2col\n\ntext\n', /"2col" is not a class name/)
await refuses('===|block is not a closer',
  'a\n\n===|block\n\nb\n', /"block" before the first "\." names nothing/)

// ── Prose: kickers, mark, autolinks ──────────────────────────────────────────
{
  const html = await compile(`
THE EXPERIENCES

## Seven ways to restore

A line with ==quiet== in it.

Call (512) 555-0134 or write hello@example.com today.

[Already linked 512-555-0134](/contact)

\`code 512-555-0134 ==no==\`

Order #20261012345 is not a phone.

**BOLD AND CAPS**

Not A Kicker
`)
  check('a capitals paragraph before a heading is a Kicker', html.includes('<p class="kicker">THE EXPERIENCES</p>'), html)
  check('a capitals paragraph of strong text is a Kicker too', html.includes('<p class="kicker"><strong>BOLD AND CAPS</strong></p>'))
  check('mixed case is not a Kicker', html.includes('<p>Not A Kicker</p>'))
  check('==text== is <mark>', html.includes('A line with <mark>quiet</mark> in it.'))
  check('a phone number is a tel: link', html.includes('<a href="tel:+15125550134">(512) 555-0134</a>'), html)
  check('an email address is a mailto: link', html.includes('<a href="mailto:hello@example.com">hello@example.com</a>'))
  check('text already in a link is left alone', html.includes('<a href="/contact">Already linked 512-555-0134</a>'))
  check('code is left alone', html.includes('512-555-0134 ==no=='))
  check('digits inside a longer number are not a phone', !/tel:\+1202610123/.test(html))
}

// ── telHref: the setting a preset's block links ──────────────────────────────
{
  const cases = [
    ['(512) 694-1497', 'tel:+15126941497'],
    ['512.694.1497', 'tel:+15126941497'],
    ['1-512-694-1497', 'tel:+15126941497'],
    ['+44 20 7946 0958', 'tel:+442079460958'],
    ['', ''],
    [undefined, ''],
  ]
  for (const [input, want] of cases) check(`telHref(${JSON.stringify(input)}) is ${want || "''"}`, telHref(input) === want, telHref(input))
}

// ── The build's check ────────────────────────────────────────────────────────
{
  const css = '/* .commented {} */ .band{} .duo .x, a.prose:hover{background:url(a.png)} .md\\:flex{} @media (min-width:1.5rem){.night{}}'
  const found = classesIn(css)
  check('classesIn reads compound, nested and escaped selectors',
    ['band', 'duo', 'x', 'prose', 'night', 'md'].every((c) => found.has(c)), [...found].join(' '))
  check('classesIn ignores comments, urls and numbers',
    !found.has('commented') && !found.has('png') && !found.has('5rem'))

  const dialect = siteDialect()
  await compile('====|.duo\n\nx\n\n====|.dou\n\ny\n', dialect)
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const out = mkdtempSync(join(tmpdir(), 'site-kit-words-'))
  writeFileSync(join(out, 'index.css'), '.duo{}')
  try {
    dialect.check.closeBundle({ outDir: out, root: '/site' })
    check('a word no stylesheet defines stops the build', false, 'closeBundle returned')
  } catch (err) {
    check('a word no stylesheet defines stops the build, naming file, divider and word',
      /content\/routes\/spa\/index\.md {2}====\|\.dou {2}"dou"/.test(err.message) && !/"duo"/.test(err.message), err.message)
  }
  writeFileSync(join(out, 'index.css'), '.duo{} .dou{}')
  let threw = null
  try { dialect.check.closeBundle({ outDir: out, root: '/site' }) } catch (err) { threw = err }
  check('every word defined, the build goes on', threw === null, threw?.message)
}

if (failed.length) {
  console.log(`\n${failed.length} failed`)
  process.exit(1)
}
