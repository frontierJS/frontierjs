/**
 * build/prerender.js — emit HTML for routes that declare `render: static`.
 *
 * The declaration layer for static rendering already existed and was enforced:
 * a route sets `render: static` in frontmatter, a dynamic one exports
 * `getStaticPaths()` from its `.meta.js` companion, and scanner-plugin fails the
 * build if that export is missing. Nothing ever consumed any of it — the
 * `static` target returned the SPA Vite config with a comment saying SSG "is
 * handled separately", so `target: 'static'` silently produced a single
 * index.html and no pre-rendered route at all. No error, no warning.
 *
 * This is that missing step.
 *
 * ── Composition ───────────────────────────────────────────────────────────
 * A route renders inside its layout chain, and Mesa has two unrelated protocols
 * for handing a component its children:
 *
 *   <Layout><Page /></Layout>      → the THIRD argument (the `block` in
 *                                    `(anchor, props, block)`), which is what
 *                                    Mesa's native `<slot />` reads
 *   <Layout children={snippet} />  → a PROP, which is what
 *                                    `{@render children?.()}` reads
 *
 * Nothing bridges them: a `<slot />` layout handed the prop form renders an
 * empty slot, and vice versa. Both renderers agree on that — it is a protocol
 * mismatch, not an SSR limitation.
 *
 * Which one a layout speaks depends on how it was written, and the prerenderer
 * cannot know. Authored source uses `<slot />`; slot-rewrite.js converts that to
 * `{@render children?.()}` on the Vite path, but no rewrite runs here, so raw
 * `<slot />` reaches Mesa — where it works natively. Layouts written directly
 * against the prop form (Sierra's own fixtures, for one) are equally valid.
 *
 * So the wrapper supplies both, and each layout picks up whichever it reads:
 *
 *   {#snippet s0()}<Page {data} />{/snippet}
 *   <L0 children={s0}>{@render s0()}</L0>
 *
 * The element children render the same snippet rather than repeating its body,
 * so the page is instantiated exactly once whichever protocol the layout uses,
 * and the wrapper stays linear in the length of the chain. A layout that reads
 * *both* would render its children twice, but that layout is broken on the
 * client too.
 *
 * This composed with the prop form only until 2026-08-02, which silently
 * dropped the page from every `<slot />` layout — the layout rendered, the page
 * inside it did not, with no error.
 *
 * ── Data ──────────────────────────────────────────────────────────────────
 * `load()` runs at build time with a plain fetch. Relative URLs throw with a
 * pointed message rather than resolving against some implied dev server: a
 * production build must not depend on a running API. Absolute URLs work, and a
 * `load()` that needs no network at all — the common case — needs nothing.
 */

import { resolve, dirname, join, relative } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import {
  installSchemas, createReadRecorder, checkRoute,
  declaredPublishLevel, formatReport,
} from './static-safety.js'

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
 */
export function layoutChainFor(routeFile, routesDirAbs) {
  const chain = []
  let dir = dirname(resolve(routeFile))
  const stop = resolve(routesDirAbs)

  while (dir.startsWith(stop)) {
    const candidate = join(dir, '_module.mesa')
    if (existsSync(candidate)) chain.unshift(candidate)
    if (dir === stop) break
    dir = dirname(dir)
  }
  return chain
}

/**
 * Substitute `:param` segments in a route path.
 * '/blog/:slug/' + { slug: 'hello' } → '/blog/hello/'
 */
