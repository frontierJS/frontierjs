/**
 * build/index.js — createSierraViteConfig
 *
 * The main entry point for Sierra's Vite integration.
 * Returns a complete Vite config object from a sierra.config.js.
 *
 * Usage in vite.config.js:
 *   import { defineConfig } from 'vite'
 *   import { createSierraViteConfig } from 'sierra/build'
 *   import config from './config/sierra.config.js'
 *   export default defineConfig(createSierraViteConfig(config))
 *
 * @module sierra/build
 */

import { resolve, isAbsolute } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { mesaPlugin } from './mesa-plugin.js'
import { devtoolsPlugin } from './devtools-plugin.js'
import { scannerPlugin } from './scanner-plugin.js'
import { schemaPlugin }  from './schema-plugin.js'
import { virtualSierraPlugin } from '../virtual/virtual-sierra.js'
import { runPostBuild } from '../postbuild/index.js'
import { prerenderRoutes } from './prerender.js'
import { buildIslandBundle, injectIntoPages } from './island-bundle.js'
import { autoImportPlugin } from './auto-import-plugin.js'
import { appAliasPlugin } from './app-alias-plugin.js'
import { staticDataPlugin } from './static-data-plugin.js'
import { explainModuleInitFailure } from './warnings.js'
import { beginBuildImports, importAppModule } from './app-import.js'

/**
 * @typedef {Object} SierraConfig
 * @property {'spa'|'static'|'widget'} target
 * @property {string} [routesDir='src/routes']
 * @property {string} [base='/']
 * @property {'always'|'never'|'preserve'} [trailingSlash='always']
 * @property {'spa'|'static'} [render='spa']
 * @property {string} [outDir='dist/client']
 * @property {{ dir?: string, outDir?: string, prefix?: string, minify?: boolean }} [widgets]
 *   — the `widget` target: where the widgets are (default `src/Embeds`), where
 *   their scripts go (default `dist/embeds`), and the tag/class prefix every
 *   one of them takes (e.g. `mt-`). Built by `sierra widgets`, not by `vite build`.
 * @property {{ staticData?: boolean }} [dev]
 *   — `staticData` (default **true**) runs a `render: static` route's `load()`
 *   on the DEV SERVER and hands the page its JSON, so `vite dev` on a static
 *   surface shows the site with its data instead of correctly empty. The
 *   companion is never imported by the browser either way — the client gets a
 *   `fetch` to `/__sierra/static-data`, which is why this cannot re-open
 *   `FJS-543`. Dev only; a build is unaffected in every respect. Set it false
 *   for the old behaviour, where every prerendered page renders `data: null`
 *   and says so once per route.
 *   **The dev server must run under bun** for an app whose loader reads its own
 *   database: `bun --bun vite`, the same reason `build:site` has always needed
 *   it.
 * @property {{ shadowDOM?: boolean }} [mesa]
 * @property {{ components?: string[], modules?: Record<string, string[]|object|string> }} [autoImport]
 * @property {{ output?: string }} [routeTable] — where the generated route
 *   table is written (default `config/routes.js`)
 * @property {object} [junction]
 * @property {string} [db] — module exporting a Litestone client, used by the
 *   `static` target to observe what a route's `load()` reads (FJS-081). The
 *   module may default-export the client, or export it as `db` or `client`;
 *   a function export is called and awaited. Without it, a `render: static`
 *   route that reads data must declare `publishes:` in its frontmatter.
 * @property {object} [analytics]
 * @property {object} [vite]  — raw Vite overrides, merged last
 * @property {Array}  [plugins] — additional Vite plugins
 */

/**
 * Shared context passed between Sierra plugins so they can
 * communicate without re-running scans.
 *
 * @typedef {Object} SierraContext
 * @property {object|null} tree        — current route tree
 * @property {Map} staticMap           — file → ctx.isStatic boolean
 */

/**
 * Create a complete Vite config from a Sierra config object.
 *
 * @param {SierraConfig} config
 * @returns {import('vite').UserConfig}
 */
