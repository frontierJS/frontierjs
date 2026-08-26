// mesa-plugin.js — Vite plugin for Mesa component compilation in jetty.
//
// Adapted from @frontierjs/sierra/build/mesa-plugin.js. Differences from Sierra's:
//   - No Sierra-specific concerns (no slot rewrites, no autoImport, no layout logic,
//     no _module conventions, no scanner integration). Extensions don't have routes.
//   - No HMR ws send (Phase 5 will add jetty's own dev WS).
//   - externalSignals empty by default; users can supply via build config.
//
// Behavior: Mesa compiler is loaded lazily on first transform. If `@frontierjs/mesa`
// isn't installed (likely in this dev sandbox), the plugin falls through to the
// previous stub behavior (read .mesa file as JS) with a one-time warning. This lets
// fixtures keep working while Mesa-linked development uses real compilation.

import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Stands in for Mesa's DOM swap when Mesa is not installed. Resolved as a path
// rather than imported: this module runs in Node and the file it hands back is
// for the BROWSER bundle.
const SWAP_FALLBACK = resolve(dirname(fileURLToPath(import.meta.url)), '../dev/mesa-swap-fallback.js')

const MESA_EXTENSIONS = /\.(mesa|md)$/

/** `dir` and every directory above it, nearest first. `null` answers nothing. */
function ancestors(dir) {
  if (!dir) return []
  const out = []
  let cur = resolve(dir)
  for (;;) {
    out.push(cur)
    const up = dirname(cur)
    if (up === cur) return out
    cur = up
  }
}

