// config/preset.js — the package a site names as its preset (FJS-D605, FJS-D648).
//
// `preset: '@kobami/ksite'` in content/settings/site.js names a package whose
// `./preset` export is a function of the site, returning what that package
// adds to it:
//
//   export default ({ root, content, settings }) => ({
//     sierra:  { autoImport, markdownLayouts, mesa, plugins, … },  // over site-kit's, under the site's own
//     plugins: [UnoCSS(…)],                                       // Vite plugins, after Sierra's
//     shell:   { html, entry },                                   // the dev document and its entry
//   })
//
// `settings` is the site's settings module whole — a preset may read named
// exports beside the default. A site that names a preset it cannot load would
// build without its blocks and layouts, every page wrong, so each way of
// failing to load one stops the build by name.

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEYS = new Set(['sierra', 'plugins', 'shell'])

/**
 * @param {string} name — the package, as content/settings/site.js names it
 * @param {{ root: string, content: string, settings: Record<string, unknown> }} site
 * @returns {Promise<{ sierra?: object, plugins?: import('vite').PluginOption[], shell?: { html: string, entry: string } }>}
 */
export async function loadPreset(name, site) {
  if (typeof name !== 'string') throw new Error(`site-kit: the preset in content/settings/site.js is a ${typeof name}; it is a package name`)
  const named = `content/settings/site.js names the preset '${name}'`

  // From the site, not from site-kit: the preset is the site's dependency.
  let file
  try {
    file = createRequire(resolve(site.root, 'package.json')).resolve(`${name}/preset`)
  } catch (err) {
    const why = err?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ? `which has no "./preset" export`
      : `which does not resolve from ${site.root} — is it a dependency of the site?`
    throw new Error(`site-kit: ${named}, ${why}`)
  }

  const preset = (await import(pathToFileURL(file).href)).default
  if (typeof preset !== 'function') throw new Error(`site-kit: ${named}, whose "./preset" default export is not a function of the site`)

  const added = (await preset(site)) ?? {}
  const unknown = Object.keys(added).filter((k) => !KEYS.has(k))
  if (unknown.length) throw new Error(`site-kit: the preset '${name}' returned ${unknown.map((k) => `'${k}'`).join(', ')}; a preset returns sierra, plugins and shell`)
  if (added.shell && !(added.shell.html && added.shell.entry)) throw new Error(`site-kit: the preset '${name}' returned a shell without both html and entry`)
  return added
}