export function createSierraViteConfig(config = {}) {
  const {
    target = 'spa',
    routesDir = 'src/routes',
    outDir = 'dist/client',
    base = '/',
    vite: viteOverrides = {},
    plugins: userPlugins = [],
    mesa: mesaOptions = {},
  } = config

  // Shared state between plugins
  /** @type {SierraContext} */
  const sierraContext = {
    tree: null,
    staticMap: new Map(),
    layoutPropMap: new Map(),  // layout file path → Set of export let prop names
    autoImportMap: new Map(),  // name → { kind, from, imported }
  }

  const sierraPlugins = []

  if (target === 'spa' || target === 'static') {
    // Before the scanner: virtual:sierra embeds the generated model schemas,
    // so they must exist by the time it is built.
    sierraPlugins.push(schemaPlugin(config, sierraContext))
    sierraPlugins.push(scannerPlugin(config, sierraContext))
    // Dev only (`apply: 'serve'`). A prerendered route's load() runs in Node,
    // and in dev this process IS the Node — so the page can be seen with its
    // data instead of correctly empty.
    if (config.dev?.staticData ?? true) sierraPlugins.push(staticDataPlugin(config, sierraContext))
    sierraPlugins.push(virtualSierraPlugin(config, sierraContext))
    // The island bundle is a second Vite build, so it needs its own plugin
    // instances — a factory, not the array. Reusing the live instances would
    // hand the island build plugins that have already run configResolved for a
    // different config, and including postBuildPlugin itself would recurse:
    // its closeBundle is what starts the island build.
    sierraPlugins.push(postBuildPlugin(config, sierraContext, () => [
      // The island build is handed `root` explicitly, so the alias plugin
      // resolves `@` there exactly as it does in the main build.
      appAliasPlugin(),
      mesaPlugin({ ...mesaOptions, routesDir }, sierraContext),
    ]))
  }

  // Auto-import (all targets — widget components benefit too)
  const aiPlugin = autoImportPlugin(config, sierraContext)
  if (aiPlugin) sierraPlugins.push(aiPlugin)

  // Mesa compiler for all targets
  // Devtools toolbar — dev only, no bundle impact in production
  sierraPlugins.push(devtoolsPlugin(config))

  // `@` → the surface's own src/. A plugin rather than an alias entry below,
  // because the base is the Vite root and that is not known until the app's own
  // vite.config.js sets it. See app-alias-plugin.js.
  sierraPlugins.push(appAliasPlugin())

  sierraPlugins.push(mesaPlugin({ ...mesaOptions, routesDir }, sierraContext))

  // Build the base Vite config per target
  const baseConfig = buildBaseConfig(config, sierraPlugins, userPlugins)

  // Merge user vite overrides last — they win over everything
  return deepMerge(baseConfig, viteOverrides)
}

/**
 * Build the base Vite config for a given target.
 */
