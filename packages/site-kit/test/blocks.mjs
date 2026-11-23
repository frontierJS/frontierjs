/*
 * blocks.mjs — every block and layout compiles to JavaScript that parses, and
 * each one renders the markup a static page relies on.
 *
 * A clean compile is not the check (Invariant 15): Mesa can report no errors
 * and emit a module that throws on load, so the output is parsed too.
 *
 * Run: node test/blocks.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJs } from 'acorn'
// Relative, not the specifier: bun's workspace copy under node_modules/.bun is
// a snapshot from install time, so the specifier would test stale compiler code.
import { compileSource } from '../../mesa/src/compiler.js'
import { renderComponent } from '../../mesa/src/render-component.js'
import { excerptOf, patternsOf, searchPages } from '../src/site/search.js'

const ROOT   = fileURLToPath(new URL('..', import.meta.url))
const BLOCKS = join(ROOT, 'src', 'blocks')
const LAYOUTS = join(ROOT, 'src', 'layouts')
const SITE_ISLANDS = join(ROOT, 'src', 'site')
// Temp render modules land here rather than in mesa's own directory, so a
// bare import inside a layout (@frontierjs/css) resolves the way the site's does.
const TMP = join(ROOT, 'test')

const failed = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`)
  if (!ok) failed.push(label)
}

const files = [BLOCKS, LAYOUTS, SITE_ISLANDS].flatMap((dir) =>
  readdirSync(dir).filter((f) => f.endsWith('.mesa')).sort().map((f) => [f, join(dir, f)]))
for (const [name, path] of files) {
  const src = readFileSync(path, 'utf8')
  try {
    const ctx = await compileSource(src, { filename: name })
    parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
    check(`${name} compiles to parseable JS`, true)
  } catch (err) {
    check(`${name} compiles to parseable JS`, false, err.message)
  }
}

// ── Marquee ──────────────────────────────────────────────────────────────────
// The loop is seamless only if the slot renders twice, and a screen reader
// hears the items once only if the second copy is hidden.
{
  const { html } = await renderComponent(
    `<script>import Marquee from './src/blocks/Marquee.mesa'</script>
     <Marquee label="Features" duration="80s" reverse><b>one</b><b>two</b></Marquee>`,
    { cwd: ROOT, filename: 'MarqueeProbe.mesa' })

  const tracks = [...html.matchAll(/<div[^>]*class="track[^"]*"[^>]*>(.*?)<\/div>/g)]
  check('Marquee renders two tracks', tracks.length === 2, `got ${tracks.length}`)
  check('Marquee repeats the slot in both', tracks.every((m) => m[1].includes('<b>one</b><b>two</b>')))
  check('Marquee hides the second copy only',
    !/aria-hidden/.test(tracks[0]?.[0] ?? '') && /aria-hidden="true"/.test(tracks[1]?.[0] ?? ''))
  check('Marquee names its region', /role="region" aria-label="Features"/.test(html))
  check('Marquee carries duration and direction',
    /--marquee-duration: 80s/.test(html) && /class="marquee[^"]*\breverse\b/.test(html))

  const { html: bare } = await renderComponent(
    `<script>import Marquee from './src/blocks/Marquee.mesa'</script><Marquee>x</Marquee>`,
    { cwd: ROOT, filename: 'MarqueeBare.mesa' })
  check('Marquee without a label claims no region', !/role=|aria-label=/.test(bare))
}

// ── Block ────────────────────────────────────────────────────────────────────
// The element follows where the block sits (FJS-D654), and its look is the six
// typed keys, each a word @frontierjs/css ships (FJS-D823).
{
  const render = async (tag) => (await renderComponent(
    `<script>import Block from './src/layouts/Block.mesa'</script>${tag}`,
    { cwd: ROOT, tmpDir: TMP, filename: 'BlockProbe.mesa' })).html.replace(/\s+/g, ' ')
  const refusal = async (tag) => {
    try { await render(tag); return '' } catch (err) { return err.message }
  }

  const band = await render('<Block name="CallToAction" template="split" tone="muted" density="roomy" align="center"><p>x</p></Block>')
  check('a top-level Block is a Band holding a container',
    /<section class="band call-to-action muted roomy align-center"[^>]*> <div class="container split"><p>x<\/p><\/div> <\/section>/.test(band), band)

  const nested = await render('<Block nested name="Item" template="grid"><p>x</p></Block>')
  check('a nested Block is an article carrying its template', /^<article class="item grid"[^>]*> <p>x<\/p> <\/article>/.test(nested.trim()), nested)

  // A Band is 100vw, so one inside another's container overflowed the page
  // sideways (FJS-2716); the inner Block knows where it sits without `nested`.
  const inner = await render('<Block name="Outer"><Block name="Inner"><p>x</p></Block></Block>')
  check('a Block inside a Block is an article, not a second Band',
    (inner.match(/class="band/g) ?? []).length === 1 && /<article class="inner"[^>]*> <p>x<\/p> <\/article>/.test(inner), inner)
  const bare = await render('<Block tag={false}><Block name="Inner"><p>x</p></Block></Block>')
  check('a Block inside tag={false} still sits at the top', /^<section class="band inner"/.test(bare.trim()), bare)

  const link = await render('<Block url="/a"><p>x</p></Block>')
  check('a Block with a url is a link', /^<a href="\/a"|^<a [^>]*href="\/a"/.test(link.trim()) && !/band/.test(link), link)

  check('tag={false} renders the slot alone', (await render('<Block tag={false}><p>x</p></Block>')).trim() === '<p>x</p>')
  check('a stated tag is that element, not a Band',
    /^<article class="lead-form"/.test((await render('<Block tag="article" name="lead-form"><p>x</p></Block>')).trim()))

  const photo = await render('<Block background="/team.jpg"><p>x</p></Block>')
  check('background is the Band\'s photo slot', /<section class="band"[^>]*> <img[^>]*class="band-media[^"]*"[^>]*src="\/team.jpg"/.test(photo), photo)

  const bad = await refusal('<Block name="Hero" template="block-with-media"><p>x</p></Block>')
  check('a value css does not ship fails naming the key and the choices',
    /Block "Hero": template: "block-with-media" is not one of stack, cluster, center, split, grid/.test(bad), bad)
  const tone = await refusal('<Block tone="pink"><p>x</p></Block>')
  check('an unknown tone fails naming it', /tone: "pink" is not one of primary/.test(tone), tone)
  const classes = await refusal('<Block name="Solution" classes="bg-block margin-y"><p>x</p></Block>')
  check('classes: is refused, pointing at the typed keys and the site stylesheet',
    /classes: "bg-block margin-y" is not read — state template, tone/.test(classes) && /under \.solution/.test(classes), classes)
}

// ── Search and Toc ───────────────────────────────────────────────────────────
// Both are islands: the server render is only the button, and what they do
// needs a browser (test drive). Matching is a plain function, so it is read here.
{
  const render = async (tag, name) => (await renderComponent(
    `<script>import ${name} from './src/site/${name}.mesa'</script>${tag}`,
    // renderComponent resolves a bare .mesa import from mesa's own folder, where ui is not a dependency.
    { cwd: ROOT, tmpDir: TMP, filename: `${name}Probe.mesa`, alias: { '@frontierjs/ui': join(ROOT, '..', 'ui') } })).html.replace(/\s+/g, ' ')

  const search = await render('<Search />', 'Search')
  check('Search renders a labelled button and no palette until asked',
    /<button[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*aria-label="Search this site"/.test(search) && !/role="dialog"|role="combobox"/.test(search), search)
  // The island's keys are bound by code that loads late; sierra holds a key
  // the prerendered button names until it does (FJS-4510, FJS-D2312).
  check('Search\'s button names its keys in aria-keyshortcuts',
    /<button[^>]*aria-keyshortcuts="Control\+K Meta\+K \/"/.test(search), search)
  check('Toc renders no outline before it has read the page and a scroll', !/<ol|<nav/.test(await render('<Toc />', 'Toc')))

  const pages = [
    { url: '/', title: 'Home', headings: [], text: 'Welcome to Acme. We clean offices and homes.' },
    { url: '/services/', title: 'Services', headings: [{ id: 'deep-cleaning', text: 'Deep Cleaning', level: 2 }],
      text: 'Our carpet shampooing is thorough. Deep cleaning covers ovens too, and windows are washed by hand.' },
  ]
  const urls = (q) => searchPages(pages, q).map((h) => h.url)
  check('a word in a page\'s text finds that page', urls('carpet').join() === '/services/', urls('carpet').join())
  check('a heading hit links to the page with its #id', urls('deep cleaning').includes('/services/#deep-cleaning'), urls('deep cleaning').join())
  check('the word being typed matches a word\'s start', urls('shamp').join() === '/services/' && urls('clean').includes('/services/'), urls('clean').join())
  check('a finished word matches whole, not as the start of a longer one', urls('clean ').join() === '/' && urls('clean acme').join() === '/', urls('clean ').join())
  check('a word\'s start is not its middle', urls('ampoo').length === 0)
  check('every word must be present', urls('carpet windows').join() === '/services/' && urls('carpet acme').length === 0)
  check('a blank query finds nothing', searchPages(pages, '  ').length === 0)
  check('regex characters in a query are plain letters', searchPages(pages, '(.*').length === 0 && patternsOf('a.c')[0].test('abc') === false)
  const ex = excerptOf(pages[1].text, patternsOf('windows'))
  check('an excerpt holds the matched word and is shorter than the page', ex.includes('windows') && ex.length < pages[1].text.length, ex)
}

if (failed.length) {
  console.error(`\n${failed.length} failed`)
  process.exit(1)
}
