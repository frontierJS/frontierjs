/**
 * @frontierjs/mesa/vite — Vite plugin for Mesa (.mesa and .md) files.
 *
 * Ships inside @frontierjs/mesa rather than beside it. A plugin whose whole job
 * is to call the compiler cannot be versioned apart from it, and as its own
 * package it could not even find it: the resolver hunted `@mesa/compiler` and
 * `node_modules/mesa/` — one a name that was never published, the other an
 * unrelated package that really exists on npm.
 *
 * Features:
 *   - Transform .mesa and .md files to JavaScript modules
 *   - Scoped CSS, inlined into the module as $runtime.addStyles(id, css)
 *   - HMR — hot-reloads components in place, preserving DOM position
 *   - Error overlay — compiler errors and warnings surfaced in the browser
 *
 * Usage:
 *   // vite.config.js
 *   import mesa from '@frontierjs/mesa/vite'
 *
 *   export default {
 *     plugins: [mesa()]
 *   }
 *
 * Options:
 *   extensions  {string[]}  File extensions to process. Default: ['.mesa', '.md']
 *   css         {boolean}   Emit a component's <style> block. Default: true.
 *                           `false` DROPS it — the module renders unstyled.
 *   hmr         {boolean}   Enable HMR in dev mode. Default: true
 *   compilerPath {string}   Path to compiler.js. Auto-resolved if omitted.
 */

import path       from 'path'
import fs         from 'fs'
import { pathToFileURL, fileURLToPath } from 'url'

import { injectHMR, canInject } from './hmr.js'
import { hmrClientSource } from './client-source.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const VIRTUAL_CLIENT_ID       = '/@frontierjs/mesa-client'
const RESOLVED_CLIENT_ID      = '\0@frontierjs/mesa-client'
const DEVTOOLS_ROUTE          = '/__mesa/devtools'
const VIRTUAL_DEV_CLIENT_ID   = '/@frontierjs/mesa-dev-client'
const RESOLVED_DEV_CLIENT_ID  = '\0@frontierjs/mesa-dev-client'

// ─── Compiler resolution ──────────────────────────────────────────────────────

let _compileSource = null

/**
 * Lazily resolve and import the Mesa compiler.
 *
 * The compiler is a sibling — this plugin ships inside @frontierjs/mesa — so
 * the answer is a relative path and there is nothing to hunt for. It is
 * resolved lazily so that importing the plugin does not pull ~290 KB of
 * compiler into a config file that may never transform anything.
 *
 * A relative path is also what an in-repo consumer needs: `bun install`
 * resolves workspace deps to a COPY under node_modules/.bun/, so reaching the
 * compiler by package name would serve a stale snapshot of it.
 *
 * `options.compilerPath` still wins, for a consumer testing a compiler build
 * that is not this one.
 */
async function getCompileSource(options) {
  if (_compileSource) return _compileSource

  const sibling    = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'compiler.js')
  const candidates = options.compilerPath ? [options.compilerPath, sibling] : [sibling]

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const mod = await import(pathToFileURL(c).href)
      if (typeof mod.compileSource === 'function') {
        _compileSource = mod.compileSource
        return _compileSource
      }
    }
  }

  throw new Error(
    `[Mesa] compiler not found at ${candidates.join(' or ')}. ` +
    `This plugin ships inside @frontierjs/mesa — a missing sibling means a broken install.`
  )
}

// ─── HMR wrapper injection ────────────────────────────────────────────────────
//
// `injectHMR` and `canInject` live in ./hmr.js and are exported as
// `@frontierjs/mesa/vite/hmr`, because Sierra's plugin needs the boundary
// without needing this plugin: it reimplements the plugin (frontmatter, the
// fence preprocessor, slot rewriting, auto-imports) and had copied the
// boundary along with it (`FJS-D16`). The client id is a parameter, since each
// plugin serves the HMR client at a virtual id of its own.


// ─── Error overlay formatting ─────────────────────────────────────────────────

/**
 * Format a Mesa compiler error for Vite's error overlay.
 * Vite expects { message, id, frame? }.
 */
function formatError(e, id) {
  // `stack` is not optional to the consumer. Vite's overlay renders it with
  // file linking, which runs a regex over the string — an absent one throws
  // inside the overlay's own constructor, so the overlay never appears and a
  // parse failure is reported to the developer as nothing whatsoever: the page
  // keeps the previous content and the terminal stays quiet.
  const base = { id, plugin: 'mesa', stack: e.stack ?? '' }

  if (e.details) {
    // Mesa parse error with source context
    return {
      ...base,
      message: e.message ?? 'Mesa compile error',
      frame:   e.details.slice(0, 500)
    }
  }

  return {
    ...base,
    message: e.message ?? String(e)
  }
}