function buildBaseConfig(config, sierraPlugins, userPlugins) {
  const {
    target = 'spa',
    base = '/',
    outDir = 'dist/client',
    routesDir = 'src/routes',
  } = config

  /** @type {import('vite').UserConfig} */
  const shared = {
    base,
    resolve: {
      alias: {
        // `@` is NOT here — appAliasPlugin contributes it, because it is the
        // Vite root that decides where it points and this object is built
        // before the app's config sets one.
        //
        // NOTE: @frontierjs/mesa subpath resolution is handled by the resolveId
        // hook in mesaPlugin, which resolves both bare and .js-suffixed forms to
        // absolute file paths. No aliases needed here.
      },
    },
    optimizeDeps: {
      // Keep Sierra out of esbuild's dep pre-scan: it contains .mesa files
      // esbuild cannot parse, and the Mesa plugin only runs after the scan.
      //
      // The name must be the PACKAGE name. An app that resolves sierra from
      // node_modules gets it pre-bundled otherwise: the scan dies on the first
      // .mesa, the entry is dropped from _metadata.json, and Vite still rewrites
      // every import to the deps path it never wrote — a 200 serving the SPA
      // fallback's HTML with an empty content type, which the browser refuses as
      // a module. The app is a blank screen. Nothing in this repo can see it,
      // because an app here resolves sierra to packages/ and Vite does not
      // pre-bundle a linked dependency at all.
      exclude: ['@frontierjs/sierra'],
    },
    plugins: [
      ...sierraPlugins,
      ...userPlugins,
    ],
    server: {
      port: parseInt(process.env.PORT ?? '3000'),
      host: !!process.env.VITE_HOST_APP,
      open: false,
      hmr: {
        overlay: true,
      },
    },
    build: {
      outDir,
      cssCodeSplit: false,
      minify: process.env.NODE_ENV === 'production',
    },
  }

  switch (target) {
    case 'spa':
      return {
        ...shared,
        build: {
          ...shared.build,
          rollupOptions: {
            // No special config — Vite's default chunking handles SPA well
          },
        },
      }

    case 'static':
      // Same Vite config as 'spa' — the difference is not in how the bundle is
      // produced but in what happens after it: postBuildPlugin's closeBundle
      // prerenders every route declaring `render: static` to its own
      // index.html. This branch used to carry a comment saying SSG "is handled
      // separately" and nothing handled it, so the target silently built an SPA.
      return {
        ...shared,
        build: { ...shared.build },
      }

    case 'widget':
      // This config is what a widget is COMPILED with — the Mesa compiler, the
      // auto-imports, the app's own plugins. It is not what emits the bundles:
      // a widget is a self-contained IIFE for a page with no bundler, so each
      // one is its own library build and `sierra widgets` runs the loop
      // (build/widget-build.js). What this branch is for on its own is `vite
      // dev` rooted at the `widgets/` surface, where that surface's own
      // index.html hosts the widgets while they are written — the app's `web/`
      // is a different Vite root with a different config and may not exist.
      //
      // `cssCodeSplit: false` is here as well as in the loop, so a dev server
      // and a build agree about where the stylesheet is.
      return {
        ...shared,
        build: {
          ...shared.build,
          outDir: config.widgets?.outDir ?? 'dist/embeds',
          cssCodeSplit: false,
        },
      }

    default:
      throw new Error(`[Sierra] Unknown target: ${target}. Must be 'spa', 'static', or 'widget'.`)
  }
}

/**
 * Deep merge two objects. `b` wins over `a` for scalar values.
 * Arrays are concatenated.
 */
function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a
  if (!a || typeof a !== 'object') return b

  const result = { ...a }

  for (const [key, bVal] of Object.entries(b)) {
    const aVal = a[key]

    if (Array.isArray(aVal) && Array.isArray(bVal)) {
      // Concatenate arrays (e.g. plugins)
      result[key] = [...aVal, ...bVal]
    } else if (
      aVal && bVal &&
      typeof aVal === 'object' && typeof bVal === 'object' &&
      !Array.isArray(aVal)
    ) {
      result[key] = deepMerge(aVal, bVal)
    } else {
      result[key] = bVal
    }
  }

  return result
}

/**
 * Post-build pipeline plugin.
 * Runs after vite build via the closeBundle hook.
 */
