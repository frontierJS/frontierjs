// vite-config — Vite configs for the build pipeline.
//
//   1. Harbor: lib mode, single-file ES module SW. Dev-client is injected
//      by devClientPlugin (Harbor is user-authored — no auto-gen step).
//   2. Pages: MPA build w/ HTML entries (Vite root = cache dir, flat layout).
//      Dev-client injection happens in auto-gen output, not here — auto-gen
//      writes the import + invocation directly into main.js. By the time
//      Vite sees those entries, they already self-register with the dev WS.
//   3. Islands: multi-entry, no HTML. Same auto-gen pattern as pages.
//
// Why dev-client lives in auto-gen for pages/islands:
//   For HTML-rooted builds, the actual JS entry isn't in opts.input — only
//   the HTML is. Rollup classifies the HTML as the entry; the script
//   referenced inside is just a dependency. That makes it impossible for a
//   plugin to reliably target "the entry script" via input matching or
//   isEntry checks. Auto-gen knows exactly which file is which surface,
//   so injection there is trivial and correct.

import { mesaPlugin }      from './mesa-plugin.js'
import { devClientPlugin } from '../dev/dev-plugin.js'
import { loadUnoCSSPlugins } from './uno-plugin.js'

function harborPlugins({ dev, islandMatches, extRoot } = {}) {
  const list = [mesaPlugin({ extRoot, dev: !!dev?.port })]
  if (dev?.port) {
    list.push(devClientPlugin({
      port:          dev.port,
      clientType:    'harbor',
      islandMatches: islandMatches ?? null,
    }))
  }
  return list
}

export function harborViteConfig({ extRoot, harborEntry, outDir, dev = null, islandMatches = null }) {
  return {
    root: extRoot,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: true,
      lib: {
        entry: harborEntry,
        formats: ['es'],
        fileName: () => 'harbor.js',
      },
      // Single file, whatever the graph grows: `codeSplitting` belongs on the
      // rollup output, and `build.codeSplitting` is read by nothing.
      rollupOptions: { external: [], output: { codeSplitting: false } },
      minify: false,
    },
    plugins: harborPlugins({ dev, islandMatches, extRoot }),
    define: {
      'import.meta.env.JETTY_DEV_WS': dev?.port ? String(dev.port) : 'undefined',
      'import.meta.env.JETTY_DEV':    dev ? 'true' : 'false',
      '__JETTY_DEV__':                dev ? 'true' : 'false',
    },
  }
}

