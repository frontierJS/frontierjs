/**
 * mesa-plugin.js — Vite plugin for Mesa component compilation
 *
 * Handles .mesa and .md files:
 * - Transforms them through the Mesa compiler (@frontierjs/mesa/compiler)
 * - Strips frontmatter before compilation, passes to Sierra
 * - Exposes ctx.isStatic, ctx.islands, ctx.frontmatter per file
 * - Emits Sierra-specific warnings (unexported snippets, layout props)
 * - Wires HMR for component-level hot reload
 */

import { parseFrontmatter } from '../scanner/parse-frontmatter.js'
import { warnUnexportedSnippets, extractLayoutProps } from './warnings.js'
import { injectAutoImports } from './auto-import-plugin.js'
import { rewriteMesaSlots, rewriteLayoutSlots } from './slot-rewrite.js'
import { resolve } from 'path'
import { injectHMR, canInject, HMR_CLIENT_ID } from './hmr-inject.js'
import { readFile } from 'fs/promises'

const MESA_EXTENSIONS = /\.(mesa|md)$/

/**
 * @param {object} mesaOptions — passed through to @frontierjs/mesa/compiler
 * @param {object} sierraContext — shared state between plugins
 * @returns {import('vite').Plugin}
 */
/**
 * Pre-process fenced code blocks in Mesa source files.
 * Converts ``` fences into <pre class="code lang">{@html `...`}</pre>
 * so Mesa doesn't parse the code content as template syntax.
 * Only active when the file has frontmatter (YAML --- block).
 */
