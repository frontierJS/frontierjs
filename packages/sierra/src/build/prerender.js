/**
 * build/prerender.js — emit HTML for every route a `target: 'static'` surface
 * prerenders: each one but `render: spa` (`scanner/render-mode.js`).
 *
 * A route that DECLARES `render: static` must be written: a refusal by the
 * static-safety check fails the build, and a page that throws while rendering
 * does too. A route that declares nothing is written when it can be, and
 * otherwise falls back to the browser with the reason in `fallback` and the
 * table (`FJS-D2195`) — so a gate tightened in the schema changes which pages
 * are files rather than breaking a build that touched no route.
 *
 * A route's pages are held until its verdict is in. A refused page that was
 * already on disk would be published by a build that then carried on.
 *
 * ── Composition ───────────────────────────────────────────────────────────
 * A route renders inside its layout chain. Mesa hands a component its content
 * as snippets only (`FJS-D668`): `<Layout><Page /></Layout>` and
 * `<Layout children={snippet} />` are the same call, and a layout's `<slot />`
 * and `{@render children?.()}` read the same `children` prop. So the wrapper
 * states the prop form and every layout picks it up:
 *
 *   {#snippet s0()}<Page {data} />{/snippet}
 *   <L0 children={s0} />
 *
 * The page is instantiated exactly once, and the wrapper stays linear in the
 * length of the chain.
 *
 * ── Data ──────────────────────────────────────────────────────────────────
 * `load()` runs at build time with a plain fetch. Relative URLs throw with a
 * pointed message rather than resolving against some implied dev server: a
 * production build must not depend on a running API. Absolute URLs work, and a
 * `load()` that needs no network at all — the common case — needs nothing.
 */

import { resolve, dirname, join, relative, sep } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { appSrcDir } from './app-alias-plugin.js'
import { explainModuleInitFailure } from './warnings.js'
import { importAppModule }           from './app-import.js'
import { ROUTE_EXTENSIONS, layoutRole } from '../scanner/classify.js'
import { prerenders, declaresStatic }   from '../scanner/render-mode.js'
import {
  installSchemas, createReadRecorder, checkRoute, formatReport,
} from './static-safety.js'
import { pageReadTap } from './page-reads.js'

// The router as a prerender loads it: the module, not the package entry (FJS-1530).
const ROUTER_MODULE = fileURLToPath(new URL('../router/index.js', import.meta.url))

/** Walk a route tree into a flat list. */
function flatten(node) {
  if (!node) return []
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

/**
 * Layout chain for a route file, outermost first.
 *
 * Derived from the file tree rather than from `node.layout`, which carries only
 * the NEAREST layout — a page under `/leads/` is wrapped by both
 * `routes/_module.mesa` and `routes/leads/_module.mesa`, and rendering only the
 * inner one would drop the outer chrome from every prerendered page.
 *
 * A layout is `_module` in any route extension, as the scanner classifies it:
 * looking for `_module.mesa` alone rendered a `_module.md` site's pages with no
 * shell at all, while dev wrapped them (FJS-1902). A pass-through `_module.md`
 * is skipped here as the scanner skips it, or the page renders empty.
 */
export function layoutChainFor(routeFile, routesDirAbs) {
  const chain = []
  let dir = dirname(resolve(routeFile))
  const stop = resolve(routesDirAbs)

  while (dir.startsWith(stop)) {
    const candidate = [...ROUTE_EXTENSIONS].map(ext => join(dir, '_module' + ext)).find(existsSync)
    if (candidate && layoutRole(candidate, readFileSync(candidate, 'utf8')) === 'layout') chain.unshift(candidate)
    if (dir === stop) break
    dir = dirname(dir)
  }
  return chain
}

/**
 * Why a static route is not written, or null when it is. One answer for the
 * prerender and for `bundleUnreachable`, which has to know whether the home
 * page will overwrite Vite's SPA shell before the bundle is rendered.
 */
export function omittedReason(node) {
  return node.meta?.status === 'draft' ? 'a draft (`status: draft`), not published'
    : node.meta?.redirect ? `redirects to ${node.meta.redirect}, which _redirects answers`
    : null
}

/**
 * Substitute `:param` segments in a route path.
 * '/blog/:slug/' + { slug: 'hello' } → '/blog/hello/'
 *
 * A param is ONE path segment, and that is checked here rather than assumed.
 * `getStaticPaths()` returns whatever a database column holds and the filled
 * path is joined onto `outDir`, where `join` resolves `..` normally — so a
 * slug of `../../../../etc/cron.d/evil` wrote an HTML file outside the output
 * directory, on the build machine. The quieter half is the same three
 * functions: `''` fills to `/products//`, which collapses to
 * `products/index.html` — the catalog's own page, replaced by one product,
 * with the build exiting 0 and printing a tick beside it.
 */
export function fillPath(routePath, params) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (whole, name) => {
    const v = params?.[name]
    if (v == null) throw new Error(`missing param '${name}' for route '${routePath}'`)
    const s = String(v)
    const refuse = why => {
      throw new Error(
        `param '${name}' for route '${routePath}' is ${JSON.stringify(s)} — ${why}. ` +
        `A getStaticPaths() param fills ONE path segment and names one output file.`
      )
    }
    if (s === '')                refuse('empty, which collapses onto the parent page and overwrites it')
    if (/[/\\]/.test(s))         refuse('a path, not a segment')
    if (s === '.' || s === '..') refuse('a directory reference')
    if (s.includes('\0'))        refuse('carrying a NUL byte')
    return s
  })
}

