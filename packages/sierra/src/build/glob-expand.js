/**
 * build/glob-expand.js — `import.meta.glob` in a prerendered page
 *
 * `import.meta.glob` is Vite's, and the prerender does not run inside Vite: Mesa's
 * `renderComponent` compiles each file from disk and Bun imports the result, and
 * Bun has no `import.meta.glob`. So a block listing `content/collections/*.md`
 * rendered in `vite dev` and failed `site:build` with *import.meta.glob is not a
 * function* — a collection read the way a live page reads it and not the way a
 * prerendered one does (the ksite stressor, Q2).
 *
 * An EAGER glob is only a list of static imports, and static imports are what
 * `renderComponent` already follows — it compiles every `.md`/`.mesa` a module
 * names. So the prerender rewrites
 *
 *   import.meta.glob('../content/features/*.md', { eager: true })
 *
 * into one `import * as` per match and an object literal of them, keyed and
 * ordered as Vite keys and orders them: the path relative to the importer as
 * written, sorted, the importer itself left out. `import: 'name'` narrows each
 * value to that export, as it does in Vite.
 *
 * The Vite transform is left alone. Vite's own glob is what watches the
 * directory, so a file added to a collection reaches `vite dev` without a
 * restart; expanding here would have traded that away for a second copy of the
 * same list.
 *
 * A LAZY glob cannot be prerendered — it hands back `import()` thunks for Vite to
 * split — so it becomes a call that throws, naming the fix, if the render ever
 * reaches it. It is not refused outright: an island that globs inside
 * `$.onMount` never evaluates it during the build.
 */

import { globSync } from 'fs'
import { dirname, relative, resolve, sep } from 'path'

// `import.meta.glob(` then one string literal, then an optional options object
// with no nested braces. A pattern array or a computed pattern is not matched,
// and Vite refuses a computed one itself.
const GLOB_CALL = /import\.meta\.glob\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*(\{[^{}]*\}))?\s*\)/g
const SCRIPT_BLOCK = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g
const KNOWN_OPTIONS = new Set(['eager', 'import'])

/**
 * The options object as written — `eager` and `import`, literal values only.
 * Anything else is named back to the author rather than dropped: `query`,
 * `base` and a negative pattern each change what Vite returns.
 */
function readOptions(text, file) {
  if (!text) return { eager: false }
  const body = text.slice(1, -1).trim()
  const options = {}
  for (const part of body.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^['"]?(\w+)['"]?\s*:\s*(.+)$/)
    if (!m || !KNOWN_OPTIONS.has(m[1])) {
      throw new Error(
        `[Sierra] ${file}: import.meta.glob(…, ${text}) cannot be prerendered — ` +
        `only { eager: true } and { import: 'name' } are expanded outside Vite.`
      )
    }
    const value = m[2].trim()
    if (m[1] === 'eager') options.eager = value === 'true'
    else options.import = value.replace(/^['"`]|['"`]$/g, '')
  }
  return options
}

/**
 * Rewrite every `import.meta.glob` in a component's script blocks.
 *
 * @param {string} source — what Mesa is about to compile (after `prepareForCompile`)
 * @param {string} file   — its absolute path; relative patterns resolve against it
 * @param {string} [root] — the Vite root, which a pattern starting `/` resolves
 *   against, so a component in a package can list the app's files (`FJS-1553`)
 * @returns {string}
 */
export function expandGlobs(source, file, root) {
  if (!source.includes('import.meta.glob')) return source

  const dir = dirname(file)
  let n = 0

  return source.replace(SCRIPT_BLOCK, (whole, open, body, close) => {
    const imports = []
    const expanded = body.replace(GLOB_CALL, (call, _q, pattern, optionText) => {
      const options = readOptions(optionText, file)

      if (!options.eager) {
        const message =
          `[Sierra] ${file}: import.meta.glob('${pattern}') is lazy, and a prerendered page has ` +
          `no bundler to split it. Add { eager: true }.`
        return `(() => { throw new Error(${JSON.stringify(message)}) })()`
      }
      const fromRoot = pattern.startsWith('/') && root
      if (!fromRoot && !pattern.startsWith('./') && !pattern.startsWith('../')) {
        throw new Error(
          `[Sierra] ${file}: import.meta.glob('${pattern}') — a prerendered glob must be ` +
          `relative to the file (./ or ../) or to the Vite root (/).`
        )
      }

      // Vite keys a root glob by its root-absolute path and a relative one by
      // the path from the importer; the import itself is absolute either way.
      const base = fromRoot ? root : dir
      const self = resolve(file)
      const matches = globSync(fromRoot ? pattern.slice(1) : pattern, { cwd: base })
        .map((m) => resolve(base, m))
        .filter((abs) => abs !== self)
        .sort()

      const entries = matches.map((abs) => {
        let key = relative(base, abs).split(sep).join('/')
        if (fromRoot) key = `/${key}`
        else if (!key.startsWith('.')) key = `./${key}`
        const spec = fromRoot ? abs : key
        const local = `__sierra_glob_${n++}`
        imports.push(options.import
          ? `import { ${options.import} as ${local} } from ${JSON.stringify(spec)}`
          : `import * as ${local} from ${JSON.stringify(spec)}`)
        return `${JSON.stringify(key)}: ${local}`
      })
      return `{ ${entries.join(', ')} }`
    })

    if (expanded === body) return whole
    return imports.length
      ? `${open}\n  ${imports.join('\n  ')}${expanded}${close}`
      : `${open}${expanded}${close}`
  })
}
