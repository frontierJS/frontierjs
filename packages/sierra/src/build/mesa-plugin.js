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
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { injectHMR, canInject, HMR_CLIENT_ID } from './hmr-inject.js'
import { readFile } from 'fs/promises'

const MESA_EXTENSIONS = /\.(mesa|md)$/

// src/build/mesa-plugin.js → the sierra package root
const SIERRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The package name as it appears under node_modules. Named rather than inlined
// because the literal drifted to 'sierra' once and no suite in this repo could
// see it — an app here resolves sierra to packages/sierra/, never to a
// node_modules path (FJS-251).
const SIERRA_PKG = '@frontierjs/sierra'

/**
 * Locate a file in the installed @frontierjs/mesa, wherever it is.
 *
 * The candidate order is deliberate and shared with `buildStart`: the app's own
 * dependency first, then Sierra's, then a `packages/*` checkout, then the app
 * root as the last guess. Anything that returns a path WITHOUT checking it
 * exists turns a resolvable install into a rollup "could not load" error.
 *
 * Existence is checked on the filesystem rather than through createRequire,
 * because require-resolution cannot see these files at all: mesa's exports map
 * declares `"./runtime.js": { "import": … }` with no `require` condition.
 *
 * @returns {string|undefined} absolute path, or undefined to let Vite try
 */
export function findMesaFile(file, root) {
  const candidates = []
  try {
    const req = createRequire(resolve(root, 'package.json'))
    candidates.push(req.resolve(`@frontierjs/mesa/${file}`))
  } catch { /* not resolvable from the app root — the paths below still might */ }

  // Mesa's source moved under `src/` (2026-08-04). Its exports map hides that
  // from `@frontierjs/mesa/runtime.js`, but these are filesystem paths, so they
  // have to name it. The flat variants stay as a fallback: `bun install` copies
  // a `workspace:*` dep rather than symlinking it, so a node_modules copy taken
  // before the move is still flat until someone reinstalls.
  for (const rel of [`src/${file}`, file]) {
    candidates.push(
      resolve(SIERRA_ROOT, 'node_modules/@frontierjs/mesa', rel),
      resolve(SIERRA_ROOT, '..', 'mesa', rel),          // packages/* checkout
      resolve(root, 'node_modules/@frontierjs/mesa', rel),
    )
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  // Undefined rather than a guess: Vite's own resolver gets a turn, and if it
  // also fails the error names the specifier instead of a path we invented.
  return undefined
}

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
      // Every compiled .mesa module imports the runtime, so this is the single
      // resolution every Mesa build depends on.
      //
      // It used to return `resolve(root, 'node_modules/@frontierjs/mesa/…')`
      // unconditionally — the exact trap `buildStart` below documents and
      // guards against, applied to the compiler and never to the runtime. It
      // returns a path whether or not anything is there, so rollup fails with
      // "Could not load <root>/node_modules/@frontierjs/mesa/runtime.js" for
      // any layout where mesa is installed somewhere else: a workspace where it
      // is hoisted, or an app nested under the package that depends on it. It
      // survived because the apps exercised so far each happened to have their
      // own node_modules/@frontierjs.
      if (id === '@frontierjs/mesa/runtime.js' || id === '@frontierjs/mesa/runtime') {
        return findMesaFile('runtime.js', root)
      }
      if (id === '@frontierjs/mesa/compiler.js' || id === '@frontierjs/mesa/compiler') {
        return findMesaFile('compiler.js', root)
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
      // src/ first, flat second — see the note in findMesaFile above.
      for (const rel of ['src/compiler.js', 'compiler.js']) {
        candidates.push(
          resolve(sierraRoot, 'node_modules/@frontierjs/mesa', rel),
          resolve(sierraRoot, '..', 'mesa', rel),      // packages/* checkout
          resolve(root, 'node_modules/@frontierjs/mesa', rel),
        )
      }

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
      //
      // The exception has to name the SCOPE. In this repo an app resolves sierra
      // to packages/sierra/, which is not under node_modules at all, so the skip
      // never fires and every suite passes — while an app installed from npm
      // hands RouterView.mesa to rolldown untransformed and dies on "JSX syntax
      // is disabled" at line 1 of a .mesa file. Dev survives, so it lands at the
      // first build a real user runs.
      if (id.includes('/node_modules/') && !id.includes(`/node_modules/${SIERRA_PKG}/`)) return null

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
          // An uncovered member read on an IMPORTED object is reported, whether
          // or not the file already watches something on that import.
          //
          // Sierra's own state — `page`, `status`, `theme` — is plain objects a
          // component makes reactive with a `$:` path watch, and a missing watch
          // fails the worst possible way: the expression reads nothing reactive,
          // so it is hoisted out of the render block and assigned once at mount.
          // `{connected ? 'ws connected' : 'ws offline'}` read "ws connected"
          // with the API stopped, and across a reload.
          //
          // Mesa's default confidence reports that only when the file watches
          // some OTHER path on the same import — intent is then clear and the
          // omission is an oversight. A component that watches nothing at all is
          // the shape that actually shipped the bug, and default says nothing
          // about it. Measured over the 97 components in this repo's apps:
          // 4 warnings, all on `resource.gate.<method>`, a level number the
          // schema fixes. Suppress one with `$: <path>` or read it in a `var`.
          externalReactivityHints: 'strict',
          filename: id,
          dev: isDev,
          // Everything the app configured, including any `externalSignals` of
          // its own. Sierra declares NONE: it exports no module-level signal, so
          // it has nothing to tell the compiler about (`FJS-060`). The map is an
          // app-facing escape hatch for a third-party package that does export
          // one — and `tests/no-module-signals.test.js` is what keeps this
          // package from quietly becoming such a package again.
          ...mesaOptions,
        })

        if (sierraContext) {
          // ctx.islands is deliberately NOT collected here.
          //
          // It used to be, into sierraContext.islandMap, which nothing ever read —
          // the same populated-and-unused state that hid Mesa's own ctx.islands for
          // months. The island list the build actually uses is gathered by the
          // PRERENDERER (src/build/prerender.js), and has to be: this hook sees
          // every .mesa Vite transforms, which is the whole route tree, while only
          // `render: static` routes get prerendered and only those pages carry
          // markers. A map keyed on everything transformed would over-report.
          sierraContext.staticMap.set(id, ctx.isStatic ?? false)

          // If this is a layout file, extract its export let props
          // so warnDuplicateSnippets can check for conflicts
          if (id.includes('_module')) {
            const props = extractLayoutProps(source)
            sierraContext.layoutPropMap.set(id, props)
          }
        }

        // Compiler ERRORS fail the transform.
        //
        // They used to be dropped on the floor: the compiler filled
        // `analysis.errors`, this plugin read only `warnings`, and Vite served
        // the half-compiled module. A page with five `bind:` errors in it
        // rendered, looked right, and silently did not write anything back —
        // which is the worst of both worlds, because the compiler HAD caught it
        // and said so to nobody.
        if (ctx.analysis?.errors?.length) {
          const rel = id.replace(process.cwd() + '/', '')
          throw new Error(
            `[Mesa] ${ctx.analysis.errors.length} error(s) in ${rel}:\n` +
            ctx.analysis.errors.map(e => `  • ${e}`).join('\n')
          )
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