function postBuildPlugin(config, sierraContext, islandPlugins = () => []) {
  let root = process.cwd()
  let outDir = config.outDir ?? 'dist/client'
  let isBuild = false

  return {
    name: 'sierra:postbuild',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
      outDir = resolve(root, viteConfig.build?.outDir ?? config.outDir ?? 'dist/client')
      isBuild = viteConfig.command === 'build'
    },

    // What CSS this build emitted. A prerendered page is assembled by Sierra
    // rather than by Vite's HTML transform, so nothing was linking the app's
    // stylesheet into it: `target: 'static'` shipped pages carrying every
    // @frontierjs/css class name and none of the rules. The bundle is only
    // visible in an output hook — closeBundle has no access to it — so it is
    // recorded here and read one hook later.
    //
    // writeBundle, not generateBundle: Vite's own CSS plugin emits the
    // stylesheet in ITS generateBundle, which runs after this plugin's (plugin
    // order), so reading the bundle a hook earlier saw an empty asset list and
    // linked nothing, with no error to say so.
    writeBundle(_opts, bundle) {
      sierraContext.cssAssets = Object.values(bundle)
        .filter((c) => c.type === 'asset' && c.fileName.endsWith('.css'))
        .map((c) => c.fileName)
    },

    async closeBundle() {
      if (!isBuild) return  // skip in dev server

      // One build, one record of what failed while loading — see app-import.js.
      beginBuildImports()

      // What the prerenderer actually emitted, for the post-build steps that
      // have to enumerate the site. Stays null on an SPA, where the route
      // table is the whole answer (`FJS-502`).
      let prerenderedUrls = null

      // Build a minimal route table from the tree Sierra already has
      const tree = sierraContext.tree
      if (!tree) return

      // Re-derive the flat arrays from the tree (same logic as generate-route-table)
      const allNodes = flattenTree(tree)
      const routeNodes = allNodes.filter(n => n.file !== null)

      const routeTable = {
        tree,
        all:       routeNodes.map(n => n.path),
        indexed:   routeNodes
          .filter(n => n.meta?.status !== 'draft')
          .filter(n => n.meta?.robots !== 'noindex')
          .filter(n => !n.meta?.dynamic)
          .map(n => n.path),
        // The same list with the DYNAMIC exclusion left off. `indexed` drops
        // `/products/:slug/` because an SPA cannot know what it stands for; a
        // static build emitted those pages and has to be able to ask whether
        // the route they came from wanted indexing (`FJS-502`). Draft and
        // noindex still apply — those are the actual decisions.
        indexable: routeNodes
          .filter(n => n.meta?.status !== 'draft')
          .filter(n => n.meta?.robots !== 'noindex')
          .map(n => n.path),
        redirects: routeNodes
          .filter(n => n.meta?.redirect)
          .map(n => [n.path, n.meta.redirect]),
      }

      // Prerender before postbuild so the emitted HTML is on disk when
      // move404 / sitemap / speculation inspect the output directory.
      //
      // Gated on target:'static' — the per-route `render: static` frontmatter
      // is the unit of control, and this target is what opts the build into
      // acting on it. An 'spa' build ignores the frontmatter exactly as before.
      if ((config.target ?? 'spa') === 'static') {
        const { renderComponent } = await import('@frontierjs/mesa/render-component.js')

        // Static safety (FJS-081): a prerendered page is public, so the build
        // has to be able to say what data went into it. The schema came from
        // schemaPlugin earlier in this same build; the client is what lets the
        // build OBSERVE a load()'s reads via $tapQuery. Without the client a
        // route that reads data is refused rather than assumed safe — see
        // build/static-safety.js.
        const safetyDb = await resolveBuildDb(config, root)

        // The trap this target sets, named rather than left to be discovered:
        // a theme class on <body> shadows the one the switcher puts on <html>
        // for every token both of them define, so the page renders one theme
        // forever and nothing errors (`FJS-501`). Warned rather than rewritten
        // — the app wrote it, and an app with no switcher is entitled to it.
        const bakedOnBody = String(config.document?.bodyClass ?? '')
          .split(/\s+/).filter((c) => /^theme-/.test(c))
        if (config.theme && bakedOnBody.length) {
          console.warn(
            `\n  [Sierra] document.bodyClass carries ${bakedOnBody.join(', ')}, and this app ` +
            `configures a theme switcher.\n` +
            `    The switcher writes <html>, so a theme class on <body> wins for every token ` +
            `both define\n    and the switch changes nothing a visitor can see. Drop it — the ` +
            `theme block already\n    puts '${config.theme.default ?? 'system'}' on <html>.\n`
          )
        }

        const pre = await prerenderRoutes({
          tree, root,
          routesDir: config.routesDir ?? 'src/routes',
          outDir,
          renderComponent,
          schemaDefs:   sierraContext.schemaDefs,
          schemaModels: sierraContext.schemaModels,
          db:           safetyDb,
          // Islands are the only way a `target: 'static'` page can be
          // interactive — it ships no other script — so the marker pass is on
          // for this target rather than being another flag to find.
          islands: config.islands !== false,
          // What one route may take before the build stops waiting rather than
          // hanging with nothing written and nothing said (`FJS-549`).
          ...(config.prerender?.timeout !== undefined ? { timeout: config.prerender.timeout } : {}),
          // The document around the body: the app's own stylesheet, plus
          // whatever `index.html` puts on <body> (a theme class, in every app
          // in this repo). Neither reaches a prerendered page any other way.
          stylesheets: (sierraContext.cssAssets ?? [])
            .map((f) => (config.base ?? '/').replace(/\/$/, '') + '/' + f),
          bodyClass: config.document?.bodyClass,
          htmlClass: resolveHtmlClass(config),
          lang:      config.document?.lang,
          // Compile temp modules inside the app so a layout's bare imports
          // resolve from the app's node_modules, not Mesa's (Mesa SSR_SPEC W1).
          tmpDir: resolve(root, 'node_modules/.sierra/render'),
          warn: (m) => console.warn(`  [Sierra] prerender: ${m}`),
        })

        if (pre.written.length > 0) {
          console.log(`\n  [Sierra] Prerendered ${pre.written.length} page(s):`)
          for (const f of pre.written) console.log(`    ✓ ${f}`)
        }

        // Print what the safety check proved. A rule whose passing case is
        // invisible is a rule people assume is not running.
        if (pre.safety?.report) {
          console.log(`\n  [Sierra] Static safety — what each page may publish:`)
          console.log(pre.safety.report)
        }

        // Islands: bundle what the prerendered pages actually used, then put a
        // script tag on the pages that use them. A page with no island keeps
        // shipping zero JavaScript.
        if (pre.islands?.length) {
          try {
            const { build: viteBuild } = await import('vite')
            const bundle = await buildIslandBundle({
              islands: pre.islands,
              root, outDir, base: config.base ?? '/',
              plugins: islandPlugins(),
              viteBuild,
              // A prerendered page never loads `virtual:sierra`, so this entry
              // is the only thing that can tell the browser what the app's
              // theme block says (`FJS-501`).
              theme: config.theme ?? null,
            })
            if (bundle) {
              const touched = await injectIntoPages(outDir, pre.islandPages, bundle.src)
              console.log(
                `\n  [Sierra] Islands: ${pre.islands.length} component(s) → ${bundle.fileName}` +
                `\n    mounted on ${touched.length} page(s): ${pre.islands.map(i => i.component).join(', ')}`
              )
            }
          } catch (err) {
            // Loud, and not fatal to the rest of the build: the pages exist and
            // are correct, they are just inert. Silence here would ship a site
            // whose buttons do nothing with a green build log.
            console.error(
              `\n  [Sierra] Island bundling FAILED — the prerendered pages are correct but ` +
              `their islands will not mount:\n    ${err.stack ?? err.message}`
            )
          }
        }
        // A page that TRIED and threw is a broken build, not a page that opted
        // out. Both landed in `skipped`, so a render failure printed one warning
        // line among the bundler's own and the build exited 0 — and, when it was
        // the only static route, went on to blame the frontmatter for a page
        // that plainly declares `render: static`. What ships from that is a
        // deploy with a missing page and a green log.
        const broke = pre.skipped.filter(s => /^(render failed|load\(\) threw|getStaticPaths\(\) threw|head\(\) threw)/.test(s.reason))
        if (broke.length) {
          throw new Error(
            `[Sierra] ${broke.length} static route(s) failed to render:\n` +
            broke.map(s => `    ${s.route} — ${s.reason}`).join('\n')
          )
        }

        // Silence is how the static target failed before — it emitted nothing
        // and said nothing. If a static build produced no pages, say so.
        prerenderedUrls = pre.urls

        if (pre.written.length === 0) {
          console.warn(
            `\n  [Sierra] target:'static' produced no pages — no route declares ` +
            `\`render: static\` in its frontmatter.`
          )
        }
      }

      const results = await runPostBuild(config, routeTable, outDir, root, prerenderedUrls)

      if (results.length > 0) {
        console.log('\n  [Sierra] Post-build:')
        for (const r of results) {
          console.log(`    ✓ ${r}`)
        }
        console.log()
      }
    },
  }
}

