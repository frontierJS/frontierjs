/**
 * markdown-layouts.js — the names a `.md` file's `layout:` can say
 *
 * Config:
 *   markdownLayouts: ['src/blocks', 'content/layouts']
 *
 * A layout is any `.mesa` or `.md` file directly in one of these directories,
 * named by its basename. The list is ORDERED and a later directory wins a name:
 * that is how a site cut from a template replaces one of the template's layouts
 * without copying the rest — ksite's `content/layouts/` over `src/blocks/`
 * (`FJS-1493`). Unlike `autoImport`, where two files claiming a name is an
 * error (`FJS-1494`), here the author has already written the order down.
 *
 * Layouts are a namespace of their own. ksite's `content/blocks/Trust.md` says
 * `layout: Trust` and is wrapped by `src/blocks/Trust.mesa`; the tag `<Trust />`
 * in a page means the block, and the layout name means the wrapper. Kept apart,
 * both can be spelled the way ksite spells them.
 *
 * Mesa does the wrapping (`compileMd`, `layouts` option). This plugin only
 * answers which file a name means, into `sierraContext.markdownLayouts`, which
 * the Vite transform and the prerender both hand to Mesa.
 */

import { resolve, relative, basename, extname } from 'path'
import { readdir } from 'fs/promises'

/**
 * @param {string} root
 * @param {string[]} dirs — in order; a later directory wins a name
 * @returns {Promise<Record<string,string>>} name → absolute path
 */
export async function scanMarkdownLayouts(root, dirs) {
  const layouts = {}
  for (const dir of dirs) {
    const abs = resolve(root, dir)
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      console.warn(`[Sierra] markdownLayouts dir not found: ${dir}`)
      continue
    }
    const here = new Map()
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const ext = extname(e.name)
      if (!e.isFile() || (ext !== '.mesa' && ext !== '.md')) continue
      const name = basename(e.name, ext)
      // Within ONE directory there is no order to appeal to.
      if (here.has(name)) {
        throw new Error(
          `[Sierra] markdownLayouts: '${name}' is both ${here.get(name)} and ` +
          `${relative(root, resolve(abs, e.name))} — one directory cannot hold a layout twice.`
        )
      }
      here.set(name, relative(root, resolve(abs, e.name)))
      layouts[name] = resolve(abs, e.name)
    }
  }
  return layouts
}

/**
 * @param {object} config        — sierra.config.js
 * @param {object} sierraContext — shared context
 * @returns {import('vite').Plugin|null}
 */
export function markdownLayoutsPlugin(config, sierraContext) {
  const dirs = config.markdownLayouts ?? []
  if (dirs.length === 0) return null
  let root = process.cwd()

  return {
    name: 'sierra:markdown-layouts',
    enforce: 'pre',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
    },

    async buildStart() {
      sierraContext.markdownLayouts = await scanMarkdownLayouts(root, dirs)
    },

    // A layout added or removed in dev is seen by the next file compiled. A file
    // already compiled keeps its wrapper until it is edited.
    configureServer(server) {
      const absDirs = dirs.map((d) => resolve(root, d))
      for (const d of absDirs) server.watcher.add(d)
      const rescan = async (file) => {
        if (!absDirs.some((d) => file.startsWith(d))) return
        try {
          sierraContext.markdownLayouts = await scanMarkdownLayouts(root, dirs)
        } catch (err) {
          console.error(err.message)
        }
      }
      server.watcher.on('add', rescan)
      server.watcher.on('unlink', rescan)
    },
  }
}