export function islandsViteConfig({ extRoot, islandId, islandEntry, outDir, dev = null }) {
  return {
    root: extRoot,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: true,
      // Lib mode, and it is load-bearing rather than a description. Vite
      // injects its preload helper into every client build that is not a lib
      // or a worker, and that helper is written with `import.meta.resolve` and
      // `import.meta.url`. An MV3 content script is a CLASSIC script, so V8
      // rejects the whole bundle at parse time — `Cannot use 'import.meta'
      // outside a module` — before a line of it runs, and nothing at build
      // time says so. The helper arrives only because the island graph holds a
      // dynamic import (`@frontierjs/mesa/runtime`, an optional peer), and it
      // has nothing to do here regardless: the graph below is inlined, so
      // there is no chunk to preload. Lib mode is also the true statement
      // about this output — one self-contained file, not a page module fetched
      // off a base URL — and it is the only supported way to opt out.
      //
      // One island per build, which the single `entry` makes structural:
      // rollup refuses to inline a graph with more than one input rather than
      // quietly splitting it.
      lib: {
        entry:    islandEntry,
        formats:  ['es'],
        fileName: () => `islands/${islandId}.js`,
      },
      // Inline EVERYTHING into the island entry — including modules pulled in
      // via dynamic import(). Two reasons:
      //   1. Content scripts run in the page's network context. Loading
      //      additional chunks would require declaring them in
      //      web_accessible_resources, which exposes the chunk hashes to
      //      every page (security smell — extension internals shouldn't be
      //      addressable from arbitrary pages).
      //   2. Even if exposed via WAR, the relative-URL resolution from the
      //      dynamic import() in jetty's mount.js produces paths like
      //      `chrome-extension://<id>/islands/chunks/runtime-<h>.js`, which
      //      Chrome blocks unless the chunk is in WAR. Inlining removes the
      //      round trip entirely.
      //
      // Tradeoff: islands can't share chunks with each other or with pages —
      // Mesa runtime gets duplicated across surfaces. For the ~80KB Mesa
      // runtime that's a real cost, but correctness wins. Pages (which have
      // HTML <script> + the extension's own origin) continue to share chunks
      // normally.
      rollupOptions: {
        external: [],
        output: {
          format: 'es',
          // `codeSplitting` is a rollup OUTPUT option. Vite reads no
          // `build.codeSplitting`, so the same key one level up is silently
          // ignored and the island splits — 24 kB plus a chunk Chrome will
          // not load, which is exactly the failure this whole config exists
          // to prevent.
          codeSplitting: false,
          // Both irrelevant while the graph is inlined, but kept so a plugin
          // emitting a chunk or an asset lands somewhere sensible.
          chunkFileNames: 'islands/chunks/[name]-[hash].js',
          assetFileNames: 'islands/assets/[name]-[hash][extname]',
        },
      },
      minify: false,
    },
    // No dev-client plugin — the auto-gen island entry already imports +
    // invokes startDevClient when dev mode is on.
    plugins: [mesaPlugin({ extRoot, dev: !!dev?.port })],
    define: {
      'import.meta.env.JETTY_DEV_WS': dev?.port ? String(dev.port) : 'undefined',
      'import.meta.env.JETTY_DEV':    dev ? 'true' : 'false',
      '__JETTY_DEV__':                dev ? 'true' : 'false',
    },
  }
}

export async function pagesViteConfig({ cacheRoot, htmlEntries, outDir, dev = null, extRoot = null }) {
  // Vite's root is the cache dir (auto-gen layout lives there), but mesa
  // resolution needs the actual extension root where node_modules lives.
  const isDev = !!dev?.port

  // UnoCSS is an optional peer dependency of the consumer extension. If
  // installed, we attach its Vite plugin so utility classes used in .mesa
  // templates (and other source files) get scanned and the generated CSS
  // is bundled. If not installed, this returns null and we proceed without
  // UnoCSS — same shape as before.
  const unoPlugins = await loadUnoCSSPlugins({ extRoot, viteRoot: cacheRoot })

  const plugins = [mesaPlugin({ extRoot, dev: isDev })]
  if (unoPlugins) plugins.push(...unoPlugins)

  return {
    root: cacheRoot,
    configFile: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: htmlEntries,
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
      minify: false,
    },
    // No dev-client plugin — the auto-gen page entries already import +
    // invoke startDevClient when dev mode is on.
    plugins,
    define: {
      'import.meta.env.JETTY_DEV_WS': dev?.port ? String(dev.port) : 'undefined',
      'import.meta.env.JETTY_DEV':    dev ? 'true' : 'false',
      '__JETTY_DEV__':                dev ? 'true' : 'false',
    },
  }
}

// Build Vite's input map from discovered Pages.
export function htmlEntriesFor({ dock, options, piers }, { autoGenPaths }, { cacheRoot }) {
  const entries = {}
  if (dock) {
    entries.dock = autoGenPaths.dock?.htmlPath ?? customDockHtml(dock)
  }
  if (options) {
    entries.options = autoGenPaths.options?.htmlPath ?? customOptionsHtml(options)
  }
  for (const pier of piers) {
    const key = `piers/${pier.id}`
    entries[key] = autoGenPaths.piers?.[pier.id]?.htmlPath ?? customPierHtml(pier)
  }
  return entries
}

function customDockHtml(_p)    { throw new Error('Custom dock main.js not yet supported in Phase 0') }
function customOptionsHtml(_p) { throw new Error('Custom options main.js not yet supported in Phase 0') }
function customPierHtml(_p)    { throw new Error('Custom pier main.js not yet supported in Phase 0') }