export function mesaPlugin(options = {}) {
  const {
    extRoot          = null,    // explicit extension root (where node_modules/@frontierjs/mesa lives)
    mesaCompilerPath = null,    // explicit override (absolute path to Mesa compiler.js)
    mesaPackageRoot  = null,    // explicit override (absolute path to @frontierjs/mesa root)
    externalSignals  = {},      // forwarded to Mesa compiler
    dev              = undefined, // optional override; default = derived from Vite mode
    onCompilerWarning,          // optional hook: (msg, file) => void
  } = options

  let compiler   = null
  let isDev      = false
  let viteRoot   = process.cwd()
  let resolvedCompilerPath = null
  let resolvedRuntimePath  = null
  let resolvedSwapPath     = null
  let stubWarned   = false

  return {
    name: 'jetty:mesa',
    enforce: 'pre',

    configResolved(viteConfig) {
      isDev    = dev !== undefined ? dev : (viteConfig.command === 'serve')
      viteRoot = viteConfig.root ?? process.cwd()
    },

    // Mesa's compiled output emits: `import * as $runtime from '@frontierjs/mesa/runtime.js'`
    // We need that resolvable from the Vite project's node_modules. If Mesa isn't installed,
    // these returns are skipped and Vite resolves via normal node resolution (which fails
    // gracefully if Mesa truly isn't there).
    resolveId(id) {
      // The dev client imports Mesa's DOM swap by name (`FJS-259`). It must
      // resolve even in stub mode, where the specifier is unresolvable and the
      // failure would be a dev build that dies on a feature it is not using.
      if (id === '@frontierjs/mesa/vite/swap' || id === '@frontierjs/mesa/vite/swap.js') {
        return resolvedSwapPath ?? SWAP_FALLBACK
      }
      if (!resolvedRuntimePath) return null
      if (id === '@frontierjs/mesa/runtime.js' || id === '@frontierjs/mesa/runtime') {
        return resolvedRuntimePath
      }
    },

    async buildStart() {
      // Try to locate and load Mesa's compiler. Search order:
      //   1. Explicit mesaCompilerPath option
      //   2. Explicit mesaPackageRoot/compiler.js
      //   3. <extRoot>/node_modules/@frontierjs/mesa/…      (the consumer extension's node_modules)
      //   4. <viteRoot>/node_modules/@frontierjs/mesa/…      (fallback when extRoot not provided)
      //
      // Mesa's source moved under `src/` (2026-08-04), so each package-root
      // guess is tried as `src/compiler.js` first and flat second — a
      // node_modules copy taken before the move is still flat, and `bun
      // install` copies a workspace dep rather than symlinking it.
      const candidates = []
      if (mesaCompilerPath) candidates.push(mesaCompilerPath)
      // **Both roots are WALKED UP, not probed once.** `extension/` is a
      // sub-project of an app that has one package.json at its root, the way
      // `web/` and `widgets/` are — so the install lives at `<app>/node_modules`
      // and a guess at `<extRoot>/node_modules` finds nothing. Stub mode then
      // hands Vite a `.mesa` as plain JS and the build fails with a parse error
      // pointing at the component, which is the one place the problem is not.
      for (const rel of ['src/compiler.js', 'compiler.js']) {
        if (mesaPackageRoot) candidates.push(resolve(mesaPackageRoot, rel))
        for (const dir of [...ancestors(extRoot), ...ancestors(viteRoot)]) {
          candidates.push(resolve(dir, 'node_modules/@frontierjs/mesa', rel))
        }
      }

      for (const p of candidates) {
        if (existsSync(p)) {
          try {
            compiler = await import(pathToFileURL(p).href)
            resolvedCompilerPath = p
            // Runtime is sibling of compiler: same dir, runtime.js
            const runtimeP = p.replace(/compiler\.js$/, 'runtime.js')
            if (existsSync(runtimeP)) resolvedRuntimePath = runtimeP
            // The swap lives beside the Vite plugin, not beside the compiler —
            // one level up when the compiler is under `src/`, the same
            // directory when it is a pre-2026-08-04 flat copy.
            for (const swapP of [
              resolve(dirname(p), '..', 'mesa-vite', 'swap.js'),
              resolve(dirname(p), 'mesa-vite', 'swap.js'),
            ]) {
              if (existsSync(swapP)) { resolvedSwapPath = swapP; break }
            }
            break
          } catch (e) {
            // Try next candidate
          }
        }
      }

      // No compiler found = stub mode. Fixtures still work; real Mesa apps don't.
      if (!compiler && !stubWarned) {
        console.warn(
          '[jetty:mesa] @frontierjs/mesa compiler not found — falling back to stub mode ' +
          '(.mesa files loaded as plain JS). Install @frontierjs/mesa to enable real compilation.'
        )
        stubWarned = true
      }
    },

    async transform(source, id) {
      if (!MESA_EXTENSIONS.test(id))                                  return null
      if (id.includes('/node_modules/'))                              return null  // never compile vendor .mesa files

      // Stub mode: pass the file through as JS. It keeps a fixture whose
      // `.mesa` files ARE JavaScript building without Mesa installed.
      //
      // Said again HERE, naming the file, because the boot warning scrolls past
      // and what follows it is a parse error inside the component — a
      // `<script>` reported as "Unexpected JSX expression", which sends every
      // first diagnosis to the component and none to the missing compiler.
      if (!compiler) {
        this.warn(
          `[jetty:mesa] ${id} is being loaded as plain JavaScript — no Mesa compiler was found. ` +
          `A parse error below is this, not the component. Install @frontierjs/mesa in the app ` +
          `that owns this surface.`
        )
        return null
      }

      try {
        const ctx = await compiler.compileSource(source, {
          filename: id,
          dev: isDev,
          // The inspector's attribute is stamped for a client to read, and this
          // surface serves none: an extension page is not the app's dev server.
          loc: false,
          externalSignals,
        })

        // Forward Mesa compiler warnings to Vite + optional hook
        if (ctx.analysis?.warnings?.length) {
          for (const w of ctx.analysis.warnings) {
            this.warn(`[Mesa] ${w}`)
            if (typeof onCompilerWarning === 'function') {
              try { onCompilerWarning(w, id) } catch {}
            }
          }
        }

        // In dev mode, inject jetty HMR wrapping into compiled .mesa output.
        // The wrapping makes each component instance register itself in a
        // global registry on mount, and exposes the bare component fn so
        // hot-update can swap it in place. No Vite import.meta.hot — jetty's
        // own dev WS triggers the swap (see dev-client.js).
        // Use extRoot (user's project root) as the id base when available so
        // ids are stable + match server-side relative paths (e.g.
        // 'src/dock/App.mesa'). Fall back to viteRoot otherwise.
        const idBase = extRoot ?? viteRoot
        const code = isDev ? injectJettyHMR(ctx.result, id, idBase) : ctx.result

        return {
          code,
          map:  ctx.map ?? null,
        }
      } catch (err) {
        this.error(`[jetty:mesa] compilation failed for ${id}:\n${err.message}`)
      }
    },
  }
}

// ─── HMR wrapping ─────────────────────────────────────────────────────────────

