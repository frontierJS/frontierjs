/**
 * terminal/loader.js — an app's `.mesa` files compiled with `target:
 * 'terminal'` and imported under Bun, for the terminal shell (`FJS-D809`:
 * the terminal is a target of `web/`, never a second route tree).
 *
 * `installTerminalLoader({ root })` registers a Bun runtime plugin: a `.mesa`
 * import is prepared exactly as the Vite transform prepares it
 * (`prepareForCompile` — frontmatter, slot rewriting, auto-imports) and
 * compiled for the terminal, and `@/` resolves to the surface's `src/`
 * (`appSrcDir`, the one definition). `lowers(file)` answers whether a file
 * and every `.mesa` it imports lowers, WITHOUT running any of them, so the
 * shell can list which routes open before a route's module runs its
 * `createResource` at import.
 *
 * Traps:
 * - The compiler is found through `findMesaFile`, off the filesystem, as the
 *   Vite plugin finds it: `@frontierjs/mesa` by name can be the copy bun
 *   leaves under `node_modules/.bun/`, a snapshot of an older tree.
 * - A file whose markup is refused still compiles when it has a `<script
 *   module>`: its named exports, and a default that throws the refusal. So a
 *   route importing `orders` from `Order.mesa` lowers and one mounting
 *   `<Order>` does not, and `lowers` reads each import clause to tell them
 *   apart (`FJS-2182`).
 * - One compile per file, cached, read by both the plugin and `lowers`. The
 *   output's imports are resolved by the same `resolveFrom` the plugin uses,
 *   so the walk cannot pass a file the import then fails to find.
 * - Bun's plugin registry is process-wide and has no removal, so a second
 *   install for another root would answer the first root's `@/`. One root per
 *   process; the shell is one process per app.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { findMesaFile, prepareForCompile } from '../build/mesa-plugin.js'
import { appSrcDir } from '../build/app-alias-plugin.js'

let installed = null

// `@frontierjs/sierra/router` is the router without its two DOM outlets,
// which `entry.js` re-exports and which do not lower (`FJS-2271`). The shell
// imports this same file, so a route's `page` is the shell's.
const ROUTER = fileURLToPath(new URL('../router/index.js', import.meta.url))
// Rewritten in the compiled output rather than resolved by the plugin: Bun
// does not hand a plugin-loaded module's package imports to `onResolve`.
const ROUTER_IMPORT = /(\bfrom\s*['"])@frontierjs\/sierra\/router(['"])/g

/** A `.mesa` import or re-export, its clause and its specifier. A bare
 *  side-effect import has no clause and mounts nothing. */
const MESA_IMPORT = /\b(?:import|export)\s+(?:([^'";]*?)\s+from\s+)?['"]([^'"]+\.mesa)['"]/g

/** Whether an import clause can reach the default export. Only a clause of
 *  named bindings alone is sure not to: `Form`, `* as M` and `export *` are
 *  read as reaching it, and so is `{ default as Form }`. */
const takesComponent = (clause) => {
  if (clause == null) return false
  const named = clause.trim().match(/^\{([^}]*)\}$/)
  return !named || /\bdefault\b/.test(named[1])
}

/**
 * @param {{ root: string, autoImportMap?: Map<string, object> }} options
 *        `root` is the web surface (the directory holding `src/` and `config/`)
 */
export async function installTerminalLoader({ root, autoImportMap = null }) {
  if (installed) {
    if (installed.root !== root) throw new Error(`[Sierra] the terminal loader is installed for ${installed.root}; one app root per process`)
    return installed
  }
  const compilerPath = findMesaFile('compiler.js', root)
  if (!compilerPath) throw new Error(`[Sierra] @frontierjs/mesa's compiler was not found from ${root}`)
  const { compile } = await import(pathToFileURL(compilerPath).href)
  const src = appSrcDir(root)

  /** A specifier as the plugin resolves it: `@/` is the surface's `src/`,
   *  anything else is Bun's own answer from the importing file. */
  const resolveFrom = (spec, fromFile) => {
    if (spec.startsWith('@/')) return resolve(src, spec.slice(2))
    return Bun.resolveSync(spec, dirname(fromFile))
  }

  const cache = new Map()   // path → { code } | { error }
  const compileFile = async (path) => {
    if (cache.has(path)) return cache.get(path)
    let entry
    try {
      const content = prepareForCompile(readFileSync(path, 'utf8'), path, autoImportMap)
      const ctx = await compile(content ?? '', {
        target:   'terminal',
        filename: relative(root, path),
        warning:  () => {},
      })
      entry = { code: ctx.result.replace(ROUTER_IMPORT, `$1${ROUTER}$2`), refusal: ctx.terminalRefusal ?? null }
    } catch (e) {
      entry = { error: e.message }
    }
    cache.set(path, entry)
    return entry
  }

  /** `null` when `path` and every `.mesa` it imports lowers; otherwise the
   *  first refusal, `{ file, error }`, in import order. A file whose markup
   *  is refused but whose `<script module>` compiled holds back only an
   *  importer that takes its default — the component — or the namespace.
   *  Only a mounted file mounts what it imports: a file taken for its named
   *  exports never runs its default, so its own imports need only load. */
  const lowers = async (path, seen = new Set(), component = true) => {
    const key = `${component}:${path}`
    if (seen.has(key)) return null
    seen.add(key)
    const entry = await compileFile(path)
    if (entry.error) return { file: relative(root, path), error: entry.error }
    if (component && entry.refusal) return { file: relative(root, path), error: entry.refusal }
    for (const m of entry.code.matchAll(MESA_IMPORT)) {
      let dep
      try { dep = resolveFrom(m[2], path) } catch (e) { return { file: relative(root, path), error: `cannot resolve ${m[2]}` } }
      const refused = await lowers(dep, seen, component && takesComponent(m[1]))
      if (refused) return refused
    }
    return null
  }

  Bun.plugin({
    name: 'sierra:terminal',
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => ({ path: resolve(src, args.path.slice(2)) }))
      build.onLoad({ filter: /\.mesa$/ }, async ({ path }) => {
        const entry = await compileFile(path)
        if (entry.error) throw new Error(entry.error)
        return { contents: entry.code, loader: 'js' }
      })
    },
  })

  installed = { root, lowers, resolveFrom }
  return installed
}