/**
 * Load the Litestone client the static-safety check taps (FJS-081).
 *
 * Config `db` names a module. Which export holds the client is not worth a
 * second config key, so the conventional three are tried — default, `db`,
 * `client` — and a function export is called, which covers the common
 * `export default () => createClient(…)` factory.
 *
 * ABSENT and WRONG-SHAPED return null rather than throwing. A missing client
 * does NOT make the build pass: it makes reads unobservable, and an
 * unobservable route is refused by checkRoute unless it declares `publishes:`.
 * Failing there instead would report "cannot import db.js" for what is really
 * "this page might be leaking", which sends the reader to the wrong problem.
 *
 * **A module that THREW is the case that is not ambiguous, and it fails the
 * build** (`FJS-551`). It was on the same warn-and-continue path as the other
 * two for its whole life, so the one truthful error a build ever gets — the
 * schema parse error, the missing environment variable, whatever the app's own
 * module said on its way up — was written to stderr as a warning and then
 * buried under every downstream TDZ. The same separation `FJS-439` made for a
 * route whose render threw: *nothing to emit* and *broken* are two answers.
 */
async function resolveBuildDb(config, root) {
  if (!config?.db) return null

  const abs = isAbsolute(config.db) ? config.db : resolve(root, config.db)
  const res = await importAppModule(abs)

  if (!res.ok && res.reason === 'missing') {
    console.warn(`  [Sierra] static safety: config.db '${config.db}' not found — reads cannot be checked`)
    return null
  }

  if (!res.ok) throw new Error(
    `[Sierra] static safety: '${config.db}' threw while it was loading.\n` +
    `  ${explainModuleInitFailure(res.error?.message ?? String(res.error), config.db)}\n` +
    `  The build cannot observe what a page reads without this client, and a module that ` +
    `threw is not a module that is missing — fix it, or take it out of sierra.config.js.`
  )

  let candidate = res.module.default ?? res.module.db ?? res.module.client ?? null
  if (typeof candidate === 'function') candidate = await candidate()

  if (!candidate || typeof candidate.$tapQuery !== 'function') {
    console.warn(
      `  [Sierra] static safety: '${config.db}' does not export a Litestone client ` +
      `with $tapQuery — reads cannot be checked`
    )
    return null
  }
  return candidate
}

/**
 * The class a prerendered page carries on <html>.
 *
 * `document.htmlClass` if the app stated one, and otherwise the theme it
 * declared — because on this target the theme class has to be in the FILE. A
 * prerendered page's first paint happens with no JavaScript at all, and the
 * element is <html> because that is where the switcher and the injected
 * flash-prevention script both write (theme/index.js § why the element is not
 * a knob).
 *
 * Derived rather than asked for: an author who had to write the theme class
 * into their own document block would write it onto <body>, which is the one
 * place it silently does not work — see `wrapDocument`, and `FJS-501`.
 *
 * `default: 'system'` resolves to nothing here on purpose. Which of the pair a
 * visitor gets is a question only their browser can answer, and the injected
 * <head> script answers it before paint; baking either one would be a guess
 * that is wrong half the time and cached by a CDN.
 */
function resolveHtmlClass(config) {
  const stated = config.document?.htmlClass
  if (stated) return stated

  const dflt = config.theme?.default
  if (!dflt || dflt === 'system') return ''
  return dflt
}

function flattenTree(node) {
  return [node, ...(node.children ?? []).flatMap(flattenTree)]
}

// Named exports for unit testing
export { deepMerge as _deepMerge }