/**
 * Build a warning comment block to inject into compiled output so warnings
 * appear in the terminal even in production builds.
 */
function buildWarningComment(warnings) {
  if (!warnings?.length) return ''
  return warnings
    .map((w) => `// ⚠ Mesa: ${w.replace(/\n/g, ' ')}`)
    .join('\n') + '\n'
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default function mesaPlugin(options = {}) {
  const {
    extensions  = ['.mesa', '.md'],
    css         = true,
    hmr         = true,
  } = options

  /** Vite server instance (set in configureServer) */
  let server = null

  /** Root directory (set in configResolved) */
  let root = process.cwd()

  /** True when Vite is in dev/serve mode */
  let isDev = false

  const isMesaFile = (id) => extensions.some((e) => id.endsWith(e))

  return {
    name: 'mesa',
    enforce: 'pre',

    // ── Config hooks ──────────────────────────────────────────────────────────

    configResolved(config) {
      root   = config.root
      isDev  = config.command === 'serve'
    },

    configureServer(s) {
      server = s

      // Resolve devtools.html path once — fileURLToPath handles Windows drive letters
      const devtoolsHtmlPath = fileURLToPath(new URL('./devtools.html', import.meta.url))

      // Universal middleware — manual URL check runs before Vite's transform pipeline
      s.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url !== DEVTOOLS_ROUTE && url !== DEVTOOLS_ROUTE + '/') return next()
        try {
          const html = fs.readFileSync(devtoolsHtmlPath, 'utf8')
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(html)
        } catch (err) {
          console.error('[Mesa] Could not read devtools.html:', err.message)
          res.statusCode = 500
          res.end(`[Mesa] devtools.html not found.\nLooked at: ${devtoolsHtmlPath}`)
        }
      })

      // Return a post-hook — Vite calls this after its own internal middleware
      // is installed. We use it to print the devtools URL once the server is up.
      return () => {
        const printUrl = () => {
          try {
            // resolvedUrls is set by Vite after the server starts listening
            const base = s.resolvedUrls?.local?.[0] ?? s.resolvedUrls?.network?.[0]
            if (base) {
              const url = base.replace(/\/$/, '') + DEVTOOLS_ROUTE
              s.config.logger.info(
                `  \x1b[36m➜\x1b[0m  \x1b[1mMesa DevTools\x1b[0m: \x1b[32m${url}\x1b[0m`,
                { clear: false }
              )
            } else {
              // resolvedUrls not ready yet — derive from httpServer address
              const addr = s.httpServer?.address()
              if (addr && typeof addr === 'object') {
                const host = addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address
                s.config.logger.info(
                  `  \x1b[36m➜\x1b[0m  \x1b[1mMesa DevTools\x1b[0m: \x1b[32mhttp://${host}:${addr.port}${DEVTOOLS_ROUTE}\x1b[0m`,
                  { clear: false }
                )
              }
            }
          } catch (err) {
            console.error('[Mesa] Could not print devtools URL:', err.message)
          }
        }

        if (s.httpServer) {
          s.httpServer.once('listening', printUrl)
        } else {
          // httpServer already listening (e.g. middleware mode) — print immediately
          printUrl()
        }
      }
    },

    // Inject the dev client script into every HTML page in dev mode.
    // The client sets up the BroadcastChannel relay to the devtools page.
    transformIndexHtml() {
      if (!isDev) return []
      return [{
        tag:      'script',
        attrs:    { type: 'module', src: VIRTUAL_DEV_CLIENT_ID },
        injectTo: 'head',
      }]
    },

    // ── Virtual module resolution ─────────────────────────────────────────────

    resolveId(id) {
      // Virtual HMR client
      if (id === VIRTUAL_CLIENT_ID) return RESOLVED_CLIENT_ID
      // Virtual dev client (BroadcastChannel relay)
      if (id === VIRTUAL_DEV_CLIENT_ID) return RESOLVED_DEV_CLIENT_ID
      return null
    },

    load(id) {
      // Virtual HMR client. Assembled rather than read: the client is two files
      // and a virtual id resolves no relative import, so `client-source.js` is
      // the one owner of that join — Sierra serves the same client at its own
      // id (`FJS-D16`).
      if (id === RESOLVED_CLIENT_ID) {
        try {
          return hmrClientSource()
        } catch (err) {
          // A no-op client keeps the build alive and puts every component on
          // the full-reload path, which is survivable. Being quiet about it is
          // not: the symptom is an edit that appears to do nothing.
          this.warn(`[mesa] HMR client unavailable — components will full-reload. ${err.message}`)
          return `
export function __mesa_register() { return () => {} }
export function __mesa_hot_update() {}
`
        }
      }
      // Virtual dev client — BroadcastChannel relay between app and devtools page
      if (id === RESOLVED_DEV_CLIENT_ID) {
        return `
// Mesa dev client — injected in dev mode by @frontierjs/mesa-vite
// Relays __dev events to the devtools page via BroadcastChannel.
(function() {
  if (typeof window === 'undefined') return
  const bc = new BroadcastChannel('mesa-devtools')

  function attach(dev) {
    bc.onmessage = (e) => {
      if (e.data?.type === 'request-snapshot') {
        bc.postMessage({ type: 'snapshot', data: dev.snapshot() })
      }
    }
    dev.subscribe((event) => bc.postMessage(event))
    // Announce that the app is online (devtools may already be open)
    bc.postMessage({ type: 'online' })
  }

  // __dev is set on window by the runtime when it first loads
  if (window.__MESA_DEV__) {
    attach(window.__MESA_DEV__)
  } else {
    // Runtime loads asynchronously — wait for it
    Object.defineProperty(window, '__MESA_DEV__', {
      configurable: true,
      set(dev) {
        Object.defineProperty(window, '__MESA_DEV__', { value: dev, writable: true })
        attach(dev)
      }
    })
  }
})()
`
      }
      return null
    },

    // ── Transform ─────────────────────────────────────────────────────────────

    async transform(code, id) {
      if (!isMesaFile(id)) return null

      let compileSource
      try {
        compileSource = await getCompileSource(options)
      } catch (e) {
        this.warn(e.message)
        return null
      }

      let ctx
      try {
        ctx = await compileSource(code, {
          filename: id,
          // The compiler's `css` is not a switch, it is a DESTINATION: truthy
          // inlines the scoped rules as `$runtime.addStyles(id, …)`, falsy
          // extracts them onto `ctx.css.result` for the caller to place. This
          // plugin inlines, which is what Sierra's does too — the ids are
          // content-addressed, so a prerendered page and the client agree about
          // which styles are already on the page (Invariant 12).
          css,
          dev: isDev,
          warning: (w) => this.warn(
            typeof w === 'string' ? w : (w.message ?? String(w))
          )
        })
      } catch (e) {
        const formatted = formatError(e, id)
        if (isDev) {
          // In dev: emit as a module that throws so the error overlay fires
          const msg = (formatted.message ?? 'Mesa compile error')
            .replace(/\\/g, '\\\\').replace(/`/g, '\\`')
          const frame = (formatted.frame ?? '')
            .replace(/\\/g, '\\\\').replace(/`/g, '\\`')
          return {
            code: `throw new Error(\`[Mesa] ${msg}\\n${frame}\`)`,
            map:  null
          }
        }
        // In build: fail the build
        this.error(formatted)
        return null
      }

      // Compiler ERRORS fail the transform, the same way Sierra's plugin fails
      // it. The compiler collects into `analysis.errors` and does not throw —
      // only the `catch` above sees a parse throw — so a plugin reading
      // `warnings` alone serves a half-compiled module for every diagnostic the
      // compiler DID catch: a `bind:` on a non-`let`, an inert `$: { }`. The
      // page renders, looks right, and does not write anything back.
      if (ctx.analysis?.errors?.length) {
        const rel = id.replace(root + '/', '')
        const detail = ctx.analysis.errors.map((e) => `  • ${e}`).join('\n')
        const message =
          `[Mesa] ${ctx.analysis.errors.length} error(s) in ${rel}:\n${detail}`
        if (isDev) {
          const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
          return { code: `throw new Error(\`${esc(message)}\`)`, map: null }
        }
        this.error({ id, plugin: 'mesa', message })
        return null
      }

      let js = ctx.result

      // Prepend any compiler warnings as comments
      const warnBlock = buildWarningComment(
        ctx.analysis?.warnings?.filter(Boolean)
      )
      if (warnBlock) js = warnBlock + js

      // HMR — only in dev mode, only for .mesa files (not .md pages, which
      // are typically rendered server-side and don't need client HMR).
      //
      // `canInject` is asked rather than assumed: the two patterns the wrap
      // depends on are shapes of the compiler's OUTPUT, and a `.replace()` whose
      // pattern stops matching is silent. Failing closed here keeps the file on
      // the old full-reload path instead of shipping half a boundary.
      if (isDev && hmr && id.endsWith('.mesa') && canInject(js)) {
        js = injectHMR(js, id, root, VIRTUAL_CLIENT_ID)
      }

      return { code: js, map: null }
    },

    // ── HMR ───────────────────────────────────────────────────────────────────

    async handleHotUpdate({ file, modules, read, server: s }) {
      if (!isMesaFile(file)) return undefined

      // Re-compile on change to catch errors early and show overlay
      let compileSource
      try {
        compileSource = await getCompileSource(options)
      } catch (_) {
        return modules
      }

      // A throwaway compile, for the throw alone — the module Vite asks for
      // afterwards is built by transform(). `css: false` keeps the scoped rules
      // out of output nobody reads.
      const source = await read()
      try {
        await compileSource(source, { filename: file, css: false })
      } catch (e) {
        // Send error to browser overlay — use server.hot in Vite 8, ws as fallback
        const hot = s?.hot ?? s?.ws
        hot?.send({ type: 'error', err: formatError(e, file) })
        return []   // suppress default HMR behaviour
      }

      // Explicitly invalidate every affected module so Vite 8 re-runs
      // transform() and the browser gets fresh compiled output.
      // Without this, Vite 8 may serve a stale cached transform result.
      const timestamp = Date.now()
      for (const mod of modules) {
        s?.moduleGraph?.invalidateModule(mod, undefined, timestamp, true)
      }

      // A style edit needs nothing more: the rules are inlined into the module
      // being invalidated above, and `addStyles` keys on a content hash, so the
      // edited block arrives under an id the page has not seen.
      //
      // Return modules — Vite will send the HMR update to the browser,
      // which triggers import.meta.hot.accept() in the compiled component
      return modules
    }
  }
}

