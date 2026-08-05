/**
 * @frontierjs/mesa-vite — Vite plugin for Mesa (.mesa and .md) files.
 *
 * Features:
 *   - Transform .mesa and .md files to JavaScript modules
 *   - Scoped CSS extraction via virtual CSS modules
 *   - HMR — hot-reloads components in place, preserving DOM position
 *   - Error overlay — compiler errors and warnings surfaced in the browser
 *
 * Usage:
 *   // vite.config.js
 *   import mesa from '@frontierjs/mesa-vite'
 *
 *   export default {
 *     plugins: [mesa()]
 *   }
 *
 * Options:
 *   extensions  {string[]}  File extensions to process. Default: ['.mesa', '.md']
 *   css         {boolean}   Enable scoped CSS. Default: true
 *   hmr         {boolean}   Enable HMR in dev mode. Default: true
 *   compilerPath {string}   Path to compiler.js. Auto-resolved if omitted.
 */

import path       from 'path'
import fs         from 'fs'
import { pathToFileURL, fileURLToPath } from 'url'

// ─── Constants ────────────────────────────────────────────────────────────────

const VIRTUAL_CSS_SUFFIX      = '?mesa-css'
const VIRTUAL_CLIENT_ID       = '/@frontierjs/mesa-client'
const RESOLVED_CLIENT_ID      = '\0@frontierjs/mesa-client'
const DEVTOOLS_ROUTE          = '/__mesa/devtools'
const VIRTUAL_DEV_CLIENT_ID   = '/@frontierjs/mesa-dev-client'
const RESOLVED_DEV_CLIENT_ID  = '\0@frontierjs/mesa-dev-client'

// ─── Compiler resolution ──────────────────────────────────────────────────────

let _compileSource = null

/**
 * Lazily resolve and import the Mesa compiler.
 * Search order:
 *   1. options.compilerPath (explicit)
 *   2. node_modules/@frontierjs/mesa-compiler/compiler.js
 *   3. node_modules/mesa/compiler.js
 *   4. ./compiler.js (project root, local dev)
 */
async function getCompileSource(options, root) {
  if (_compileSource) return _compileSource

  const candidates = []
  if (options.compilerPath) candidates.push(options.compilerPath)
  candidates.push(
    path.join(root, 'node_modules', '@mesa', 'compiler', 'compiler.js'),
    path.join(root, 'node_modules', 'mesa', 'compiler.js'),
    path.join(root, 'src', 'compiler.js'),   // mesa's own layout since 2026-08-04
    path.join(root, 'compiler.js')
  )

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
    '[Mesa] compiler not found. Add compiler.js to your project root or install @frontierjs/mesa-compiler.'
  )
}

// ─── HMR wrapper injection ────────────────────────────────────────────────────

/**
 * Wrap compiled Mesa JS with HMR boilerplate.
 *
 * The wrapper:
 *   1. Imports __mesa_register and __mesa_hot_update from the virtual client
 *   2. Wraps makeComponent so every mounted instance is registered
 *   3. Declares import.meta.hot.accept() to receive updates and remount
 *
 * The wrapping replaces:
 *   export default $runtime.makeComponent(($option) => { ... })
 * with:
 *   export default __mesa_wrap('id', $runtime.makeComponent(($option) => { ... }))
 *
 * __mesa_wrap intercepts the factory call, creates the instance, inserts
 * an anchor comment node, registers the instance, and hooks into destroy().
 */
