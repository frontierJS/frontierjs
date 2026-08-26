/**
 * devtools-plugin.js — injects the Sierra devtools toolbar in dev mode.
 *
 * Serves a virtual module `/@frontierjs/sierra/devtools-bootstrap` and
 * injects a <script type="module"> tag into the HTML shell via transformIndexHtml.
 * Production builds: no injection, no bundle cost.
 */

const VIRTUAL_ID   = '/@frontierjs/sierra/devtools-bootstrap'

export function devtoolsPlugin(config = {}) {
  const devtools = config.devtools ?? {}

  return {
    name: 'sierra:devtools',
    enforce: 'post',

    apply: 'serve',  // dev server only — never runs during build

    // NOTE: no configureServer middleware.
    //
    // The bootstrap used to be served directly with res.end(), which bypassed
    // Vite's transform pipeline — so the import specifier inside it was never
    // rewritten. The browser then fetched '/@frontierjs/sierra/devtools-module'
    // literally, that fell through to the SPA fallback, and index.html came back
    // as text/html:
    //
    //   Loading module from ".../devtools-module" was blocked because of a
    //   disallowed MIME type ("").
    //
    // resolveId + load below already serve the same module, and going through
    // them means Vite resolves the inner import properly.

    resolveId(id) {
      if (id === '/@frontierjs/sierra/devtools-module' || id === '@frontierjs/sierra/devtools') {
        // Resolve to the real entry point
        return new URL('../devtools/index.js', import.meta.url).pathname
      }
      if (id === VIRTUAL_ID) return id
    },

    load(id) {
      if (id === VIRTUAL_ID) {
        // 8503 is junction's console in the framework's global tooling block
        // (8500-8509, `packages/cli/core/ports.js`). Both sides restate the
        // number — sierra cannot import junction and neither depends on the
        // CLI — so a toolbar pointed at the wrong port is ten failed WebSocket
        // retries the browser writes itself and no page can suppress.
        const port = devtools.port ?? 8503
        const position = devtools.position ?? 'bottom-right'
        const n1 = devtools.n1Threshold ?? 3
        return `
import { initToolbar } from '@frontierjs/sierra/devtools'
if (typeof window !== 'undefined') {
  initToolbar({ port: ${JSON.stringify(port)}, position: ${JSON.stringify(position)}, n1Threshold: ${JSON.stringify(n1)} })
}
`
      }
    },

    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // Only inject in dev mode
        if (!ctx.server) return html

        // Opt in, not opt out. The toolbar's only source of data is junction's
        // `devtools()` plugin on the API, which is itself opt-in — so injecting
        // by default gave every app that had not configured one a toolbar
        // retrying a socket nothing was listening on, ten times, each failure a
        // red line the browser writes itself and no page can suppress. A fresh
        // scaffold read as a broken app.
        //
        // Declaring the block is the opt-in; `enabled: false` still turns it off
        // for an app that has one and wants it quiet.
        if (!config.devtools || devtools.enabled === false) return html

        return html.replace(
          '</body>',
          `<script type="module" src="${VIRTUAL_ID}"></script>\n</body>`
        )
      }
    }
  }
}
