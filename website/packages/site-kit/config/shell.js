// config/shell.js — the document a site is served in, owned by site-kit.
//
// Vite wants `<root>/index.html`, and a site's root holds only `content/`. In
// dev an HTML request is answered with the kit's index.html; in the build the
// same file is loaded under the root's index.html id, so it is emitted as
// `dist/index.html`, the file Sierra's prerender reads asset URLs from.
//
// The entry is `/@site-kit/main.js`, resolved here to the kit's src/main.js. A
// package name in a script `src` 404s in dev, and an inline module script
// needs Vite's html-proxy, which keys on an index.html that is not on disk.

import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

const ENTRY = '/@site-kit/main.js'

/**
 * @param {string} file — the kit's index.html
 * @returns {import('vite').Plugin}
 */
export function siteShell(file) {
  const main = resolve(dirname(file), 'src/main.js')
  let html = ''

  return {
    name: 'site-kit:shell',
    enforce: 'pre',

    configResolved(config) {
      html = resolve(config.root, 'index.html')
    },

    resolveId(id) {
      if (id === ENTRY) return main
      if (id === html) return html
    },

    load(id) {
      if (id === html) return readFileSync(file, 'utf8')
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
