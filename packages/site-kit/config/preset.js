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
//     rules:   [{ id, group, stage, run }],                       // what `site-kit check` runs beside its own (FJS-D962)
//   })
//
// What a preset does not return is found: `public/` at its package root ships
// beneath the site's own (config/public.js).
//
// `settings` is content/settings/site.md's front-matter (config/content.js),
// the site's data rather than its Sierra config. A site that names a preset it cannot load would
// build without its blocks and layouts, every page wrong, so each way of
// failing to load one stops the build by name.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEYS = new Set(['sierra', 'plugins', 'shell', 'rules'])
const RULE = ['id', 'group', 'stage', 'run']

/**
 * @param {string} name — the package, as content/settings/site.js names it
 * @param {{ root: string, content: string, settings: Record<string, unknown> }} site
 * @returns {Promise<{ sierra?: object, plugins?: import('vite').PluginOption[], shell?: { html: string, entry: string }, rules?: object[], root: string }>}
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
  if (unknown.length) throw new Error(`site-kit: the preset '${name}' returned ${unknown.map((k) => `'${k}'`).join(', ')}; a preset returns sierra, plugins, shell and rules`)
  if (added.shell && !(added.shell.html && added.shell.entry)) throw new Error(`site-kit: the preset '${name}' returned a shell without both html and entry`)
  if (added.rules !== undefined) {
    if (!Array.isArray(added.rules)) throw new Error(`site-kit: the preset '${name}' returned rules that are not a list`)
    for (const [i, rule] of added.rules.entries()) {
      const missing = RULE.filter((k) => !(k in (rule ?? {})))
      if (missing.length) throw new Error(`site-kit: the preset '${name}' returned a rule (index ${i}${rule?.id ? `, '${rule.id}'` : ''}) without ${missing.join(', ')}; a rule is { id, group, stage, run }`)
      if (!['source', 'built'].includes(rule.stage)) throw new Error(`site-kit: the preset '${name}' returned the rule '${rule.id}' with stage '${rule.stage}'; a stage is source or built`)
    }
  }
  return { ...added, root: packageRoot(file, name) }
}

// The `./preset` export can sit anywhere in the package, so its root is the
// nearest package.json that names it.
function packageRoot(file, name) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = resolve(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
  }
  throw new Error(`site-kit: the preset '${name}' resolved to ${file}, under no package.json named '${name}'`)
}
