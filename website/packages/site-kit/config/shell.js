// config/shell.js — the document a site is served in, owned by site-kit.
//
// Vite wants `<root>/index.html`, and a site's root holds only `content/`. In
// dev an HTML request is answered with the kit's index.html; in the build the
// same file is loaded under the root's index.html id, so it is emitted as
// `dist/index.html`, the file Sierra's prerender reads asset URLs from.
//
// The entry is `/@site-kit/main.js`, resolved here to the kit's src/main.js,
// or to a preset's own entry when it names one with its own document. A
// package name in a script `src` 404s in dev, and an inline module script
// needs Vite's html-proxy, which keys on an index.html that is not on disk.
//
// `virtual:site-kit/styles` is the site's own `content/settings/site.css`,
// imported by the entry after @frontierjs/css. Through the entry it lands in
// the main build's stylesheets, which the prerender copies into every page;
// a site without one gets an empty module.

import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'

const ENTRY  = '/@site-kit/main.js'
const STYLES = 'virtual:site-kit/styles'

/**
 * @param {object} shell
 * @param {string} shell.html — the dev document; its script names `/@site-kit/main.js`
 * @param {string} shell.entry — the file `/@site-kit/main.js` resolves to
 * @returns {import('vite').Plugin}
 */
export function siteShell({ html: file, entry: main }) {
  let html = ''
  let styles = ''

  return {
    name: 'site-kit:shell',
    enforce: 'pre',

    configResolved(config) {
      html = resolve(config.root, 'index.html')
      styles = resolve(config.root, 'content/settings/site.css')
    },

    resolveId(id) {
      if (id === ENTRY) return main
      if (id === html) return html
      if (id === STYLES) return '\0' + STYLES
    },

    load(id) {
      if (id === html) return readFileSync(file, 'utf8')
      if (id === '\0' + STYLES) return existsSync(styles) ? `import ${JSON.stringify(styles)}` : ''
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        const isPage = req.method === 'GET' && req.headers.accept?.includes('text/html')
          && (!extname(path) || path.endsWith('.html'))
        if (!isPage) return next()
        try {
          const page = await server.transformIndexHtml('/index.html', readFileSync(file, 'utf8'), req.originalUrl)
          res.setHeader('Content-Type', 'text/html')
          res.end(page)
        } catch (err) {
          next(err)
        }
      })
    },
  }
}