// ── mesaDevtools() — standalone plugin ────────────────────────────────────────
//
// Sierra's Vite plugin calls mesa-vite's transform() internally but doesn't
// forward server lifecycle hooks (configureServer, transformIndexHtml) to Vite.
// Add this plugin separately in vite.config.js to get the devtools endpoint
// and the BroadcastChannel client injection:
//
//   import sierra from '@frontierjs/sierra'
//   import { mesaDevtools } from '@frontierjs/mesa-vite'
//
//   export default { plugins: [sierra(), mesaDevtools()] }
//
export function mesaDevtools() {
  const devtoolsHtmlPath = fileURLToPath(new URL('./devtools.html', import.meta.url))

  return {
    name:    'mesa-devtools',
    enforce: 'pre',

    // Resolve + load the BroadcastChannel relay virtual module
    resolveId(id) {
      if (id === VIRTUAL_DEV_CLIENT_ID) return RESOLVED_DEV_CLIENT_ID
    },

    load(id) {
      if (id !== RESOLVED_DEV_CLIENT_ID) return null
      return `
(function() {
  if (typeof window === 'undefined') return
  const bc = new BroadcastChannel('mesa-devtools')
  function attach(dev) {
    bc.onmessage = (e) => {
      if (e.data?.type === 'request-snapshot') bc.postMessage({ type: 'snapshot', data: dev.snapshot() })
    }
    dev.subscribe((event) => bc.postMessage(event))
    bc.postMessage({ type: 'online' })
  }
  if (window.__MESA_DEV__) {
    attach(window.__MESA_DEV__)
  } else {
    Object.defineProperty(window, '__MESA_DEV__', {
      configurable: true,
      set(dev) {
        Object.defineProperty(window, '__MESA_DEV__', { value: dev, writable: true })
        attach(dev)
      }
    })
  }
})()
`
    },

    // Inject the dev client into every HTML page
    transformIndexHtml() {
      return [{
        tag:      'script',
        attrs:    { type: 'module', src: VIRTUAL_DEV_CLIENT_ID },
        injectTo: 'head',
      }]
    },

    configureServer(s) {
      // Middleware — intercepts /__mesa/devtools before Vite's pipeline
      s.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url !== DEVTOOLS_ROUTE && url !== DEVTOOLS_ROUTE + '/') return next()
        try {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(fs.readFileSync(devtoolsHtmlPath, 'utf8'))
        } catch (err) {
          res.statusCode = 500
          res.end(`[Mesa] devtools.html not found at: ${devtoolsHtmlPath}\n${err.message}`)
        }
      })

      // Post-hook — print URL after server is listening
      return () => {
        const print = () => {
          try {
            const base = s.resolvedUrls?.local?.[0] ?? s.resolvedUrls?.network?.[0]
            const url  = base
              ? base.replace(/\/$/, '') + DEVTOOLS_ROUTE
              : (() => {
                  const addr = s.httpServer?.address()
                  if (!addr || typeof addr !== 'object') return null
                  const host = addr.address === '::' || addr.address === '0.0.0.0' ? 'localhost' : addr.address
                  return `http://${host}:${addr.port}${DEVTOOLS_ROUTE}`
                })()
            if (url) {
              s.config.logger.info(
                `  \x1b[36m➜\x1b[0m  \x1b[1mMesa DevTools\x1b[0m: \x1b[32m${url}\x1b[0m`,
                { clear: false }
              )
            }
          } catch { /* non-fatal */ }
        }

        if (s.httpServer) s.httpServer.once('listening', print)
        else print()
      }
    },
  }
}
