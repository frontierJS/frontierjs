/**
 * build/ask-plugin.js — shift+alt-click an element, ask Claude to change it.
 *
 * The panel, the middleware and the `claude -p` session are `@frontierjs/cli`'s
 * (`core/vite-ask.js`); this only turns them on, beside the inspector whose
 * pick they answer, so every Sierra dev server has them rather than each app
 * wiring its own. Sierra does not depend on the cli: it is looked for from the
 * Vite ROOT, which is only known at configResolved, and an app that does not
 * have it gets no panel and no warning — a scaffolded app has it as a dev
 * dependency.
 *
 * Dev only, and off with the inspector (`mesa: { inspect: false }`): a pick is
 * the only way to ask, so a panel without the inspector could never open.
 */

import { createRequire } from 'module'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

const SPECIFIER = '@frontierjs/cli/core/vite-ask.js'

/** Where the app's own cli keeps the plugin, or null when it has none. */
export function findAskModule(root) {
  try { return createRequire(resolve(root, 'package.json')).resolve(SPECIFIER) } catch { return null }
}

export function askPlugin() {
  let inner = null

  return {
    name:  'sierra:ask',
    apply: 'serve',

    async configResolved(config) {
      const mod = findAskModule(config.root)
      if (!mod) return
      try {
        inner = (await import(pathToFileURL(mod).href)).askPlugin()
      } catch (err) {
        config.logger.warn(`[sierra] the ask panel is off — ${SPECIFIER} failed to load: ${err.message}`)
        return
      }
      inner.configResolved?.(config)
    },

    configureServer(server)        { return inner?.configureServer?.(server) },
    resolveId(id)                  { return inner?.resolveId?.(id) ?? null },
    load(id)                       { return inner?.load?.(id) ?? null },
    transformIndexHtml(html, ctx)  { return inner?.transformIndexHtml?.(html, ctx) ?? [] },
  }
}
