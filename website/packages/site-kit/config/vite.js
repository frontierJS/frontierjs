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
import { readSettings, siteContent, writeSettingsModule } from './content.js'
import { siteDialect } from './dialect.js'
import { siteImages } from './images.js'
import { loadPreset } from './preset.js'
import { presetPublic } from './public.js'
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

  // site.js is the site's Sierra config, which the browser imports whole;
  // site.md is its settings, the data its pages and its preset read.
  const configPath = resolve(content, 'settings/site.js')
  const configModule = existsSync(configPath) ? await import(pathToFileURL(configPath).href) : {}
  const { preset: presetName, ...siteConfig } = configModule.default ?? {}
  const settings = readSettings(root)
  const keys = Object.keys(settings)
  const preset = presetName
    ? await loadPreset(presetName, { root, content, settings })
    : {}
  const dialect = siteDialect()
  const publicDir = resolve(content, 'public')
  const presetPublicDir = preset.root && resolve(preset.root, 'public')
  const mesa = { ...preset.sierra?.mesa, ...siteConfig.mesa }
  const autoImport = siteConfig.autoImport ?? preset.sierra?.autoImport

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
    ...preset.sierra,
    ...siteConfig,
    // No theme class here — a `theme` block puts it on <html>, where the
    // switcher writes. On <body> it would shadow the switcher for every token
    // both define (FJS-501). Merged key by key, as `mesa` is: a site stating
    // its own `document.head` keeps the preset's JSON-LD and body id.
    document: { ...preset.sierra?.document, ...siteConfig.document },
    // Neither a preset nor a site moves these. Every site-kit site keeps its
    // pages in content/routes (FJS-D606). The browser's half of the config is
    // content/settings/site.js, imported whole (FJS-1544): a preset that
    // named its own would hide the site's `theme` from the switcher. Without
    // that file it is an empty module, never Sierra's guess at
    // config/sierra.config.js (FJS-1709).
    routesDir: 'content/routes',
    // Every key in site.md is a bare name in a page, beside whatever the
    // preset or the site auto-imports; Sierra refuses a name two modules bind.
    autoImport: keys.length
      ? { ...autoImport, modules: { [writeSettingsModule(root, settings)]: keys, ...autoImport?.modules } }
      : autoImport,
    // The kit's dialect runs first, so a preset's passes see a page already
    // split into bands and articles. The check runs before a preset's
    // post-build steps rewrite the output.
    mesa: {
      ...mesa,
      remarkPlugins: [...dialect.remarkPlugins, ...(mesa.remarkPlugins ?? [])],
      rehypePlugins: [...dialect.rehypePlugins, ...(mesa.rehypePlugins ?? [])],
    },
    // Images go last, so their srcsets are added to the pages a preset's
    // steps leave behind rather than to pages those steps then replace.
    plugins: [dialect.check, ...(preset.sierra?.plugins ?? []), siteImages()],
    // What `layout:` can name: the kit's own (Block), then the preset's, then
    // the site's content/layouts. A later directory wins a name, so a preset
    // or a site replaces a kit layout without copying the rest.
    markdownLayouts: [
      resolve(KIT, 'src/layouts'),
      ...(preset.sierra?.markdownLayouts ?? []),
      ...(siteConfig.markdownLayouts ?? (existsSync(resolve(content, 'layouts')) ? ['content/layouts'] : [])),
    ],
    _configPath: existsSync(configPath) ? configPath : resolve(KIT, 'config/no-settings.js'),
  })

  return {
    ...base,
    configFile: false,
    root,
    publicDir,
    plugins: [
      ...(base.plugins ?? []),
      ...(preset.plugins ?? []),
      ...(presetPublicDir && existsSync(presetPublicDir) ? [presetPublic({ dir: presetPublicDir, site: publicDir })] : []),
      siteContent({ root, content, keys }),
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