/**
 * A build-time fetch. Absolute URLs pass through; a relative one is a build
 * error, because there is no origin to resolve it against and silently picking
 * one would make the output depend on whatever happened to be listening.
 */
function makeBuildFetch(routeId) {
  return async function buildFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url
    if (typeof url === 'string' && !/^https?:\/\//i.test(url)) {
      throw new Error(
        `[Sierra] ${routeId}: load() called fetch('${url}') during a static build.\n` +
        `Relative URLs have no origin at build time. Use an absolute URL, or move ` +
        `the data into getStaticPaths().`
      )
    }
    return globalThis.fetch(input, init)
  }
}

/**
 * Import a route's companion, and say which of the two nothings it was.
 *
 * `null` means there is no companion — a page with no `.meta.js` reads nothing
 * at build time and has nothing to prove. A companion that THREW is the other
 * answer and it is fatal (`FJS-551`): it used to come back as the same `null`,
 * so a `.meta.js` that could not load was indistinguishable from a page that
 * has none, and the error it threw — usually the only true one in the whole
 * build — was discarded at the `catch`.
 */
async function importCompanion(absPath, routeId) {
  const res = await importAppModule(absPath)
  if (res.ok) return res.module
  if (res.reason === 'missing') return null

  throw new Error(
    `[Sierra] ${routeId}: its companion threw while it was loading.\n` +
    `  ${absPath}\n` +
    `  ${explainModuleInitFailure(res.error?.message ?? String(res.error), routeId)}`
  )
}

// ─── the prerender is bounded ─────────────────────────────────────────────────
//
// A prerender that hangs is the least describable failure this build has
// (`FJS-549`, `FJS-550`): the client bundle finishes, prints its chunk table,
// and then nothing — forever, with nothing written and nothing said, which
// reads as a compiler that stopped rather than a build that will never finish.
// Both known causes were found in one afternoon by one feature, and every
// diagnosis cost a full build cycle with no output to go on.
//
// So each unit of per-route work is raced against a clock. The bound does not
// diagnose anything and does not try to: it converts *silence* into a message
// naming the route, the phase and the two causes anybody has hit so far, which
// is the difference between a bug that can be reported and one that cannot.
//
// **A synchronous spin is not covered, and saying so is the point.** The timer
// needs the event loop, so a page that never yields hangs exactly as it did —
// the same limit caravan's job timeout states about a handler that never
// awaits. What that case still gets is the notice below, printed BEFORE the
// work starts once a route has been slow.
const PRERENDER_TIMEOUT_MS = 30_000

const HANG_CAUSES =
  `      Two things are known to do this, both of them about what the page's module graph reaches:\n` +
  `        · an island marker inside a LAYOUT (\`_module.mesa\`), or an island given element children\n` +
  `        · \`@frontierjs/sierra/resource\` anywhere in a prerendered island's imports\n` +
  `      A layout that holds no state and a client that is injected rather than imported are the\n` +
  `      shapes that work today.`

/**
 * Run one unit of per-route work under a clock.
 *
 * Racing does not cancel the work — nothing in JavaScript cancels a promise —
 * so the hung operation is still pending when this rejects. That is acceptable
 * here and nowhere else: the rejection fails the build, and the process exits.
 */
async function bounded(label, ms, work) {
  if (!(ms > 0)) return work()

  let timer = null
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `[Sierra] ${label} did not finish within ${Math.round(ms / 1000)}s and the build stopped waiting.\n` +
      HANG_CAUSES + `\n` +
      `      If this page is genuinely slow rather than stuck, raise prerender.timeout in sierra.config.js.`
    )), ms)
    timer.unref?.()
  })

  try { return await Promise.race([work(), clock]) }
  finally { clearTimeout(timer) }
}

/**
 * Enumerate the concrete URL paths a route contributes.
 * Static route → itself. Dynamic route → one per getStaticPaths() entry.
 */
export async function pathsForRoute(node, root) {
  if (!node.meta?.dynamic) return [{ path: node.path, params: {} }]

  const companion = node.companion ? resolve(root, node.companion) : null
  const mod = await importCompanion(companion, node.id)
  if (!mod || typeof mod.getStaticPaths !== 'function') {
    // scanner-plugin already fails the build for this case; treat it as
    // "nothing to emit" rather than throwing a second, worse error here.
    return []
  }

  const entries = (await mod.getStaticPaths()) ?? []
  return entries.map(params => ({ path: fillPath(node.path, params), params }))
}