/**
 * Wrap Mesa's compiled output so each mounted instance registers itself
 * with a global registry and the original component fn is reachable as a
 * named export. Called only when `dev: true`.
 *
 * Adapted from @frontierjs/mesa-vite/index.js — same wrapping strategy,
 * but jetty's own dev-client triggers the swap (no import.meta.hot bridge).
 *
 * Compiled component shape:
 *   export default function Name(__anchor, __props, __block) { ... $$runtime.pop_component(); }
 *   $$runtime.$$delegate([...]);  // optional
 *
 * After wrapping:
 *   - export default = thin wrapper that creates an hmrMark comment node
 *     before each mount, calls __mesaOrigFn(anchor, props, block)
 *   - export { __mesaOrigFn, __setMark } — used by HMR re-imports
 *   - inside __mesaOrigFn, after pop_component, register the instance with
 *     globalThis.__jettyMesa.register(id, hmrMark, anchor, props, block, fn)
 *
 * @param {string} js — compiled Mesa output
 * @param {string} id — absolute path of the .mesa file
 * @param {string} root — Vite root (used to normalize id to a stable key)
 */
export function injectJettyHMR(js, id, root) {
  // Stable HMR key — posix-relative path so server (classifier emits 'src/...')
  // and client agree on the same id. Strip leading slash so id matches the
  // event's `file` field exactly.
  const normalId = root && id.startsWith(root)
    ? id.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '')
    : id.replace(/\\/g, '/')
  const escapedId = normalId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const shortName = id.split(/[\\/]/).pop()

  // Step 1 — rename `export default function Name(__anchor, __props, __block)`
  // so we can swap in our own default export wrapper. The original fn is
  // preserved as __mesaOrigFn (also exported by name for the HMR re-import).
  let result = js.replace(
    /export default function (\w+)\(__anchor,\s*__props,\s*__block\)/,
    () => `function __mesaOrigFn(__anchor, __props, __block)`
  )

  // Step 2 — register the mounted instance after pop_component(). We match
  // the LAST pop_component() inside __mesaOrigFn so {#each}-spawned nested
  // calls aren't accidentally hooked. The pattern looks for pop_component()
  // immediately before the function's closing brace (preceded by optional
  // whitespace + closing of any inner blocks).
  //
  // The trailing delegate call is matched by SHAPE rather than by the runtime
  // namespace's name: this lookahead read `$runtime.$$delegate` and mesa's
  // `FJS-470` renamed every emitted identifier to `$$`, so from that day every
  // component carrying a delegated event — which is nearly all of them — got
  // no registration and simply stopped hot-updating, with the build green and
  // nothing said (`FJS-481`).
  result = result.replace(
    /(\.pop_component\(\);)([\s\S]*?\n\})(?=\n\$+runtime\.\$\$delegate|\s*$)/,
    (_, pop, rest) => {
      const reg = `
  // ── Jetty HMR registration ────────────────────────────────────────────
  if (typeof globalThis !== 'undefined' && globalThis.__jettyMesa) {
    globalThis.__jettyMesa.register('${escapedId}', __hmrMark, __anchor, __props, __block, __mesaOrigFn)
  }`
      return `${pop}${rest.replace(/^(\n\})/, `${reg}$1`)}`
    }
  )

  // Both steps must land or the module is worse than unwrapped: it exports a
  // wrapper that mounts fine and never registers, so HMR silently does nothing
  // for that component and the only symptom is an edit that does not appear.
  // Mesa's output shape is a thing jetty reads rather than owns, so the failure
  // to recognise it is reported at BUILD time instead of at someone's desk.
  if (!result.includes('__jettyMesa.register(')) {
    throw new Error(
      `[jetty] could not inject HMR registration into ${shortName} — the compiled Mesa ` +
      `shape this plugin matches has moved. Expected 'pop_component();' before the ` +
      `component function's closing brace. Fix the pattern in mesa-plugin.js rather ` +
      `than shipping a component that cannot hot-update.`
    )
  }

  // Step 3 — module-level hmrMark + the wrapper that becomes the default
  // export. On initial mount, we synthesize the mark comment and pass it
  // forward. On hot update, the new module's __setMark(existing) runs first
  // so registration uses the existing DOM marker.
  result += `
let __hmrMark
export function __setMark(mark) { __hmrMark = mark }
export default function __mesaJettyHMRWrap(__anchor, __props, __block) {
  __hmrMark = document.createComment(' mesa:hmr:${shortName} ')
  __anchor.before(__hmrMark)
  __mesaOrigFn(__anchor, __props, __block)
}
export { __mesaOrigFn }
`

  return result
}