function _escapeFencedCodeBlocks(src) {
  return src.replace(
    /^```(\w*)\n([\s\S]*?)^```\s*$/gm,
    (_, lang, body) => {
      // Escape for safe embedding inside a JS template literal:
      // backslashes, backticks, and ${ all need to be escaped.
      // Also HTML-encode < and > so Vite's module parser doesn't interpret
      // <script> tags inside the string as real script boundaries.
      const escaped = body
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\{(#|\/|:|@)/g, '&#123;$1')
      const cls = lang ? 'code ' + lang : 'code'
      return '<pre class="' + cls + '">{@html `' + escaped + '`}</pre>'
    }
  )
}

export function mesaPlugin(mesaOptions = {}, sierraContext) {
  // Files that received an import.meta.hot.accept boundary via injectHMR.
  // Mesa's own accept handler owns updates for these, so handleHotUpdate must
  // not also emit sierra:hmr — that would drive a route remount on top of the
  // in-place swap, doing the work twice.
  const _hmrBoundaries = new Set()
  let compiler = null
  let isDev = false
  let root = process.cwd()
  let absRoutesDir = resolve(root, mesaOptions.routesDir ?? 'src/routes')

  return {
    name: 'sierra:mesa',
    enforce: 'pre',

    configResolved(config) {
      isDev = config.command === 'serve'
      root = config.root ?? process.cwd()
      absRoutesDir = resolve(root, mesaOptions.routesDir ?? 'src/routes')
    },

    // Resolve @frontierjs/mesa subpath imports with .js extensions.
    // Mesa's compiler outputs `import * as $runtime from '@frontierjs/mesa/runtime.js'`
    // (with .js suffix). We intercept these and return absolute file paths directly.
    //
    // We can't use this.resolve() with bare specifiers here — it doesn't re-enter
    // node_modules resolution reliably across Vite versions. We also can't return
    // bare package IDs because Rollup treats them as already-resolved and tries to
    // open them as literal file paths.
    //
    // Instead we resolve to the real absolute path. mesaRoot is set in configResolved
    // (same logic as buildStart, runs before any transform). For the initial plugin
    // load phase we fall back to process.cwd().
    resolveId(id) {
      if (id === HMR_CLIENT_ID) return HMR_CLIENT_ID
      const base = root
      if (id === '@frontierjs/mesa/runtime.js' || id === '@frontierjs/mesa/runtime') {
        return resolve(base, 'node_modules/@frontierjs/mesa/runtime.js')
      }
      if (id === '@frontierjs/mesa/compiler.js' || id === '@frontierjs/mesa/compiler') {
        return resolve(base, 'node_modules/@frontierjs/mesa/compiler.js')
      }
    },

    async load(id) {
      if (id !== HMR_CLIENT_ID) return null
      return readFile(new URL('./hmr-client.js', import.meta.url), 'utf8')
    },

    async buildStart() {
      const { pathToFileURL, fileURLToPath } = await import('url')
      const { resolve, dirname } = await import('path')
      const { existsSync } = await import('fs')
      const { createRequire } = await import('module')

      // src/build/mesa-plugin.js → the sierra package root
      const sierraRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

      const tried = []
      const candidates = []

      // The normal case: the app depends on @frontierjs/mesa, hoisted or not.
      try {
        const req = createRequire(resolve(root, 'package.json'))
        candidates.push(req.resolve('@frontierjs/mesa/compiler.js'))
      } catch {
        // Not resolvable from the app root — fall through to the paths below.
      }

      // Everything else is checked on the filesystem rather than through
      // createRequire, because require-resolution CANNOT see this file: mesa's
      // exports map declares `"./compiler.js": { "import": "./compiler.js" }`
      // with no `require` condition. A createRequire().resolve() fallback was
      // therefore dead code, and the last resort guessed a path under the app
      // root — so any layout where mesa is not under the Vite root failed with
      // "check your workspace root node_modules" even though it was installed.
      // (Same trap already documented in build/schema-plugin.js.)
      candidates.push(
        resolve(sierraRoot, 'node_modules/@frontierjs/mesa/compiler.js'),
        resolve(sierraRoot, '..', 'mesa', 'compiler.js'),      // packages/* checkout
        resolve(root, 'node_modules/@frontierjs/mesa/compiler.js'),
      )

      let compilerPath = null
      for (const c of candidates) {
        if (!c) continue
        tried.push(c)
        if (existsSync(c)) { compilerPath = c; break }
      }

      if (!compilerPath) {
        throw new Error(
          `[Sierra] Could not load the @frontierjs/mesa compiler. Tried:\n` +
          tried.map(t => `  ${t}`).join('\n') +
          `\nInstall @frontierjs/mesa in the app, or next to @frontierjs/sierra.`
        )
      }

      try {
        compiler = await import(pathToFileURL(compilerPath).href)
      } catch (err) {
        throw new Error(
          `[Sierra] Found the Mesa compiler at ${compilerPath} but could not ` +
          `import it: ${err.message}`
        )
      }
    },

    async transform(source, id) {
      if (!MESA_EXTENSIONS.test(id)) return null
      if (!compiler) return null
      // Skip .mesa files from node_modules except Sierra's own components.
      // Sierra's RouterView/ChainRenderer need compilation; other packages don't.
      if (id.includes('/node_modules/') && !id.includes('/node_modules/sierra/')) return null

      // Strip frontmatter before passing to Mesa compiler
      const { frontmatter, content: rawContent } = parseFrontmatter(source)

      // Short-circuit: redirect-only routes (frontmatter has `redirect:` and no body)
      // never render — the router intercepts them before the component loads.
      // Emit a minimal no-op component so the build doesn't try to compile empty source.
      if (frontmatter?.redirect && rawContent.trim() === '') {
        return {
          code: `export default function Component() {}`,
          map: null,
        }
      }

      // Pre-process fenced code blocks when frontmatter is present.
      // ``` blocks have their content escaped so Mesa doesn't parse it as template syntax.
      const hasFrontmatter = Object.keys(frontmatter).length > 0
      const processedContent = hasFrontmatter
        ? _escapeFencedCodeBlocks(rawContent)
        : rawContent

      // Rewrite <mesa:slot name="X">…</mesa:slot> to snippet + provideSlot() pattern.
      // This happens before autoImport injection and before compileSource so Mesa
      // only ever sees valid Mesa syntax.
      // For layout files (_module.mesa): rewrite <slot name="X"> and <slot /> 
      // For page files: rewrite <mesa:slot name="X"> to snippet + provideSlot()
      const isLayout = id.includes('_module')
      const slotRewritten = isLayout
        ? rewriteLayoutSlots(processedContent)
        : rewriteMesaSlots(processedContent)

      // Inject auto-imports for any PascalCase components used in this file
      const content = sierraContext?.autoImportMap?.size > 0
        ? injectAutoImports(slotRewritten, sierraContext.autoImportMap)
        : slotRewritten

      try {
        const ctx = await compiler.compileSource(content, {
          filename: id,
          dev: isDev,
          ...mesaOptions,
          // Teach the Mesa compiler which imported names are reactive signals.
          // Names listed here are rewritten in template expressions from `name`
          // to `name.get()` — Mesa's _listener tracking fires when .get() is
          // called inside a reactive context (createEffect / render / memo).
          // Sierra signals (router/signals.js) expose .get() which the runtime
          // bridge below wires to Mesa's reactive graph via subscribe().
          externalSignals: {
            // Support both the scoped package name and the legacy short alias.
            // Projects may install sierra as 'sierra' (file alias) or '@frontierjs/sierra'.
            // NOTE: sierra/router is deliberately absent, as sierra/junction is.
            // Router state is one plain `page` object now, made reactive per
            // component with a `$:` path watch. Nothing for the accessor rewrite
            // to do — and nothing to drift out of sync with.
            '@frontierjs/sierra/theme': ['theme'],
            'sierra/theme': ['theme'],

            // NOTE: sierra/junction is deliberately absent. Its connection state
            // is a plain `status` object now, made reactive per-component with a
            // `$:` path watch — so there is nothing for the accessor rewrite to
            // do. See VISION §5 and PLAIN_OBJECT_STATE.md.
            // User-provided externalSignals (from config.mesa.externalSignals)
            // are merged in last so they can extend or override the above.
            ...(mesaOptions.externalSignals ?? {}),
          },
        })

        if (sierraContext) {
          sierraContext.islandMap.set(id, ctx.islands ?? [])
          sierraContext.staticMap.set(id, ctx.isStatic ?? false)

          // If this is a layout file, extract its export let props
          // so warnDuplicateSnippets can check for conflicts
          if (id.includes('_module')) {
            const props = extractLayoutProps(source)
            sierraContext.layoutPropMap.set(id, props)
          }
        }

        // Forward Mesa compiler warnings (e.g. redundant $: path watches) to Vite
        if (ctx.analysis?.warnings?.length) {
          for (const w of ctx.analysis.warnings) {
            this.warn(`[Mesa] ${w}`)
          }
        }

        // Warning 1: snippets defined in route files but not exported
        if (id.startsWith(absRoutesDir) && !id.includes('_module')) {
          warnUnexportedSnippets(source, id, absRoutesDir, (msg) => this.warn(msg))
        }

        // Declare an HMR boundary in dev so Vite stops escalating every .mesa
        // edit to a full page reload. Skipped for Sierra's own components
        // (RouterView/ChainRenderer are framework internals, not user routes)
        // and whenever the compiled shape doesn't match — better to keep the
        // old reload behaviour than emit broken code.
        const wantsHMR = isDev
          && !id.includes('/node_modules/')
          && canInject(ctx.result)

        if (wantsHMR) _hmrBoundaries.add(id)
        else _hmrBoundaries.delete(id)

        return {
          code: wantsHMR ? injectHMR(ctx.result, id, root) : ctx.result,
          map: wantsHMR ? null : (ctx.map ?? null),
        }
      } catch (err) {
        this.error(`[Sierra] Mesa compilation failed for ${id}:\n${err.message}`)
      }
    },

    configureServer(server) {
      // Receive error reports from the browser and log them to the terminal.
      // This allows coding agents and CLI tooling to see runtime Sierra errors
      // without having to inspect the browser console.
      server.ws.on('sierra:error:client', (data, client) => {
        const reset = '\x1b[0m'
        const red   = '\x1b[31m'
        const dim   = '\x1b[2m'
        const bold  = '\x1b[1m'
        const file  = data.file ? ` ${dim}${data.file}${reset}` : ''
        console.error(
          `\n${red}${bold}[Sierra] ${data.type ?? 'error'}${reset}${file}` +
          `\n${red}${data.message}${reset}`
        )
        if (data.stack) {
          const stackLines = data.stack.split('\n').slice(1, 5).join('\n')
          if (stackLines) console.error(`${dim}${stackLines}${reset}`)
        }
        console.error()
      })
    },

    handleHotUpdate({ file, server, modules }) {
      if (!MESA_EXTENSIONS.test(file)) return

      // If injectHMR gave this file a boundary, Mesa's accept handler performs
      // the update in place. Emitting sierra:hmr as well would make the client
      // re-navigate and remount the route on top of that swap. Let Vite deliver
      // the module update and stay out of the way.
      if (_hmrBoundaries.has(file)) return modules

      // Get the file path relative to the project root for the client
      const root = server.config.root
      const relativePath = file.startsWith(root)
        ? file.slice(root.length + 1)  // strip leading slash
        : file

      // Send sierra:hmr event — client re-navigates instead of full-reloading.
      // Return the affected modules so Vite re-transforms them, but suppress
      // the default full-reload by handling the update ourselves.
      server.ws.send({
        type: 'custom',
        event: 'sierra:hmr',
        data: { file: relativePath },
      })

      // Return the modules so Vite re-evaluates them (makes the new code available
      // for dynamic import), but the client WS handler drives the actual update.
      return modules
    },
  }
}