/**
 * Build the synthetic wrapper module that composes layouts around the page.
 * Returned as source text; the caller renders it with Mesa.
 *
 */
export function composeWrapper(pageFile, layoutChain) {
  // The wrapper commits `page` before any layout renders, and does it through
  // its own import of the router — the one the layouts share. The prerender's
  // own import can be a different instance of the module (a test runner loads
  // prerender.js through its own graph and the rendered modules natively), and
  // a `page` written there is one no layout reads (FJS-1530).
  const imports = [
    `  import { _setStaticPage } from '@frontierjs/sierra/router'`,
    `  import Page from ${JSON.stringify(pageFile)}`,
  ]
  layoutChain.forEach((l, i) => imports.push(`  import L${i} from ${JSON.stringify(l)}`))

  // Work outward from the page. Each layout gets a snippet holding everything
  // it wraps, and is handed that snippet as the `children` prop, which is what
  // both `<slot />` and `{@render children?.()}` read.
  //
  // Declaration order is innermost-first, and load-bearing: s0's body contains
  // `<L1 children={s1}>`, so s1 must already exist when s0 is declared. The
  // other order compiles and then throws `s1 is not defined` at render.
  const snippets = []
  let body = `<Page {data} />`
  for (let i = layoutChain.length - 1; i >= 0; i--) {
    snippets.push(`{#snippet s${i}()}${body}{/snippet}`)
    body = `<L${i} children={s${i}} />`
  }

  const template = [...snippets, body].join('\n')
  return `<script>\n${imports.join('\n')}\n  export let data = null\n` +
    `  export let staticPage = null\n  if (staticPage) _setStaticPage(staticPage)\n</script>\n${template}\n`
}

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// `meta`, `links` and `bodyAttrs` carry values read from a row, so every
// value is escaped. A NAME is written bare, and one holding a space or `=`
// would add an attribute of the caller's choosing -- refused, not stripped.
const attrs = (obj) => Object.entries(obj ?? {})
  .filter(([, v]) => v !== undefined && v !== null && v !== false)
  .map(([k, v]) => {
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(k))
      throw new Error(`[Sierra] document: '${k}' is not an attribute name`)
    return v === true ? ` ${k}` : ` ${k}="${esc(v)}"`
  }).join('')

/**
 * The two shell facts every page carries whether or not the app stated them
 * (`FJS-D836`). `lang` is what a screen reader picks a voice by, and a page
 * without one is read in the user's locale whatever language it is written in.
 * The skip link is the first focusable thing in the body, so a keyboard user
 * jumps past the navigation instead of tabbing through it on every page; its
 * target is the `<main id="main" tabindex="-1">` the layout renders, which is
 * the one spelling `css/src/a11y/a11y.css` documents. An app that writes its
 * own `.skip-link` -- other words, another language -- keeps it, and the
 * default is written only where nothing is.
 */
