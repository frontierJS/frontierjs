/**
 * tests/verify.mjs — the frontierjs.com drive.
 *
 * The site is a marketing page, so what has to be proved is narrow and the
 * failures are all silent ones:
 *
 *   1. **The words are IN THE FILE.** The point of moving off hand-written HTML
 *      is not to lose what hand-written HTML already had. A page whose content
 *      arrives from a fetch looks identical in a browser and empty to a crawler.
 *   2. **The code samples survived the port.** They go through `{@html}`, which
 *      means a mistake there is a page that renders `undefined` or raw tags —
 *      and the samples are the product.
 *   3. **The layout wrapped it**, once, from one file rather than thirteen.
 *   4. **The theme switch works on a built page.** It is the only interactive
 *      thing here and therefore the only island; a static page ships no script,
 *      so "it worked in dev" proves nothing about what deploys.
 *
 *   bun run build
 *   node tests/verify.mjs
 *
 * Prints every check's value, then exits 1 naming the ones that failed.
 *
 * Needs Chrome on PATH or $FJS_CHROME. Nothing to sign in to, no API.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative }     from 'node:path'
import { fileURLToPath }               from 'node:url'
import { openChrome }                  from '../../packages/mesa/src/drive.js'

import { serveSite } from '@frontierjs/sierra/site/serve'
import settings     from '../site/content/settings/site.js'

const HERE   = dirname(fileURLToPath(import.meta.url))
const SITE   = join(HERE, '..', 'site')
const KIT    = join(HERE, '..', 'packages', 'site-kit')
const DIST   = join(SITE, 'dist')
const SRC_ROUTES = join(SITE, 'content', 'routes')
// test / siteServe / project 9 (`website`) — its own slot, so it cannot collide
// with a dev server somebody has open on 8790.
const PORT   = Number(process.env.SITE_SERVE_PORT ?? 7790)

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}.\nRun: bun run build`)
  process.exit(1)
}

// The pitch is the page the content checks are about; `/` is a splash that
// hands off to it and to the journey.
const html   = readFileSync(join(DIST, 'pitch', 'index.html'), 'utf8')
const splash = readFileSync(join(DIST, 'index.html'), 'utf8')
// One package page, read as a crawler reads it. The eight hand-written files
// this replaces each shipped an empty <div id="page"> that a classic script
// filled in on load, so this is the assertion the port exists for.
const pkgHtml = readFileSync(join(DIST, 'litestone', 'index.html'), 'utf8')
const server = await serveSite({ dir: DIST, port: PORT })
const ORIGIN = `http://localhost:${PORT}`

// A check passes when its value holds no `false` at any depth, unless it states
// its own test. A check whose failure is not a `false` states one: a list of
// offenders is clean when EMPTY, a count when it is the count. Left on the
// default, those print their failure in the report and pass.
const noFalse = (v) => v !== false &&
  (v === null || typeof v !== 'object' || Object.values(v).every(noFalse))
const none     = (v) => v.length === 0
const counted  = (v) => typeof v === 'number' ? v > 0 : Object.values(v).every((n) => n > 0)
const balanced = (v) => new Set(Object.values(v)).size === 1

const got = {}
const failed = []
const t = (label, value, ok = noFalse) => {
  got[label] = value
  if (!ok(value)) failed.push(label)
}

// Every built page as one string, for the questions that are about the COPY
// rather than about one page.
const allHtml = (function all(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'assets' ? [] : all(join(dir, e.name)))
                    : (e.name.endsWith('.html') ? [readFileSync(join(dir, e.name), 'utf8')] : []))
})(DIST).join('\n')

// ─── the file ─────────────────────────────────────────────────────────────

t('raw.headline',   html.includes('The schema<br') && html.includes('is the app.'))
t('raw.everySection', ['idea', 'code', 'packages', 'extend', 'vision', 'start']
  .filter(id => !html.includes(`id="${id}"`)), none)
t('raw.packagesTable', (() => {
  const tbl = (html.match(/<table[^>]*class="table[^>]*>[\s\S]*?<\/table>/) ?? [''])[0]
  return (tbl.match(/<tr[ >]/g) ?? []).length
})(), counted)

// The samples went through {@html}. A miss there is `undefined` in a <pre>, or
// escaped tags where highlighting should be — both of which render as a page.
const pres = html.match(/<pre[^>]*>[\s\S]*?<\/pre>/g) ?? []
t('samples.count',      pres.length, counted)
t('samples.noUndefined', !/<pre[^>]*>\s*undefined/.test(html))
// The five named entities the samples use, `&amp;` last so an escape written
// by the escaper is not decoded twice.
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&rarr;': '\u2192', '&amp;': '&' }
const textOf = (h) => Object.entries(ENTITIES)
  .reduce((t, [e, c]) => t.split(e).join(c), h.replace(/<[^>]+>/g, ''))
t('samples.literalBraces', pres.some(p => textOf(p).includes('{#each leads.data as lead}'))
                        && pres.some(p => textOf(p).includes("@@allow('read'")))
t('samples.noRawTag',   pres.every(p => !p.includes('{@html')))

// Highlighted by glow, which marks a token with the ELEMENT that means it and
// carries the language on the wrapper — so `code[language] sup` in
// @frontierjs/css is the whole theme and the page ships no palette. A sample
// with no wrapper is styled by nothing and looks like plain text.
t('samples.wrapped',    pres.every(p => /<code language="[a-z]+">/.test(p)))
t('samples.languages',  [...new Set([...html.matchAll(/<code language="([a-z]+)">/g)]
  .map(m => m[1]))].sort())
t('samples.highlighted', /<code language="lite"><sup>\/\/ db\/schema\.lite/.test(html))

// The seed's own attributes and the shell's own command word — the two the
// generic pass could not reach, and the reason glow learned both languages.
t('samples.liteAttrs',  html.includes('<label>@@gate</label>') && html.includes('<label>@id</label>'))
t('samples.shellCmd',   /<code language="sh">[\s\S]*?<strong>npx<\/strong>/.test(html))

// FJS-500 — the sample's `&lt;script&gt;` must still be four characters. Under
// happy-dom 14 the prerender turned escaped markup back into live markup, so
// this page shipped a real <script> tag inside a code sample and threw two
// SyntaxErrors. The samples are the product; this is the page that proves the
// serializer fix reaches a real build.
t('samples.entitiesPreserved', {
  // No sample may hold a LIVE tag: glow escapes every `<` it emits, and the
  // prerenderer must not turn it back. The tag is tokenized now, so the check
  // is on the two halves rather than on the string `&lt;script&gt;`.
  live:    pres.every(p => !/<(?:script|style|iframe)[ >]/.test(p)),
  escaped: pres.some(p => p.includes('&lt;') && textOf(p).includes('<script>')),
})

// The site owns no code palette any more. A page that grew one back would
// still look right — it would just stop following the theme, and stop
// agreeing with @frontierjs/css about what a keyword is. Asked of the SOURCE,
// because the built stylesheet is one file and cannot say which page wrote a
// rule.
t('samples.noLocalPalette', (() => {
  const bad = []
  for (const f of readdirSync(SRC_ROUTES)) {
    if (!f.endsWith('.mesa')) continue
    const src = readFileSync(join(SRC_ROUTES, f), 'utf8')
    const style = (src.match(/<style>[\s\S]*?<\/style>/) ?? [''])[0]
    // A rule that paints a token element or a token class inside a code block.
    if (/(?:pre|\.code|code\[language\])[^{;]*\b(?:b|i|em|strong|sup|label|kw|cm|st|at)\b[^{]*\{/.test(style))
      bad.push(f)
  }
  return bad
})(), none)

// Every sample is the same TEXT it was when the page was hand-written. glow may
// only add tags: a highlighter's one catastrophic failure is silent — it eats a
// character, the block still looks like code, and the reader copies a sample
// that does not work.
//
// The baseline is a FIXTURE rather than the hand-written page, because those
// pages are gone. `test/fixtures/samples.json` was lifted from them at the
// commit that deleted them and is not regenerated: the point is that these
// strings never move again, so a generator would defeat it. A sample that is
// meant to change is edited in both places, deliberately.
t('samples.textUnchanged', (() => {
  const was = JSON.parse(readFileSync(join(HERE, 'fixtures', 'samples.json'), 'utf8'))
  const out = {}
  for (const [page, samples] of Object.entries(was)) {
    const now = (readFileSync(join(DIST, page, 'index.html'), 'utf8')
      .match(/<pre[^>]*>[\s\S]*?<\/pre>/g) ?? [])
      .map((p) => textOf(p).replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '')
        // An install range is read off a manifest (pin.js) and moves with every
        // minor, which is not the sample changing.
        .replace(/((?:@frontierjs\/[\w-]+|frontier)@)\d+(?:\.\d+)?\b/g, '$1<range>'))
      .filter((t) => t.trim())
    const same = samples.length === now.length && samples.every((t, i) => t === now[i])
    out[page] = same ? samples.length : false
    if (!same) out[`${page}:diff`] = `${samples.length} frozen / ${now.length} built, ` +
      `first at ${samples.findIndex((t, i) => t !== now[i])}`
  }
  return out
})())

// Every internal link resolves, and every one of them is ABSOLUTE.
//
// The second half is the one that matters, and it is why this is a rule about
// SPELLING rather than a link checker. `trailingSlash: 'always'` puts every
// page at `/name/index.html`, so a relative `href="index.html"` written on
// `/index2/` resolves to `/index2/index.html` — the page it is written on. The
// file exists, the server answers 200, and the link goes nowhere: five of them
// reading "Home →" pointed at themselves after the hand-written pages were
// deleted, through a build, a serve and a resolve check. Absolute is the one
// spelling that cannot do that, and the layout already uses it throughout.
t('links.internal', (() => {
  const bad = { unresolved: [], relative: [] }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'assets' ? [] : walk(join(dir, e.name)))
                    : (e.name.endsWith('.html') ? [join(dir, e.name)] : []))
  for (const file of walk(DIST)) {
    const here = '/' + relative(DIST, file).replace(/index\.html$/, '')
    for (const [, href] of readFileSync(file, 'utf8').matchAll(/href="([^"]+)"/g)) {
      if (/^(?:https?:|mailto:|#|\/assets\/)/.test(href)) continue
      const path = href.split('#')[0].split('?')[0]
      if (!path) continue
      if (!path.startsWith('/')) { bad.relative.push(`${here} → ${href}`); continue }
      const target = join(DIST, path.endsWith('/') ? path + 'index.html' : path)
      if (!existsSync(target) && !existsSync(join(DIST, path, 'index.html')))
        bad.unresolved.push(`${here} → ${href}`)
    }
  }
  return bad
})(), (v) => none(v.unresolved) && none(v.relative))

// One layout, one copy.
t('layout.wrapped',  html.includes('class="brand') && html.includes('site-footer'))
t('layout.navOnce',  (html.match(/Frontier<span/g) ?? []).length, (n) => n === 1)

// The design system, the baked theme, and the pre-paint script.
t('head.stylesheet',  /<link rel="stylesheet" href="\/assets\/[^"]+\.css">/.test(html))
t('head.title',       (html.match(/<title>([^<]*)<\/title>/) ?? [])[1])
t('head.description', /<meta name="description" content="A schema-seeded/.test(html))
t('head.themeScript', html.includes('id="sierra-theme"'))
t('head.bodyClass',   (html.match(/<body class="([^"]*)"/) ?? [])[1])

// FJS-501 in the dev shell: a theme class on its body re-declares every theme
// token under <html>, so the swatches do nothing in `bun run dev` while every
// built-page probe below passes.
t('devShell.noBodyTheme', readFileSync(join(KIT, 'index.html'), 'utf8')
  .match(/<body[^>]*>/)?.[0], (tag) => !/theme-/.test(tag ?? ''))

// One island, and only one — a page that accidentally shipped its whole self as
// a client bundle would still look right.
t('island.markers', (html.match(/mesa-island \{/g) ?? []).length, (n) => n === 1)
t('island.chunks',  readdirSync(join(DIST, 'assets')).filter(f => /^island-/.test(f)), (l) => l.length > 0)

// Every package the site tells a visitor to install is one npm has.
//
// This is the `registry` CI phase's question asked of the MARKETING copy, and
// it is a different question: that phase reads the list `fli new` writes into
// an app, and nothing has ever looked at what a page SAYS. Two were wrong —
// `npm i @frontierjs/basecamp`, for a package that is `private` and never
// publishes because it is an application rather than a library, and a
// marketplace install for an extension with no publisher account. Both are
// commands that have never worked and cannot, on the pages selling them.
//
// The registry is a second origin that moves on its own, so no network is a
// NAMED skip rather than a pass, and FJS_REQUIRE_REGISTRY=1 makes it fatal —
// the same contract the CI phase gives.
t('install.published', await (async () => {
  // One command may name several — `npm i @frontierjs/auth @frontierjs/caravan`
  // is one line and two packages, and taking the first would have skipped one.
  // Read off the TEXT, not the markup. Every install command on this site is
  // inside a highlighted sample now, so `@frontierjs/auth` reaches the page as
  // three token elements and a scan of the HTML finds only the plain ones —
  // which is the copy the pages are least likely to get wrong.
  //
  // A sample's tags are removed with NOTHING between, because they sit INSIDE
  // one token — `@frontierjs`, `/`, `auth` is three elements and one word.
  // Everywhere else a tag is a word boundary and becomes a space, or the nav
  // link after a `<pre>` joins onto the package name.
  const text = allHtml
    .replace(/<code language="[^"]*">([\s\S]*?)<\/code>/g,
      (_, inner) => '\n' + inner.replace(/<[^>]+>/g, '') + '\n')
    .replace(/<[^>]+>/g, ' ')
  // Scoped names and the front door only. A line ends at a `#` comment, which
  // several of these carry (`npm i @frontierjs/junction    # API`). The
  // question is whether the site names a package of OURS that does not
  // publish — a third-party typo is a different check and this cannot make it.
  const named = [...new Set([...text.matchAll(/npm i(?:nstall)? (?:-g )?([^\n#]+)|npx (\S+)|npm create (frontier@\S+)/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? `create-${m[3]}`).split(/\s+/))
    .filter((w) => /^(?:@frontierjs\/[\w-]+|create-frontier)(?:@[\d.]+)?$/.test(w)))].sort()
  const out = { named, missing: [] }
  for (const spec of named) {
    // A pinned `npx` or `npm create` reads its range off the local manifest
    // (pin.js), so a version bumped here and not yet published renders a range
    // npm has nothing in. The package exists and the command still fails.
    const [, pkg, range] = spec.match(/^(@?[^@]+)(?:@(.+))?$/)
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`)
      .catch(() => null)
    if (!res) {
      out.skipped = 'no network — set FJS_REQUIRE_REGISTRY=1 to make this fatal'
      if (process.env.FJS_REQUIRE_REGISTRY) out.missing.push('(registry unreachable)')
      return out
    }
    if (res.status === 404) { out.missing.push(spec); continue }
    if (range && !Object.keys((await res.json()).versions ?? {}).some((v) => v.startsWith(range + '.'))) {
      out.missing.push(spec)
    }
  }
  return out
})(), (v) => none(v.missing))

// ─── the splash and the journey ───────────────────────────────────────────
// The splash's one job is the hand-off, so the check is that both doors are
// in the file. Every post file with a date is listed on the journey's index
// and emitted at its own URL — the index is read off the post files, so a
// post that builds and is not listed means the reader broke, not the post.
t('splash.handsOff', {
  journey: splash.includes('href="/journey/"'),
  pitch:   splash.includes('href="/pitch/"'),
  soon:    splash.includes('Coming soon'),
})
// Every derived feature is in the file twice: once read, once the copy that
// makes the loop seamless, hidden from a screen reader.
const { derived } = await import('../site/content/data/derived.js')
t('splash.marquee', {
  everyFeature: derived.every((d) => splash.split(`>${d.title}</h3>`).length - 1 === 2),
  copyHidden:   /aria-hidden="true" class="track/.test(splash),
})
const { loadPosts } = await import('../site/content/data/journey.js')
const posts = await loadPosts()
const journeyHtml = readFileSync(join(DIST, 'journey', 'index.html'), 'utf8')
t('journey.everyPost', {
  declared: posts.length,
  listed:   posts.filter((p) => journeyHtml.includes(`href="/journey/${p.slug}/"`)).length,
  emitted:  posts.filter((p) => existsSync(join(DIST, 'journey', p.slug, 'index.html'))).length,
}, (v) => v.declared > 0 && balanced(v))

// ─── the package pages ────────────────────────────────────────────────────
// One page per entry in packages.js, and the count is asked of the DATA rather
// than written here: a build that emitted three would otherwise pass every
// content check below by never running it.
const { PKGS } = await (await import('../site/content/data/packages.js')).loadFJS()
const slugFor  = (p) => p.page.replace(/\.html$/, '')

t('pkg.onePerPackage', {
  emitted: PKGS.filter((p) => existsSync(join(DIST, slugFor(p), 'index.html'))).length,
  declared: PKGS.length,
}, balanced)

// The features are IN THE FILE. `litestone` carries twelve, each with its
// label, its prose and its "replaces" list.
const litestone = PKGS.find((p) => p.id === 'litestone')
t('pkg.everyFeature', {
  declared: litestone.rows.length,
  present:  litestone.rows.filter((r) => pkgHtml.includes(r.k) && pkgHtml.includes(r.why)).length,
}, balanced)
t('pkg.replacesInFile', pkgHtml.includes('Prisma Migrate') && pkgHtml.includes('CASL'))
t('pkg.codeHighlighted', /<code language="lite">[\s\S]*?<strong>model<\/strong>/.test(pkgHtml))
t('pkg.installLine',     pkgHtml.includes('npm i @frontierjs/litestone'))
t('pkg.noEmptyShell',    !pkgHtml.includes('id="page"'))

// Per-page title and description, from head(). Frontmatter is static text, so
// without it eight pages share one title — the single field a search result is
// built from.
const titleOf = (h) => (h.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? null
const mesaHtml = readFileSync(join(DIST, 'mesa', 'index.html'), 'utf8')
t('pkg.titlesDiffer',  titleOf(pkgHtml) !== titleOf(mesaHtml))
t('pkg.titleNamesPkg', titleOf(pkgHtml))
t('pkg.hasDescription', /<meta name="description" content="[^"]{10}/.test(pkgHtml))

// Every prerendered page is in the sitemap — `indexed` drops dynamic routes,
// which on this target is every package page (`FJS-502`).
const sitemap = readFileSync(join(DIST, 'sitemap.xml'), 'utf8')
t('pkg.inSitemap', PKGS.every((p) => sitemap.includes(`<loc>${settings.siteUrl}/${slugFor(p)}/</loc>`)))

// ─── every page ───────────────────────────────────────────────────────────
// The set is asked of the route tree rather than written here: a build that
// emitted half of them would otherwise pass every check below by never running
// it. Twelve hand-written pages were ported; this is what they became.
const PAGES = readdirSync(SRC_ROUTES)
  .filter((f) => f.endsWith('.mesa') && !f.startsWith('_') && !f.startsWith('['))
  .map((f) => f.replace(/\.mesa$/, ''))
  .filter((n) => n !== '404')

t('pages.allEmitted', {
  declared: PAGES.length + PKGS.length,                     // PAGES already holds index
  emitted:  [...PAGES.map((n) => (n === 'index' ? 'index.html' : join(n, 'index.html'))),
             ...PKGS.map((p) => join(slugFor(p), 'index.html'))]
              .filter((f) => existsSync(join(DIST, f))).length,
}, balanced)

// Every page is reachable from the site nav. A page left out of the menu still
// builds, serves and passes every check here, and nobody finds it to read it.
// A page declaring `robots: noindex` asked not to be found, and is exempt.
const navHtml  = (html.match(/<nav aria-label="Site"[\s\S]*?<\/nav>/) ?? [''])[0]
const unlisted = (n) => /^robots:\s*noindex\s*$/m.test(
  readFileSync(join(SRC_ROUTES, `${n}.mesa`), 'utf8').split(/^---$/m)[1] ?? '')
t('pages.inNav', PAGES.filter((n) => n !== 'index' && !unlisted(n) && !navHtml.includes(`href="/${n}/"`)), none)

// Every page carries the layout and the pre-paint theme script — the two things
// thirteen hand-written files each had their own copy of.
t('pages.layoutEverywhere', PAGES.every((n) => {
  const f = join(DIST, n === 'index' ? 'index.html' : join(n, 'index.html'))
  const h = readFileSync(f, 'utf8')
  return h.includes('class="brand') && h.includes('id="sierra-theme"')
}))

// The demos' content is IN THE FILE. Each of these was built from JavaScript on
// load, so a crawler saw an empty div — which is the whole reason for the port.
const bodyOf = (n) => {
  const h = readFileSync(join(DIST, n, 'index.html'), 'utf8')
  return h.slice(h.indexOf('<body'))
}
const countIn = (n, re) => (bodyOf(n).match(re) ?? []).length

t('demos.prerendered', {
  showroom:   countIn('showroom',  /class="ln[ "]/g),        // the seed, line by line
  showroom2:  countIn('showroom2', /class="panel[ "]/g),     // fifteen walkthrough steps
  showroom3:  countIn('showroom3', /class="hop\b/g),         // eighteen seams
  showroom4:  countIn('showroom4', /phasepanel/g),           // six phases
  showroom5:  countIn('showroom5', /role="tab"/g),           // every feature row
  seams:      countIn('seams',     /class="ex[ "]/g),        // seventeen explanations
  landscape:  countIn('landscape', /class="entry[ "]/g),     // twenty-one projects
  tutor:      countIn('tutor',     /class="card lesson[ "]/g), // the four lessons
}, counted)

// The map's lettering is pixels, so the words are the list under it: one entry
// per hotspot, and every hotspot a link to its own entry.
t('map.prerendered', {
  hotspots: countIn('map', /class="territory[ "]/g),
  entries:  countIn('map', /class="entry[ "]/g),
  linked:   (bodyOf('map').match(/href="#[a-z-]+" data-id=/g) ?? []).length,
  image:    existsSync(join(DIST, 'map', 'territory.webp')) ? 1 : 0,
}, (v) => v.hotspots > 0 && v.hotspots === v.entries && v.entries === v.linked && v.image === 1)

// The tutorial page's argument is that the tutorial runs, so its samples are
// transcripts of runs rather than prose about them. A paraphrase would be the
// one thing on this site that has never been executed — these two strings come
// out of a real lesson and a real refusal.
t('tutor.transcripts', {
  probe:   bodyOf('tutor').includes('the row is in db/app.db'),
  // Asked without the step number: glow marks `01-` as a token of its own, so
  // the literal line is not one contiguous string in the HTML.
  refusal: bodyOf('tutor').includes('preflight refused'),
})

// landscape used to fetch its data on load, so the page a crawler read said
// "Loading…". The file it reads now is checked into the repo beside the route.
t('demos.noRuntimeFetch',
  !bodyOf('landscape').includes('Loading') && !bodyOf('landscape').includes('projects.json'))

// ─── the server ───────────────────────────────────────────────────────────
const head = async (p) => {
  const r = await fetch(`${ORIGIN}${p}`)
  return { status: r.status, cache: r.headers.get('cache-control') }
}
t('serve.root',   (await head('/')).status, (s) => s === 200)
t('serve.missing', (await head('/no-such-page/')).status, (s) => s === 404)

// ─── CDP ──────────────────────────────────────────────────────────────────
const browser = await openChrome().catch((e) => { console.error(e.message); process.exit(1) })
const { cmd, evaluate } = browser

// The driver's own `errors` promote only a [Mesa] warning; this drive fails on
// every warning as well, so it reads the events itself.
const consoleErrors = []
browser.on('Runtime.exceptionThrown', (p) =>
  consoleErrors.push('exception: ' + (p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text)))
browser.on('Runtime.consoleAPICalled', (p) => {
  if (['error', 'warning'].includes(p.type))
    consoleErrors.push(p.type + ': ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '))
})

const HARNESS = `
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  window.sleep = ms => new Promise(r => setTimeout(r, ms));
  window.waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitFor timed out'); await sleep(40) }
  };
  return true;
`

const goto = async (url) => {
  await cmd('Page.navigate', { url })
  await new Promise(r => setTimeout(r, 400))
  await evaluate(HARNESS)
}

try {
  await goto(`${ORIGIN}/pitch/`)

  // The design system reached the page. A missing stylesheet is not an error in
  // a browser, just an unstyled page — so this is measured, not looked for.
  t('css.applied', await evaluate(`
    const bar = document.querySelector('.topbar');
    const cs  = getComputedStyle(bar);
    return { sticky: cs.position, hasBorder: cs.borderBottomWidth !== '0px' };
  `))

  // The scoped rules survived the compile — a hash that did not match is a page
  // with every class name and no rule behind it.
  t('css.scoped', await evaluate(`
    const pre = document.querySelector('pre');
    return { mono: getComputedStyle(pre).fontFamily.includes('ui-monospace'),
             padded: getComputedStyle(pre).paddingTop };
  `))

  // {@html} put real elements in, not escaped text — and the color on them is
  // @frontierjs/css's, which is the half a file-level check cannot see. The
  // page carries no code palette of its own now, so a keyword that is not
  // tinted means the design system's theme did not reach the sample at all.
  t('samples.rendered', await evaluate(`
    const code = document.querySelector('pre.code code[language]');
    const kw   = code.querySelector('strong');
    const cm   = code.querySelector('sup');
    const ink  = getComputedStyle(code).color;
    return { keywords: code.querySelectorAll('strong').length,
             keyword:  getComputedStyle(kw).color,
             comment:  getComputedStyle(cm).color,
             plainInk: ink,
             themed:   getComputedStyle(kw).color !== ink
                    && getComputedStyle(cm).color !== ink };
  `))

  // A token element must not keep its own meaning. code.css neutralizes all
  // nine, because glow uses them as color carriers — without it every string
  // is italic and every comment is superscript, which reads as a broken page.
  t('samples.neutralized', await evaluate(`
    const code = document.querySelector('pre.code code[language]');
    const em   = code.querySelector('em');
    const cs   = getComputedStyle(em);
    return { italic: cs.fontStyle, shifted: cs.verticalAlign };
  `))

  // The island hydrated. Six buttons that do nothing look exactly like six that
  // work, so this asks whether a listener is attached by using one.
  t('island.mounted', await evaluate(`
    await waitFor(() => document.querySelectorAll('.swatch').length === 6);
    return document.querySelectorAll('.swatch').length;
  `))

  // THE assertion. What must change is what a person sees, so this reads a
  // rendered color before and after — not a class name, which is the thing
  // that was wrong in both apps before FJS-308.
  t('theme.switches', await evaluate(`
    const read = () => ({
      html: document.documentElement.className,
      body: document.body.className,
      bg:   getComputedStyle(document.body).backgroundColor,
      ink:  getComputedStyle(document.body).color,
    });
    const before = read();
    document.querySelectorAll('.swatch')[4].click();   // theme-dark
    await sleep(120);
    const after = read();
    return { before, after, changed: before.bg !== after.bg };
  `))

  // The code retints with the theme. A page-local palette read --color-primary
  // and so did follow a retheme, but it made its own contrast decision; the
  // design system clamps every token into the tone-as-text window, which is
  // the reason a dark theme does not put dark code on a dark block. Both
  // colors must move, and both must still differ from the block's own ink.
  t('samples.followTheme', await evaluate(`
    const kw = () => {
      const c = document.querySelector('pre.code code[language]');
      return { keyword: getComputedStyle(c.querySelector('strong')).color,
               value:   getComputedStyle(c.querySelector('em')).color,
               ink:     getComputedStyle(c).color };
    };
    // The theme probe above left the page on theme-dark, so this puts it back
    // before reading — otherwise both readings are the same theme and the
    // check passes by measuring nothing.
    document.querySelectorAll('.swatch')[0].click();   // theme-default
    await sleep(120);
    const light = kw();
    document.querySelectorAll('.swatch')[4].click();   // theme-dark
    await sleep(120);
    const dark = kw();
    return { light, dark,
             moved:  light.keyword !== dark.keyword && light.value !== dark.value,
             legible: dark.keyword !== dark.ink && dark.value !== dark.ink };
  `))

  // FJS-501 — four of the six are refused by name, because the theme block in
  // content/settings/site.js never reaches a prerendered page: initTheme() is called by
  // virtual:sierra, which a static build does not load, so the island bundle
  // keeps the module's own DEFAULT_THEMES.
  // Read --color-primary rather than a background: only three of the six
  // redefine --surface, so a background probe reads four working themes as
  // dead. Every theme in the package changes the accent.
  t('theme.FJS501_everySwatch', await evaluate(`
    const tone = () => getComputedStyle(document.documentElement)
      .getPropertyValue('--color-primary').trim();
    const out = {};
    for (const b of document.querySelectorAll('.swatch')) {
      const before = tone(); b.click(); await sleep(100);
      const inPage = getComputedStyle(document.querySelector('.brand span')).color;
      out[b.title] = { onHtml: tone(), inBody: inPage };
    }
    return out;
  `))

  // The other half of FJS-501: the pre-paint script the build injected reads
  // `fjs-theme`, the client persists under `theme`. One config block, two keys,
  // so every reload reverts.
  t('theme.FJS501_keyMismatch', await evaluate(`
    return { declaredKey: localStorage.getItem('fjs-theme'),
             written:     Object.keys(localStorage) };
  `))
  await goto(`${ORIGIN}/pitch/`)
  t('theme.afterReload', await evaluate(`
    return { html: document.documentElement.className,
             body: document.body.className,
             bg:   getComputedStyle(document.body).backgroundColor };
  `))

  // ── a package page, in a browser ────────────────────────────────────────
  await goto(`${ORIGIN}/litestone/`)

  t('pkg.rendered', await evaluate(`
    return { features: document.querySelectorAll('.feat').length,
             tocLinks: document.querySelectorAll('.ptoc a').length,
             subnav:   document.querySelectorAll('.subnav a').length };
  `))

  // The scoped styles bound through the layout AND the page, and the {@html}
  // code samples are colored by :global() rules — two different boundaries on
  // one page.
  t('pkg.styled', await evaluate(`
    // Not the first: .feat:first-child deliberately has no top border, so
    // querySelector('.feat') asserts nothing about whether the rule bound.
    const feat = document.querySelectorAll('.feat')[1];
    const kw   = document.querySelector('pre.code code[language] strong');
    return { featBorder: getComputedStyle(feat).borderTopWidth,
             keyword:    kw ? getComputedStyle(kw).color : null };
  `))

  // The scroll-spy island mounted and marks a section. Twelve inert links look
  // exactly like twelve that work, so this scrolls and reads the result.
  t('pkg.tocSpy', await evaluate(`
    const feats = [...document.querySelectorAll('.feat')];
    feats[3].scrollIntoView();
    await sleep(400);
    const marked = [...document.querySelectorAll('.ptoc a[aria-current]')].map(a => a.hash);
    return { marked, count: marked.length };
  `))

  // The brand goes home, from a page two levels in.
  //
  // It is the only link every page carries and the only way back from a package
  // page on a phone, where the nav collapses. Driven by a real mouse event at
  // the element's own coordinates rather than by reading the href, because
  // there are three separate ways a correct href does nothing: the element sits
  // under something else, the router swallows the event, or a page's CSS leaves
  // it 0×0. `elementFromPoint` is what says a pointer reaches it.
  //
  // In two calls, not one: the click NAVIGATES, which tears down the execution
  // context and rejects any evaluate still awaiting in it.
  t('layout.brandGoesHome', await (async () => {
    const box = await evaluate(`
      const a = document.querySelector('a.brand');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, from: location.pathname, href: a.getAttribute('href'),
               sized: r.width > 0 && r.height > 0,
               onTop: a === hit || a.contains(hit),
               cursor: getComputedStyle(a).cursor };
    `)
    if (!box) return { found: false }

    for (const type of ['mousePressed', 'mouseReleased'])
      await cmd('Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 700))

    const { x, y, ...rest } = box
    return { ...rest, landed: await evaluate('return location.pathname'),
             title: await evaluate('return document.title') }
  })())

  // ── the demos, working ──────────────────────────────────────────────────
  // Prerendered content is half the claim; the other half is that the widget
  // still does what it did. Each of these was 8–20 kB of imperative DOM code.

  await goto(`${ORIGIN}/showroom/`)
  t('demo.showroom', await evaluate(`
    const chips = [...document.querySelectorAll('[data-chips] .btn')];
    const before = document.querySelector('.panel.is-shown')?.dataset.id;
    chips.at(-1).click(); await sleep(120);
    const after = document.querySelector('.panel.is-shown')?.dataset.id;
    // Picking a derived thing lights the lines of the seed it came from —
    // the connection the whole page is about.
    return { moved: before !== after, lit: document.querySelectorAll('.ln.on').length };
  `))

  await goto(`${ORIGIN}/showroom2/`)
  t('demo.walkthrough', await evaluate(`
    const next = document.querySelector('[data-next]');
    next.click(); next.click(); await sleep(120);
    return { counter: document.querySelector('[data-counter]').textContent,
             shown:   document.querySelectorAll('.panel.is-shown').length,
             railNow: document.querySelectorAll('.stepbtn.now').length };
  `))

  await goto(`${ORIGIN}/showroom4/`)
  t('demo.loop', await evaluate(`
    const tabs = [...document.querySelectorAll('.phase')];
    tabs[3].click(); await sleep(120);
    const on = document.querySelector('.phasepanel.is-shown');
    return { id: on?.dataset.id, terminalLines: on?.querySelectorAll('.term span').length ?? 0 };
  `))

  await goto(`${ORIGIN}/seams/`)
  t('demo.seams', await evaluate(`
    // The connectors are measured, so they exist only once the island has run.
    await waitFor(() => document.querySelectorAll('[data-wires] path').length > 0);
    document.querySelector('[data-next]').click(); await sleep(120);
    return { wires: document.querySelectorAll('[data-wires] path').length,
             lit:   document.querySelectorAll('[data-wires] path.lit').length,
             shown: document.querySelector('.ex.is-shown')?.dataset.i };
  `))

  // The splash tuner writes the tour onto the REAL splash in its frame, so a
  // control that stops reaching the backdrop still renders a panel that moves.
  // Read back from the layers, never from the panel. The cloud decks run their
  // own copy of the tour, and one left on another clock zooms toward a
  // different spot than the land under it, which no single frame shows.
  await goto(`${ORIGIN}/splash-tune/`)
  t('demo.tuner', await evaluate(`
    const frame = document.querySelector('[data-frame]');
    const bd = await waitFor(() => frame.contentDocument?.querySelector('.splash .backdrop')?.style.getPropertyValue('--stop0-zoom') && frame.contentDocument.querySelector('.splash .backdrop'));
    const ground = bd.querySelector('.ground'), lows = bd.querySelector('.lows');
    const scale = (el) => parseFloat(getComputedStyle(el).transform.slice(7));
    const zoom = document.querySelector('[data-stop="2"] [data-k="zoom"]');
    zoom.value = '2.5'; zoom.dispatchEvent(new Event('input', { bubbles: true }));
    const show = document.querySelector('[data-cloud="low"][data-k="opacity"]');
    show.value = '0.3'; show.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-stop="2"] [data-go]').click(); await sleep(80);
    const tours = [...bd.querySelectorAll('.layer')].flatMap(el => el.getAnimations());
    const depth = parseFloat(getComputedStyle(bd).getPropertyValue('--low-depth'));
    const zoomReached = getComputedStyle(ground).transform === 'matrix(2.5, 0, 0, 2.5, 0, 0)';
    const deckDeeper  = Math.abs(scale(lows) - (1 + 1.5 * depth)) < .001;
    const goSeeks = tours.length === 3 && tours.every(a => a.playState === 'paused' && Math.round(a.currentTime) === 60000);
    const cloudShown = getComputedStyle(lows).opacity === '0.3';
    const aim = document.querySelector('[data-aim]');
    document.querySelector('[data-stop="4"] [data-aim-at]').click();
    const aimClears = getComputedStyle(lows).visibility === 'hidden';
    const f = frame.getBoundingClientRect(), b = bd.getBoundingClientRect();
    aim.dispatchEvent(new MouseEvent('click', { bubbles: true,
      clientX: f.left + b.left + b.width * .25, clientY: f.top + b.top + b.height * .75 }));
    const out = document.querySelector('[data-out]').value;
    return { zoomReached, deckDeeper, goSeeks, cloudShown, aimClears,
             aimed:   ['x', 'y'].map(k => document.querySelector('[data-stop="4"] [data-k="' + k + '"]').value).join() === '25,75',
             printed: out.includes('--stop2-zoom: 2.5;') && out.includes('--low-opacity: 0.3;') };
  `))

  await goto(`${ORIGIN}/landscape/`)
  t('demo.landscape', await evaluate(`
    // The cloud is packed by measurement — nothing in the file, everything at mount.
    await waitFor(() => document.querySelectorAll('[data-cloud] a').length > 0);
    const words = document.querySelectorAll('[data-cloud] a').length;
    const sizes = [...document.querySelectorAll('[data-cloud] a')]
      .map(a => parseFloat(a.style.fontSize));
    // Filtering hides register entries rather than rebuilding them.
    const chip = document.querySelector('[data-filters] .chip[data-key="adopted"]');
    chip.click(); await sleep(250);
    const visible = [...document.querySelectorAll('.entry')].filter(e => !e.hidden).length;
    return { words, biggest: Math.max(...sizes) > Math.min(...sizes),
             filtered: visible, cloudAfter: document.querySelectorAll('[data-cloud] a').length };
  `))

  await goto(`${ORIGIN}/map/`)
  t('demo.map', await evaluate(`
    await waitFor(() => document.querySelector('[data-map][data-ready]'));
    const svg   = document.querySelector('[data-map] svg');
    const panel = document.querySelector('[data-panel]');
    const width = () => svg.viewBox.baseVal.width;
    const full  = width();
    const img   = await fetch(svg.querySelector('image').getAttribute('href'));

    // A hotspot click opens the panel on that entry and does not navigate.
    svg.querySelector('.territory[data-id="junction"]').dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
    const opened = !panel.hidden && panel.textContent.includes('Junction') &&
                   location.hash === '#junction';

    document.querySelector('[data-zoom="in"]').click();
    const zoomedIn = width() < full;

    // Ctrl + wheel zooms; a plain wheel is left to the page.
    const r = svg.getBoundingClientRect();
    const wheel = (ctrlKey) => svg.dispatchEvent(new WheelEvent('wheel',
      { deltaY: -100, ctrlKey, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true }));
    const w0 = width(); wheel(false); const plainIgnored = width() === w0;
    wheel(true); const ctrlZooms = width() < w0;

    document.querySelector('[data-zoom="reset"]').click();
    const reset = width() === full;

    document.querySelector('[data-close]').click();
    return { imageServed: img.ok, opened, zoomedIn, plainIgnored, ctrlZooms, reset,
             closed: panel.hidden && location.hash === '' };
  `))

  // Both bars are sticky, so a subnav pinned higher than the topbar is tall
  // slides under it and nothing errors; and a jump to a section has to clear
  // both. Measured at desktop and at a width where the topbar wraps.
  const stack = {}
  for (const width of [1280, 390]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await goto(`${ORIGIN}/tutor/`)
    stack[width] = await evaluate(`
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 2000); await sleep(50);
      const bottom = (sel) => document.querySelector(sel).getBoundingClientRect().bottom;
      const subnavTop = document.querySelector('.subnav').getBoundingClientRect().top;
      const underBars = [];
      for (const a of document.querySelectorAll('.subnav a[href^="#"]')) {
        document.getElementById(a.hash.slice(1)).scrollIntoView(); await sleep(30);
        const h = document.getElementById(a.hash.slice(1)).querySelector('h1, h2');
        if (h && h.getBoundingClientRect().top < bottom('.subnav')) underBars.push(a.hash);
      }
      return { subnavClearsTopbar: subnavTop >= Math.max(0, bottom('.topbar')) - 0.5,
               anchorsClear: underBars.length === 0, underBars: underBars.join(' ') };
    `)
  }
  await cmd('Emulation.clearDeviceMetricsOverride')
  t('layout.stickyStack', stack)

  t('console.clean', consoleErrors, none)
} finally {
  await browser.close()
  await server.close()
}

console.log(JSON.stringify(got, null, 2))

// The report above is for reading; the exit code is the verdict. A drive that
// prints `false` and exits 0 is a gate nothing can fail (FJS-1079).
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
