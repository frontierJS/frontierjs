// config/vite.js — a site-kit site's whole build, as one call.
//
// A site is a directory holding `content/` and nothing else; `site-kit dev
// <dir>` and `site-kit build <dir>` hand that directory here. The directory is
// still the Vite root, so `dist/` lands beside `content/` and every
// root-relative path Sierra writes means what it always meant.
//
// `vite dev` on it is how a page is WRITTEN, client-routed. `vite build` is
// what SHIPS: target 'static' is the same config plus a prerender pass in
// closeBundle, so one HTML file per route, the island chunks and the publish
// check exist only in the build. A page that works in dev and fails in the
// build is the normal case.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSierraViteConfig } from '@frontierjs/sierra/build'
import { loadPreset } from './preset.js'
import { siteShell } from './shell.js'

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {object} opts
 * @param {string} opts.root — the site directory, the one holding `content/`
 * @param {number} [opts.port] — dev port; `SITE_PORT` / `FLI_PORT_SITE` otherwise
 * @param {boolean} [opts.host] — listen on every interface, not just localhost
 * @returns {Promise<import('vite').InlineConfig>}
 */
export async function siteKit({ root, port, host = false }) {
  root = resolve(root)
  const content = resolve(root, 'content')
  if (!existsSync(content)) throw new Error(`site-kit: no content/ in ${root}`)

  const settingsPath = resolve(content, 'settings/site.js')
  const settingsModule = existsSync(settingsPath) ? await import(pathToFileURL(settingsPath).href) : {}
  const { preset: presetName, ...settings } = settingsModule.default ?? {}
  const preset = presetName
    ? await loadPreset(presetName, { root, content, settings: settingsModule })
    : {}

  const base = createSierraViteConfig({
    target:    'static',
    outDir:    'dist',
    // A directory per route, so `/showroom/` is a folder holding index.html and
    // a relative link resolves from where its author meant it to.
    trailingSlash: 'always',
    // Generated, and not content, so it is gitignored. NOT under node_modules:
    // Vite neither watches a file there nor lets the browser revalidate it —
    // it is served `?v=<hash>` and `immutable` — so a route added while the dev
    // server ran stayed missing, even across reloads, until the cache was
    // cleared, and editing it updated nothing.
    routeTable: { output: '.sierra/routes.js' },
    // No theme class here — a `theme` block puts it on <html>, where the
    // switcher writes. On <body> it would shadow the switcher for every token
    // both define (FJS-501).
    document: {},
    ...preset.sierra,
    ...settings,
    // Neither a preset nor a site moves these. Every site-kit site keeps its
    // pages in content/routes (FJS-D606). The browser's half of the config is
    // the site's settings file, imported whole (FJS-1544): a preset that
    // named its own would hide the site's `theme` from the switcher. Without
    // a settings file it is an empty module, never Sierra's guess at
    // config/sierra.config.js (FJS-1709).
    routesDir: 'content/routes',
    _configPath: existsSync(settingsPath) ? settingsPath : resolve(KIT, 'config/no-settings.js'),
  })

  return {
    ...base,
    configFile: false,
    root,
    publicDir: resolve(content, 'public'),
    plugins: [
      ...(base.plugins ?? []),
      ...(preset.plugins ?? []),
      siteShell({
        html:  preset.shell?.html ?? resolve(KIT, 'index.html'),
        entry: preset.shell?.entry ?? resolve(KIT, 'src/main.js'),
      }),
    ],
    server: {
      ...base.server,
      port: port ?? parseInt(process.env.SITE_PORT ?? process.env.FLI_PORT_SITE ?? '8600', 10),
      host,
      // Vite hops to the next free port without a word, and a drive pointed at
      // the port it hopped from then tests whatever else is listening.
      strictPort: true,
    },
  }
}
