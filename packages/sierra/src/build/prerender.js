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
export function wrapDocument(bodyHTML, { title, css, lang = 'en' } = {}) {
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const styleTag = css && css.trim() ? `\n  <style>${css.trim()}</style>` : ''
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title ?? '')}</title>${styleTag}
</head>
<body>
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
 * @returns {Promise<{ written: string[], skipped: Array<{route:string, reason:string}> }>}
 */
export async function prerenderRoutes(opts) {
  const {
    tree, root, routesDir = 'src/routes', outDir = 'dist/client',
    warn = () => {}, renderComponent,
  } = opts

  const routesDirAbs = resolve(root, routesDir)
  const outDirAbs    = resolve(root, outDir)
  const written = []
  const skipped = []

  const staticNodes = flatten(tree).filter(n => n.meta?.render === 'static' && n.file)

  for (const node of staticNodes) {
    const pageFile = resolve(root, node.file)
    if (!existsSync(pageFile)) {
      skipped.push({ route: node.id, reason: 'route file not found' })
      continue
    }

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
        })
      } catch (err) {
        skipped.push({ route: urlPath, reason: `render failed: ${err.message}` })
        continue
      }

      const doc = wrapDocument(rendered.html, {
        title: node.meta?.title ?? node.meta?.frontmatter?.title,
        css:   rendered.css,
      })

      const file = join(outDirAbs, outputFileFor(urlPath))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, doc, 'utf8')
      written.push(relative(outDirAbs, file))
    }
  }

  for (const s of skipped) warn(`${s.route}: ${s.reason}`)
  return { written, skipped }
}