export function fillPath(routePath, params) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (whole, name) => {
    const v = params?.[name]
    if (v == null) throw new Error(`missing param '${name}' for route '${routePath}'`)
    return String(v)
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

/** Import a companion module fresh (cache-busted so a watch rebuild re-reads it). */
async function importCompanion(absPath) {
  if (!absPath || !existsSync(absPath)) return null
  const url = pathToFileURL(absPath).href + `?t=${Date.now()}`
  try { return await import(url) } catch { return null }
}

/**
 * Enumerate the concrete URL paths a route contributes.
 * Static route → itself. Dynamic route → one per getStaticPaths() entry.
 */
export async function pathsForRoute(node, root) {
  if (!node.meta?.dynamic) return [{ path: node.path, params: {} }]

  const companion = node.companion ? resolve(root, node.companion) : null
  const mod = await importCompanion(companion)
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
 */
export function composeWrapper(pageFile, layoutChain) {
  const imports = [`  import Page from ${JSON.stringify(pageFile)}`]
  layoutChain.forEach((l, i) => imports.push(`  import L${i} from ${JSON.stringify(l)}`))

  // Work outward from the page. Each layout gets a snippet holding everything
  // it wraps, and is handed that snippet both ways — as the `children` prop and
  // as element children that render it.
  //
  // Declaration order is innermost-first, and load-bearing: s0's body contains
  // `<L1 children={s1}>`, so s1 must already exist when s0 is declared. The
  // other order compiles and then throws `s1 is not defined` at render.
  const snippets = []
  let body = `<Page {data} />`
  for (let i = layoutChain.length - 1; i >= 0; i--) {
    snippets.push(`{#snippet s${i}()}${body}{/snippet}`)
    body = `<L${i} children={s${i}}>{@render s${i}()}</L${i}>`
  }

  const template = [...snippets, body].join('\n')
  return `<script>\n${imports.join('\n')}\n  export let data = null\n</script>\n${template}\n`
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
  title, description, css, styles, lang = 'en', stylesheets = [],
  bodyClass = '', htmlClass = '',
} = {}) {
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

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

  const bodyAttr = bodyClass ? ` class="${esc(bodyClass)}"` : ''

  // The theme class belongs on <html> and not on <body>, because that is where
  // the switcher writes it — `theme/index.js` says why the element is not a
  // knob, and a prerendered page has to agree with the script that will move it
  // later. Baked on <body> instead, the two are different elements: the
  // switcher sets <html class="theme-elite">, the file still says
  // <body class="theme-default">, and every token both of them define resolves
  // to the baked one for the whole page. The switch changes nothing a person
  // can see and there is no error (`FJS-501`).
  const htmlAttr = htmlClass ? ` class="${esc(htmlClass)}"` : ''

  // Omitted rather than emitted empty. A `<meta name="description" content="">`
  // is a page telling a crawler it has no description, which is worse than
  // saying nothing and letting the crawler read the page.
  const descTag = description
    ? `\n  <meta name="description" content="${esc(description)}">`
    : ''

  return `<!DOCTYPE html>
<html lang="${esc(lang)}"${htmlAttr}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title ?? '')}</title>${descTag}${linkTags}${styleTag}
</head>
<body${bodyAttr}>
${bodyHTML}
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
 * Prerender every `render: static` route in the tree.
 *
 * @returns {Promise<{ written: string[], urls: string[], skipped: Array<{route:string, reason:string}> }>}
 */
export async function prerenderRoutes(opts) {
  const {
    tree, root, routesDir = 'src/routes', outDir = 'dist/client',
    warn = () => {}, renderComponent, islands = false, tmpDir = null,
    // The document around every page this run emits: the app's own stylesheets
    // (asset URLs from the main build) and the <body> class its index.html
    // carries. Both are per-BUILD, not per-route.
    stylesheets = [], bodyClass = '', htmlClass = '', lang = 'en',
    // ── Static-safety inputs (FJS-081) ────────────────────────────────
    // `schemaDefs`/`schemaModels` come from schema-plugin, which has already
    // run in this build. `db` is a Litestone client the build can tap to see
    // what a route's load() actually reads. No schema means no gates, so the
    // whole check stands down — a Sierra app with no database is unaffected.
    schemaDefs = null, schemaModels = null, db = null,
  } = opts

  const routesDirAbs = resolve(root, routesDir)
  const outDirAbs    = resolve(root, outDir)
  const written = []
  // The URLs those files answer at. A dynamic route's pages exist only because
  // getStaticPaths() named them, so the route TABLE cannot list them — it
  // carries `/products/:slug/` and nothing else. Anything downstream that has
  // to enumerate the site (a sitemap, prefetch rules) needs what was actually
  // emitted, and this is the only place that knows (`FJS-502`).
  const urls = []
  const skipped = []

  const safetyOn = !!schemaDefs
  if (safetyOn) installSchemas(schemaDefs, schemaModels)
  const violations = []
  const safetyRows = []
  // Union of every island across every page, keyed by component name. A name is
  // what a marker carries and what the loader's registry is keyed by, so a name
  // used for two different modules is a real collision — reported, not merged.
  const islandsByName = new Map()
  const islandPages   = new Map()   // output file → component names on it

  const staticNodes = flatten(tree).filter(n => n.meta?.render === 'static' && n.file)

  for (const node of staticNodes) {
    const pageFile = resolve(root, node.file)
    if (!existsSync(pageFile)) {
      skipped.push({ route: node.id, reason: 'route file not found' })
      continue
    }

    // One recorder per ROUTE, opened before getStaticPaths() and closed after
    // the last page it contributes. The read set is a property of the route,
    // not of one emitted URL: a `[slug]` route that reads a gated model does so
    // for every slug, and reporting it once is what makes the message useful.
    //
    // try/finally rather than a stop() before each `continue` — there are five
    // exits from this body and a missed one leaks a tap onto the next route,
    // which would attribute one route's reads to another and fail the wrong
    // build.
    const recorder = safetyOn ? createReadRecorder(db) : null
    // Hoisted so the finally can read it — a `continue` from any of the exits
    // below still has to produce a verdict for this route.
    let _readsData = false
    try {

    let targets
    try {
      targets = await pathsForRoute(node, root)
    } catch (err) {
      skipped.push({ route: node.id, reason: `getStaticPaths() threw: ${err.message}` })
      continue
    }
    if (targets.length === 0) {
      skipped.push({ route: node.id, reason: 'no paths to emit' })
      continue
    }

    const chain    = layoutChainFor(pageFile, routesDirAbs)
    const wrapper  = composeWrapper(pageFile, chain)
    const companion = node.companion ? resolve(root, node.companion) : null
    const mod      = await importCompanion(companion)

    // Does this route pull data at all? A page with no companion has no way to
    // read a model at build time, so it has nothing to prove and is never asked
    // for a declaration. That keeps the check off the pages it cannot help.
    //
    // The `?? companionExists` half is load-bearing and was a fail-OPEN hole in
    // the first version of this check. `importCompanion` swallows an import
    // error and returns null, so a `.meta.js` that throws on import — one that
    // imports the app's db client under a runtime that cannot load it, say —
    // looked identical to a route with no companion at all, and was waved
    // through as "reads nothing". A companion that exists but could not be
    // read is UNKNOWN, and unknown is the case this whole check exists to
    // refuse. Found by running it in `example/`, not by reading it.
    const companionExists = !!companion && existsSync(companion)
    _readsData = mod
      ? (typeof mod.load === 'function' || typeof mod.getStaticPaths === 'function')
      : companionExists

    for (const { path: urlPath, params } of targets) {
      let data = null
      if (mod && typeof mod.load === 'function') {
        try {
          data = await mod.load({ params, fetch: makeBuildFetch(node.id), url: urlPath })
        } catch (err) {
          skipped.push({ route: urlPath, reason: `load() threw: ${err.message}` })
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
        rendered = await renderComponent(wrapper, {
          data:     { data },
          cwd:      dirname(pageFile),
          filename: join(dirname(pageFile), '__prerender__.mesa'),
          islands,
          // The document is assembled here from `rendered.styles`, one
          // <style id> per component, so Mesa must not also prepend the whole
          // lot as one anonymous blob — that is the same CSS twice on the page.
          styleTag: false,
          // Temp modules land in the app's tree, not Mesa's package root, so a
          // rendered layout's bare imports resolve from the app's node_modules.
          // Without this, `import { page } from '@frontierjs/sierra/router'` in
          // a layout dies with "Cannot find package" (Mesa SSR_SPEC W1).
          ...(tmpDir ? { tmpDir } : {}),
        })
      } catch (err) {
        skipped.push({ route: urlPath, reason: `render failed: ${err.message}` })
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
          skipped.push({ route: urlPath, reason: `head() threw: ${err.message}` })
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
        lang:   node.meta?.lang ?? lang,
      })

      const file = join(outDirAbs, outputFileFor(urlPath))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, doc, 'utf8')
      const rel = relative(outDirAbs, file)
      written.push(rel)
      urls.push(urlPath)

      // Record which islands this page carries. Mesa tags each entry with the
      // file the call site was written in and the import specifier it came
      // from, which together resolve a marker's component NAME to a module —
      // the one thing a bundle needs and a marker cannot carry.
      for (const entry of rendered.islands ?? []) {
        if (!entry.specifier) {
          warn(`${urlPath}: <${entry.component} client:${entry.directive}> has no import specifier ` +
               `— it cannot be bundled and will stay inert. Import it from a .mesa file.`)
          continue
        }
        const module = resolve(dirname(entry.file), entry.specifier)
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

    } finally {
      if (recorder) {
        recorder.stop()
        const verdict = checkRoute({
          routeId:   node.file ? relative(root, resolve(root, node.file)) : node.id,
          meta:      node.meta,
          models:    recorder.models,
          tapped:    recorder.tapped,
          readsData: _readsData,
        })
        if (!verdict.ok) violations.push(verdict.message)
        safetyRows.push({
          route:     node.path ?? node.id,
          allowed:   declaredPublishLevel(node.meta).level,
          published: verdict.published,
        })
      }
    }
  }

  // ── The static-safety gate (FJS-081) ──────────────────────────────────
  // Thrown, not warned. A warning scrolls past in CI and the file is written
  // anyway — and once a public artifact exists it has been served, cached and
  // indexed, so there is no recovering from "we saw the warning later".
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
    islands: [...islandsByName.values()],
    islandPages,
    // What the check PROVED, not only what it rejected. A check nobody has seen
    // run is a rule nobody trusts, and this table is also the per-route
    // classification `IDEAS/static-safety.md` wants to build on.
    safety: safetyOn ? { rows: safetyRows, report: formatReport(safetyRows) } : null,
  }
}
