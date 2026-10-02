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
import { siteShell } from './shell.js'

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {object} opts
 * @param {string} opts.root — the site directory, the one holding `content/`
 * @param {number} [opts.port] — dev port; `SITE_PORT` / `FLI_PORT_SITE` otherwise
 * @returns {Promise<import('vite').InlineConfig>}
 */
export async function siteKit({ root, port }) {
  root = resolve(root)
  const content = resolve(root, 'content')
  if (!existsSync(content)) throw new Error(`site-kit: no content/ in ${root}`)

  const settingsPath = resolve(content, 'settings/site.js')
  const settings = existsSync(settingsPath)
    ? (await import(pathToFileURL(settingsPath).href)).default ?? {}
    : {}

  const base = createSierraViteConfig({
    target:    'static',
    routesDir: 'content/routes',
    outDir:    'dist',
    // A directory per route, so `/showroom/` is a folder holding index.html and
    // a relative link resolves from where its author meant it to.
    trailingSlash: 'always',
    // Generated, and not content: under node_modules so the site directory
    // holds only what its author wrote. Sierra imports it root-relative.
    routeTable: { output: 'node_modules/.sierra/routes.js' },
    // The browser's half of the config is the site's settings file, and only
    // when there is one; `virtual:sierra` imports it whole (FJS-1544).
    ...(existsSync(settingsPath) ? { _configPath: settingsPath } : {}),
    // No theme class here — a `theme` block puts it on <html>, where the
    // switcher writes. On <body> it would shadow the switcher for every token
    // both define (FJS-501).
    document: {},
    ...settings,
  })

  return {
    ...base,
    configFile: false,
    root,
    publicDir: resolve(content, 'public'),
    plugins: [...(base.plugins ?? []), siteShell(resolve(KIT, 'index.html'))],
    server: {
      ...base.server,
      port: port ?? parseInt(process.env.SITE_PORT ?? process.env.FLI_PORT_SITE ?? '8600', 10),
      // Vite hops to the next free port without a word, and a drive pointed at
      // the port it hopped from then tests whatever else is listening.
      strictPort: true,
    },
  }
}