export const DEFAULT_LANG = 'en'
export const SKIP_LINK = '<a class="skip-link" href="#main">Skip to content</a>'
export const hasSkipLink = (html) => /class="[^"]*\bskip-link\b[^"]*"/.test(html)

/**
 * The link off-screen before any stylesheet is. An SPA's CSS arrives with its
 * JS — in `vite dev`, only once the whole module graph has loaded — and until
 * then the link sits at the top of the page as bare text. The rule is in a
 * layer of its own, written first in `<head>`, so it is the lowest-ranked
 * statement on the page: `css/src/a11y/a11y.css` and any rule the app writes
 * outrank it as soon as they load. `a11y` is not reused as the name, because a
 * layer named first here would become the package's lowest. It never matches a
 * focused link, so a keyboard user who tabs to it before the CSS sees it.
 */
export const SKIP_LINK_GUARD =
  '<style id="sierra-skip-link">@layer sierra-shell{:where(.skip-link:not(:focus)){position:fixed;top:0;left:0;transform:translateY(-200%)}}</style>'

/**
 * The `document` keys as HTML. One serializer for the prerendered page and for
 * the `index.html` shell (`document-shell.js`), so the two cannot escape differently.
 */
export function documentParts({
  lang = '', htmlClass = '',
  meta = [], links = [], jsonLd = [], bodyClass = '', bodyAttrs = {}, head = '', bodyEnd = '',
} = {}) {
  const metaTags = (meta ?? []).map((m) => `\n  <meta${attrs(m)}>`).join('')
  const relTags = (links ?? []).map((l) => `\n  <link${attrs(l)}>`).join('')

  // JSON inside <script> ends at the first `</script`, and `<!--` changes how
  // the parser reads the rest, so `<` is written as its JSON escape: the text
  // parses back to the same value and can no longer close the element.
  const ldTags = [].concat(jsonLd ?? [])
    .map((d) => `\n  <script type="application/ld+json">${JSON.stringify(d).replace(/</g, '\\u003c')}</script>`)
    .join('')

  // The theme class belongs on <html> and not on <body>, because that is where
  // the switcher writes it — `theme/index.js` says why the element is not a
  // knob, and a prerendered page has to agree with the script that will move it
  // later. Baked on <body> instead, the two are different elements: the
  // switcher sets <html class="theme-elite">, the file still says
  // <body class="theme-default">, and every token both of them define resolves
  // to the baked one for the whole page. The switch changes nothing a person
  // can see and there is no error (`FJS-501`).
  return {
    htmlAttr: (lang ? ` lang="${esc(lang)}"` : '') + (htmlClass ? ` class="${esc(htmlClass)}"` : ''),
    tags: metaTags + relTags + ldTags,
    head: head ? `\n  ${head}` : '',
    bodyAttr: (bodyClass ? ` class="${esc(bodyClass)}"` : '') + attrs(bodyAttrs),
    bodyEnd: bodyEnd ? `\n${bodyEnd}` : '',
  }
}

/**
 * Wrap rendered body HTML in a document.
 *
 * Mesa's wrapPage() takes `css` as an href, which would mean coordinating an
 * emitted asset name with Vite's hashing for what is usually a few hundred
 * bytes of scoped CSS. Inlining it keeps each page self-contained and costs one
 * fewer request — these pages ship no JS, so the style block is the only thing
 * standing between HTML and first paint.
 */
export function wrapDocument(bodyHTML, {
  title, description, css, styles, lang = DEFAULT_LANG, stylesheets = [],
  bodyClass = '', htmlClass = '',
  meta = [], links = [], jsonLd = [], bodyAttrs = {}, head = '', bodyEnd = '',
} = {}) {
  const parts = documentParts({ lang, htmlClass, meta, links, jsonLd, bodyClass, bodyAttrs, head, bodyEnd })
  const skipLink = hasSkipLink(bodyHTML) ? '' : `${SKIP_LINK}\n`

  // One <style id="mHASH"> per component when the renderer supplies the split,
  // rather than one anonymous blob.
  //
  // The id is the component's CSS scope hash, which Mesa derives from the style
  // content — so it is the same id the component's own `addStyles(id, …)` call
  // uses when it mounts on the client. `addStyles` skips a style whose id is
  // already in the head, so an island's rules are shipped once, in the
  // prerendered page, instead of again by its chunk under a second hash.
  //
  // Falls back to the concatenated blob when `styles` is absent, so an older
  // renderer (or a caller passing only `css`) keeps working.
  const styleTag = styles?.length
    ? '\n' + styles
        .filter((s) => s?.css?.trim())
        .map((s) => `  <style id="${esc(s.id)}">${s.css.trim()}</style>`)
        .join('\n')
    : (css && css.trim() ? `\n  <style>${css.trim()}</style>` : '')

  // The app's stylesheets come FIRST, so a component's own scoped rules — which
  // are the more specific statement — are not overridden by the design system.
  // These are the assets the main build emitted; without them a prerendered page
  // carries every class name the app uses and not one rule behind them.
  const linkTags = stylesheets
    .filter(Boolean)
    .map((href) => `\n  <link rel="stylesheet" href="${esc(href)}">`)
    .join('')

  // Omitted rather than emitted empty. A `<meta name="description" content="">`
  // is a page telling a crawler it has no description, which is worse than
  // saying nothing and letting the crawler read the page.
  const descTag = description
    ? `\n  <meta name="description" content="${esc(description)}">`
    : ''

  return `<!DOCTYPE html>
<html${parts.htmlAttr}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title ?? '')}</title>${descTag}${parts.tags}${linkTags}${styleTag}${parts.head}
</head>
<body${parts.bodyAttr}>
${skipLink}${bodyHTML}${parts.bodyEnd}
</body>
</html>
`
}

/** '/blog/hello/' → 'blog/hello/index.html' */
export function outputFileFor(urlPath) {
  const clean = urlPath.replace(/^\/+/, '').replace(/\/+$/, '')
  return clean ? `${clean}/index.html` : 'index.html'
}

/**
 * The file an island's import names, as the bundle has to find it. Joined to the
 * call site as a path, `@frontierjs/site-kit/site/Toc.mesa` became
 * `content/routes/@frontierjs/...` and the island bundle failed to build, and
 * `@/x.mesa` the same way; a package island resolves the way Node finds it.
 * @param {string} file — the .mesa the island was written in
 * @param {string} specifier — its import specifier
 * @param {Record<string, string>} alias — the prerender's aliases
 */
export function islandModule(file, specifier, alias = {}) {
  if (/^\.{1,2}(\/|$)/.test(specifier) || specifier.startsWith('/')) return resolve(dirname(file), specifier)
  for (const [key, target] of Object.entries(alias)) {
    if (specifier === key) return target
    if (specifier.startsWith(key + '/')) return join(target, specifier.slice(key.length + 1))
  }
  return createRequire(file).resolve(specifier)
}

/**
 * Prerender every route the static target prerenders.
 *
 * @returns {Promise<{ written: string[], urls: string[], skipped: Array<{route:string, reason:string}>,
 *   fallback: Array<{route:string, reason:string}>,
 *   pageReads: { routes: Array<{ route: string, paths: import('./page-reads.js').PageRead[],
 *     pages: Array<{ url: string, reads: import('./page-reads.js').PageRead[] }> }> } | null }>}
 */
export async function prerenderRoutes(opts) {
  const {
    tree, root, routesDir = 'src/routes', outDir = 'dist/client', aliases = {},
    warn = () => {}, renderComponent, islands = false, tmpDir = null,
    // The build's own preparation of a Mesa source and its compile options,
    // handed to the renderer so it compiles what the bundle did (`FJS-1491`).
    transformSource = null, compileOptions = {},
    // The document around every page this run emits: the app's own stylesheets
    // (asset URLs from the main build) and the <body> class its index.html
    // carries. Both are per-BUILD, not per-route.
    stylesheets = [], bodyClass = '', htmlClass = '', lang = DEFAULT_LANG,
    // The app's own HTML for every page: `head` and `bodyEnd` verbatim, and
    // `bodyAttrs` (an object) beside the body class. `docMeta`, `docLinks`
    // and `docJsonLd` are head()'s keys for every page, escaped by the same
    // owner rather than hand-escaped into `docHead`.
    docHead = '', docBodyEnd = '', bodyAttrs = {},
    docMeta = [], docLinks = [], docJsonLd = [],
    // ── Static-safety inputs (FJS-081) ────────────────────────────────
    // `schemaDefs`/`schemaModels` come from schema-plugin, which has already
    // run in this build. `db` is a Litestone client the build can tap to see
    // what a route's load() actually reads. No schema means no gates, so the
    // whole check stands down — a Sierra app with no database is unaffected.
    schemaDefs = null, schemaModels = null, db = null,
    // What a single route may take before the build stops waiting. See
    // `bounded` — 0 turns the clock off, for a build that is genuinely slow.
    timeout = PRERENDER_TIMEOUT_MS,
  } = opts

  const routesDirAbs = resolve(root, routesDir)
  const outDirAbs    = resolve(root, outDir)
  // The same `@` Vite resolves in the client bundle. A prerender compiles a page
  // and imports it under Node, which resolves a bare specifier as a package — so
  // a page that builds and runs in the browser dies here with "Cannot find
  // package '@'" unless the renderer is told. One base (appSrcDir), two
  // resolvers; see build/app-alias-plugin.js.
  const alias = {
    ...aliases,
    '@': appSrcDir(root),
    // A layout that reads `page` imports `@frontierjs/sierra/router`, whose
    // package entry re-exports two .mesa components no native import can
    // load. Here it is the router module itself, which the wrapper imports
    // too, so the `page` it fills is the one every layout reads (FJS-1530).
    '@frontierjs/sierra/router': ROUTER_MODULE,
  }
  const written = []
  // The URLs those files answer at. A dynamic route's pages exist only because
  // getStaticPaths() named them, so the route TABLE cannot list them — it
  // carries `/products/:slug/` and nothing else. Anything downstream that has
  // to enumerate the site (a sitemap, prefetch rules) needs what was actually
  // emitted, and this is the only place that knows (`FJS-502`).
  const urls = []
  const skipped = []
  // Output file → the URL that wrote it. Two getStaticPaths() entries filling
  // to one file is silent otherwise: last write wins, exit 0, a tick printed.
  const writtenFrom = new Map()
  // …and collected rather than thrown at the first one, for the same reason the
  // static-safety gate below is: a catalog with four colliding rows should
  // print four lines, not make the author rebuild three more times.
  const collisions = []

  const safetyOn = !!schemaDefs
  if (safetyOn) installSchemas(schemaDefs, schemaModels)
  const violations = []
  const safetyRows = []
  // Each written URL's reads, so a write can name the pages it reaches
  // (`FJS-D1262`, `page-reads.js`). Null when there is no client to tap.
  const watchReads = pageReadTap(db)
  const pageReads  = watchReads ? { routes: [] } : null
  // Union of every island across every page, keyed by component name. A name is
  // what a marker carries and what the loader's registry is keyed by, so a name
  // used for two different modules is a real collision — reported, not merged.
  const islandsByName = new Map()
  const islandPages   = new Map()   // output file → component names on it

  // Not every static route is a page to publish. A draft is what the route
  // table leaves out of `published`, and a route declaring `redirect:` is
  // answered by its `_redirects` line: a file at its URL publishes the old
  // content beside the move, and on a host where a file shadows an unforced
  // redirect it is the only thing ever served (FJS-1533, FJS-1534). Neither
  // is written, and both are named in `omitted` rather than silently absent.
  const omitted = []
  const staticNodes = flatten(tree).filter(n => prerenders(n, 'static') && n.file).filter((n) => {
    const reason = omittedReason(n)
    if (reason) omitted.push({ route: n.path ?? n.id, reason })
    return !reason
  })
  // Undeclared routes the build could not prerender, and why (`FJS-D2195`).
  const fallback = []

  // The browser gets the app's methods on the built-in types from `main.js`,
  // which no prerender imports, so without this a page calling `.toMoney()`
  // works in the browser and throws here (`FJS-3493`, `FJS-D1515`). A sugar file
  // that throws is fatal, as a companion is.
  if (staticNodes.length) {
    const sugarFile = join(appSrcDir(root), 'lib/sugar.js')
    const res = await importAppModule(sugarFile)
    if (!res.ok && res.reason === 'threw') {
      throw new Error(
        `[Sierra] src/lib/sugar.js threw while it was loading, before any page could prerender.\n` +
        `  ${sugarFile}\n` +
        `  ${explainModuleInitFailure(res.error?.message ?? String(res.error), 'src/lib/sugar.js')}`
      )
    }
  }

  /**
   * Render one route's pages without writing any. A route-level failure is
   * `failure`; for a declared route each failed URL is in `skipped` instead and
   * the rest of its pages still render, as the build reports them all.
   */
  async function renderRoute(node, pageFile, declared, tap) {
    const out = { pages: [], skipped: [], failure: null, readsData: false, pathReads: [] }
    const fail = (route, reason) => {
      if (declared) out.skipped.push({ route, reason })
      else out.failure = reason
    }
    // One tap open at a time; the caller closes the last in a finally.
    const watch   = () => { tap.stop?.(); tap.stop = watchReads ? watchReads() : null }
    const collect = () => { const reads = tap.stop?.() ?? []; tap.stop = null; return reads }

    let targets
    watch()
    try {
      targets = await bounded(`${node.id}: getStaticPaths()`, timeout, () => pathsForRoute(node, root))
    } catch (err) {
      fail(node.id, `getStaticPaths() threw: ${explainModuleInitFailure(err.message, node.file)}`)
      return out
    }
    out.pathReads = collect()
    if (targets.length === 0) {
      fail(node.id, !declared && node.meta?.dynamic
        ? 'a dynamic route with no getStaticPaths() naming its pages'
        : 'no paths to emit')
      return out
    }

    const chain    = layoutChainFor(pageFile, routesDirAbs)
    const wrapper  = composeWrapper(pageFile, chain)
    const companion = node.companion ? resolve(root, node.companion) : null
    const mod      = await importCompanion(companion, node.id)

    // Does this route pull data at all? A page with no companion has no way to
    // read a model at build time, so it has nothing to prove and is never asked
    // for a declaration. A companion that exists and could not be read counts
    // as reading data, so a fail-open there is not waved through as "reads nothing".
    const companionExists = !!companion && existsSync(companion)
    out.readsData = mod
      ? (typeof mod.load === 'function' || typeof mod.getStaticPaths === 'function')
      : companionExists

    for (const { path: urlPath, params } of targets) {
      watch()
      let data = null
      if (mod && typeof mod.load === 'function') {
        try {
          data = await bounded(`${urlPath}: load()`, timeout,
            () => mod.load({ params, fetch: makeBuildFetch(node.id), url: urlPath }))
        } catch (err) {
          fail(urlPath, `load() threw: ${explainModuleInitFailure(err.message, node.file)}`)
          if (out.failure) return out
          continue
        }
      }

      let rendered
      try {
        // options.data IS the props object, so a component prop named `data`
        // nests one level down.
        // renderComponent takes SOURCE — the wrapper is synthetic and never
        // hits disk. `filename` only steers import resolution and error
        // messages, so it points at the page's own directory.
        rendered = await bounded(`${urlPath}: render`, timeout, () => renderComponent(wrapper, {
          // `staticPage` is what a navigation to this URL would commit, which
          // the wrapper writes to `page` before a layout reads it (FJS-1530).
          data:     { data, staticPage: { node, pathname: urlPath, params, data } },
          cwd:      dirname(pageFile),
          filename: join(dirname(pageFile), '__prerender__.mesa'),
          islands,
          // The document is assembled here from `rendered.styles`, one
          // <style id> per component, so Mesa must not also prepend the whole
          // lot as one anonymous blob — that is the same CSS twice on the page.
          styleTag: false,
          alias,
          ...(transformSource ? { transformSource } : {}),
          compileOptions,
          // Temp modules land in the app's tree, not Mesa's package root, so a
          // rendered layout's bare imports resolve from the app's node_modules.
          // Without this, `import { page } from '@frontierjs/sierra/router'` in
          // a layout dies with "Cannot find package" (mesa's docs/STATIC_RENDERING.md § tmpDir).
          ...(tmpDir ? { tmpDir } : {}),
        }))
      } catch (err) {
        fail(urlPath, `render failed: ${explainModuleInitFailure(err.message, node.file)}`)
        if (out.failure) return out
        continue
      }

      // A DYNAMIC route's pages share one frontmatter, and frontmatter is
      // static text — so thirteen product pages would carry one <title>, which
      // is the single field a search result is built from. `head({ params,
      // data })` is the way out: the companion answers per PATH, with the data
      // its own load() just returned.
      //
      // Frontmatter is the fallback and not the loser: a route whose pages
      // genuinely share a title says it once, and only a route that needs to
      // vary writes the function.
      let head = null
      if (mod && typeof mod.head === 'function') {
        try {
          head = await mod.head({ params, data, url: urlPath })
        } catch (err) {
          // Same grade as a load() that threw: this page is not emitted. A
          // page silently missing its title is the failure the function exists
          // to fix, so producing one anyway would defeat it.
          fail(urlPath, `head() threw: ${err.message}`)
          if (out.failure) return out
          continue
        }
      }

      const doc = wrapDocument(rendered.html, {
        title:  head?.title ?? node.meta?.title ?? node.meta?.frontmatter?.title,
        description: head?.description ?? node.meta?.description ?? node.meta?.frontmatter?.description,
        css:    rendered.css,
        styles: rendered.styles,
        stylesheets,
        bodyClass,
        htmlClass,
        bodyAttrs,
        head:    docHead,
        bodyEnd: docBodyEnd,
        meta:    [].concat(docMeta ?? [], head?.meta ?? []),
        links:   [].concat(docLinks ?? [], head?.links ?? []),
        jsonLd:  [].concat(docJsonLd ?? [], head?.jsonLd ?? []),
        lang:   node.meta?.lang ?? lang,
      })

      const file = join(outDirAbs, outputFileFor(urlPath))
      // Belt to `fillPath`'s braces: what a URL SAYS is checked there, and
      // this is what the join actually RESOLVED to. A path that leaves the
      // output directory is a file written on the build machine, so it stops
      // the build rather than being skipped.
      if (file !== outDirAbs && !file.startsWith(outDirAbs + sep))
        throw new Error(
          `[Sierra] ${node.id}: '${urlPath}' resolves to '${file}', outside the build output ` +
          `'${outDirAbs}'. A prerendered page is written by its URL, so a URL that walks out ` +
          `of the tree writes a file anywhere the build can reach.`
        )

      out.pages.push({ urlPath, file, doc, islands: rendered.islands ?? [], reads: collect() })
    }
    return out
  }

  /** Write one held page, refusing a second page for the same file. */
  async function writePage({ urlPath, file, doc, islands: pageIslands }, node) {
    const rel = relative(outDirAbs, file)
    // Two getStaticPaths() entries that fill to one file. Refused rather than
    // warned, alongside the empty-param case in fillPath: one file is one
    // page, so the second entry does not produce a bad page, it produces no
    // page — and a build that exits 0 ships a catalog one product short
    // with the evidence in a log CI does not read (`FJS-803`).
    //
    // The escape is in the app and there is no option for it: a route's URL is
    // its identity, so two entries claiming one URL is a question the build
    // cannot answer — `getStaticPaths()` picks which row wins, or gives the two
    // rows different paths.
    const prevUrl = writtenFrom.get(rel)
    if (prevUrl !== undefined) {
      collisions.push(prevUrl === urlPath
        ? `   ${node.id}: getStaticPaths() named '${urlPath}' twice, and both entries fill ` +
          `${rel}. Deduplicate the rows it returns.`
        : `   ${node.id}: '${urlPath}' and '${prevUrl}' both fill ${rel}. Two entries name one ` +
          `output file, so only one of those pages can exist.`)
      return
    }
    writtenFrom.set(rel, urlPath)

    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, doc, 'utf8')
    written.push(rel)
    urls.push(urlPath)

    // Record which islands this page carries. Mesa tags each entry with the
    // file the call site was written in and the import specifier it came
    // from, which together resolve a marker's component NAME to a module —
    // the one thing a bundle needs and a marker cannot carry.
    for (const entry of pageIslands) {
      if (!entry.specifier) {
        warn(`${urlPath}: <${entry.component} client:${entry.directive}> has no import specifier ` +
             `— it cannot be bundled and will stay inert. Import it from a .mesa file.`)
        continue
      }
      const module = islandModule(entry.file, entry.specifier, alias)
      const prev = islandsByName.get(entry.component)
      if (prev && prev.module !== module) {
        warn(`two different modules are both used as <${entry.component}>: ` +
             `${relative(root, prev.module)} and ${relative(root, module)}. ` +
             `Island markers carry a name, so only the first can be mounted — rename one.`)
      } else if (!prev) {
        islandsByName.set(entry.component, { component: entry.component, module })
      }
      if (!islandPages.has(rel)) islandPages.set(rel, new Set())
      islandPages.get(rel).add(entry.component)
    }
  }

  for (const node of staticNodes) {
    const pageFile = resolve(root, node.file)
    if (!existsSync(pageFile)) {
      skipped.push({ route: node.id, reason: 'route file not found' })
      continue
    }
    const declared = declaresStatic(node)

    // One recorder per ROUTE, opened before getStaticPaths() and closed after
    // the last page it contributes. The read set is a property of the route,
    // not of one emitted URL: a `[slug]` route that reads a gated model does so
    // for every slug, and reporting it once is what makes the message useful.
    // Stopped in a finally, or a throw leaks the tap onto the next route.
    const recorder = safetyOn ? createReadRecorder(db) : null
    const tap = { stop: null }
    let route
    try {
      route = await renderRoute(node, pageFile, declared, tap)
    } finally {
      recorder?.stop()
      tap.stop?.()
    }
    skipped.push(...route.skipped)

    let verdict = null
    if (recorder) {
      const routeId = node.file ? relative(root, resolve(root, node.file)) : node.id
      verdict = checkRoute({
        routeId,
        meta:       node.meta,
        models:     recorder.models,
        unresolved: recorder.unresolved,
        columns:    recorder.columns,
        exposed:    recorder.exposed,
        columnsOf:  recorder.columnsOf,
        taps:       recorder.taps,
        readsData:  route.readsData,
      })
      if (!verdict.ok && declared) violations.push(verdict.message)
      // Not a violation — a `load()` that only fetches an absolute URL is
      // legitimate and reads nothing here. But so is one that built its own
      // Litestone client, whose reads the build's tap never saw, and the two
      // are the same silence (`FJS-782`).
      if (verdict.observedNothing)
        warn(`${routeId}: reads data in its .meta.js and the build observed no model read. ` +
             `If its load() queries a database, it is doing so through a client this build ` +
             `was not given, and what it publishes has not been checked.`)
    }

    const refused  = !!verdict && !verdict.ok
    const fellBack = declared ? null : (route.failure ?? (refused ? verdict.reason : null))
    if (fellBack) fallback.push({ route: node.path ?? node.id, reason: fellBack })
    if (!fellBack && !refused) {
      for (const page of route.pages) await writePage(page, node)
      if (pageReads && route.pages.length) pageReads.routes.push({
        route: node.path ?? node.id,
        paths: route.pathReads,
        pages: route.pages.map(p => ({ url: p.urlPath, reads: p.reads })),
      })
    }

    if (verdict) safetyRows.push({
      route:     node.path ?? node.id,
      published: verdict.published,
      group:     fellBack ? 'browser' : 'static',
      ...(fellBack ? { reason: fellBack } : {}),
    })
  }

  // ── The static-safety gate (FJS-081) ──────────────────────────────────
  // Thrown, not warned. A warning scrolls past in CI and the file is written
  // anyway — and once a public artifact exists it has been served, cached and
  // indexed, so there is no recovering from "we saw the warning later".
  // Refused for the reason below, and refused SEPARATELY from the safety gate:
  // a collision is a build that produced fewer pages than it was asked for, not
  // a page that must not be published, and reporting the two together would
  // make one message answer two questions.
  if (collisions.length) {
    throw new Error(
      `[Sierra] ${collisions.length} getStaticPaths() ` +
      `${collisions.length > 1 ? 'entries' : 'entry'} write an output file another entry ` +
      `already wrote:\n\n` +
      collisions.join('\n') +
      `\n   Why this is refused rather than warned: the page that lost is simply absent\n` +
      `   from the site, the build otherwise exits 0, and the only evidence is a line in\n` +
      `   a log. One output file is one page.\n`
    )
  }

  if (violations.length) {
    throw new Error(
      `[Sierra] ${violations.length} route${violations.length > 1 ? 's' : ''} ` +
      `cannot be published as static HTML:\n\n` +
      violations.join('\n') +
      `\n   Why this is refused rather than warned: a prerendered file is public the\n` +
      `   moment it ships, and cannot be recalled from a CDN or a search index.\n`
    )
  }

  for (const s of skipped) warn(`${s.route}: ${s.reason}`)
  return {
    written,
    urls,
    skipped,
    omitted,
    fallback,
    islands: [...islandsByName.values()],
    islandPages,
    pageReads,
    // What the check PROVED, not only what it rejected. A check nobody has seen
    // run is a rule nobody trusts, and this table is also the per-route
    // classification `IDEAS/static-safety.md` wants to build on.
    safety: safetyOn ? { rows: safetyRows, report: formatReport(safetyRows) } : null,
  }
}