function injectHMR(js, id, root) {
  // Normalize to root-relative so the registry key matches between
  // transform() (called with Vite's resolved absolute id) and
  // handleHotUpdate() (called with the absolute file path).
  // Both are absolute — but Vite 8 may differ in trailing slashes or
  // drive letter casing on Windows. Root-relative is the safe canonical form.
  const normalId = root && id.startsWith(root)
    ? id.slice(root.length).replace(/^\//, '/')
    : id
  const escapedId = normalId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const shortName  = id.split('/').pop()

  const clientImport = `import { __mesa_register, __mesa_hot_update } from '${VIRTUAL_CLIENT_ID}';\n`

  // Compiled components have the shape:
  //   export default function Name(__anchor, __props, __block) { ... }
  //   $runtime.$$delegate([...]);  ← optional
  //
  // DOM after mount:
  //   <!--mesa:hmr:Name-->   ← stable hmrMark (before anchor)
  //   ... rendered DOM ...
  //   <!---->                ← __anchor (runtime comment)
  //
  // Hot update: clear between hmrMark and anchor, re-call the new fn.

  // Step 1 — rename export default fn so we can export a wrapper instead
  let result = js.replace(
    /export default function (\w+)\(__anchor,\s*__props,\s*__block\)/,
    () => `function __mesaOrigFn(__anchor, __props, __block)`
  )

  // Step 2 — inject registration after pop_component()
  // Pass hmrMark explicitly so the client doesn't need to search for it.
  result = result.replace(
    /(\.pop_component\(\);)([\s\S]*?\n\})(?=\n\$runtime\.\$\$delegate|\s*$)/,
    (_, pop, rest) => {
      const reg = `
  // ── HMR registration ─────────────────────────────────────────────────────
  if (import.meta.hot) {
    __mesa_register('${escapedId}', __hmrMark, __anchor, __props, __block, __mesaOrigFn)
  }`
      return `${pop}${rest.replace(/^(\n\})/, `${reg}$1`)}`
    }
  )

  // Step 3 — export wrapper (used on initial mount) + __setMark (used on hot update).
  // __hmrMark is module-level so both __mesaHMRWrap and __mesaOrigFn see it.
  // On hot update the client calls __setMark(existingMark) before __mesaOrigFn
  // so registration uses the existing DOM marker instead of creating a new one.
  result += `
let __hmrMark
export function __setMark(mark) { __hmrMark = mark }
export default function __mesaHMRWrap(__anchor, __props, __block) {
  __hmrMark = document.createComment(' mesa:hmr:${shortName} ')
  __anchor.before(__hmrMark)
  __mesaOrigFn(__anchor, __props, __block)
}
`

  // Step 4 — hot.accept: pass __mesaOrigFn (bare fn) to hot_update.
  // The client calls __setMark first to inject the existing hmrMark.
  result += `
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m) {
      __mesaOrigFn.__setMark = m.__setMark
      __mesa_hot_update('${escapedId}', m.__mesaOrigFn ?? m.default)
    }
  })
}
`
  result += `export { __mesaOrigFn }\n`

  return clientImport + result
}


// ─── Error overlay formatting ─────────────────────────────────────────────────

/**
 * Format a Mesa compiler error for Vite's error overlay.
 * Vite expects { message, id, frame? }.
 */
function formatError(e, id) {
  const base = { id, plugin: 'mesa' }

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

  /** Map<cssVirtualId, cssString> */
  const cssCache = new Map()

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

      console.log('[Mesa] configureServer called — registering devtools middleware')

      // Resolve devtools.html path once — fileURLToPath handles Windows drive letters
      const devtoolsHtmlPath = fileURLToPath(new URL('./devtools.html', import.meta.url))
      console.log('[Mesa] devtools.html resolved to:', devtoolsHtmlPath)
      console.log('[Mesa] devtools.html exists:', fs.existsSync(devtoolsHtmlPath))

      // Universal middleware — manual URL check runs before Vite's transform pipeline
      s.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0]
        if (url !== DEVTOOLS_ROUTE && url !== DEVTOOLS_ROUTE + '/') return next()
        console.log('[Mesa] devtools route hit')
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
      // Virtual CSS modules
      if (cssCache.has(id)) return id
      return null
    },

    load(id) {
      // Virtual HMR client — return the client.js content
      if (id === RESOLVED_CLIENT_ID) {
        const clientPath = new URL('./client.js', import.meta.url).pathname
        try {
          return fs.readFileSync(clientPath, 'utf8')
        } catch (_) {
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
      // Virtual CSS modules
      if (cssCache.has(id)) return cssCache.get(id)
      return null
    },

    // ── Transform ─────────────────────────────────────────────────────────────

    async transform(code, id) {
      if (!isMesaFile(id)) return null

      let compileSource
      try {
        compileSource = await getCompileSource(options, root)
      } catch (e) {
        this.warn(e.message)
        return null
      }

      let ctx
      try {
        ctx = await compileSource(code, {
          filename: id,
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

      let js = ctx.result

      // Prepend any compiler warnings as comments
      const warnBlock = buildWarningComment(
        ctx.analysis?.warnings?.filter(Boolean)
      )
      if (warnBlock) js = warnBlock + js

      // CSS — extract into a virtual CSS module
      if (css && ctx.css?.result) {
        const cssId = id + VIRTUAL_CSS_SUFFIX
        cssCache.set(cssId, ctx.css.result)
        js += `\nimport '${cssId}';`
      }

      // HMR — only in dev mode, only for .mesa files (not .md pages, which
      // are typically rendered server-side and don't need client HMR)
      if (isDev && hmr && id.endsWith('.mesa')) {
        js = injectHMR(js, id, root)
      }

      return { code: js, map: null }
    },

    // ── HMR ───────────────────────────────────────────────────────────────────

    async handleHotUpdate({ file, modules, read, server: s }) {
      if (!isMesaFile(file)) return undefined

      // Re-compile on change to catch errors early and show overlay
      let compileSource
      try {
        compileSource = await getCompileSource(options, root)
      } catch (_) {
        return modules
      }

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

      // Invalidate the CSS virtual module too so style changes hot-reload
      const cssVirtualId = file + VIRTUAL_CSS_SUFFIX
      const cssModule    = s?.moduleGraph?.getModuleById(cssVirtualId)
      if (cssModule) s.moduleGraph.invalidateModule(cssModule)

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
