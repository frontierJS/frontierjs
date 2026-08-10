/**
 * auto-import-plugin.js — auto-import Sierra components and module bindings
 *
 * Components in configured directories, and named bindings from configured
 * packages, are automatically available in all .mesa files without an import
 * statement.
 *
 * Config:
 *   autoImport: {
 *     components: ['src/components/UI', 'src/components/Layout'],
 *     modules: {
 *       '@frontierjs/sierra': ['page', ['theme', 'appTheme']],
 *       'svelte/store':       { default: 'store' },
 *     }
 *   }
 *
 * How it works:
 * 1. Scans configured dirs RECURSIVELY for PascalCase .mesa/.md files at build
 *    start, keyed on the basename — a component's directory is an organising
 *    device, its name is the whole identity.
 * 2. Builds a map: name → { kind, from, imported }
 * 3. Exposes virtual:sierra-autoimport — an object of { Name: factory }
 * 4. The Mesa compiler plugin prepends import statements to each .mesa file
 *    before compilation, for names the file actually uses.
 *
 * Two sources exporting the same name → build error. A directory tree and a
 * package are the same namespace, because the injected import is the same
 * identifier either way.
 */

import { resolve, relative, basename, extname, join } from 'path'
import { readdir } from 'fs/promises'

const VIRTUAL_ID = 'virtual:sierra-autoimport'
const RESOLVED_ID = '\0virtual:sierra-autoimport'

// Directories that are never a component tree. Scanning node_modules from a
// misconfigured path walks the whole dependency graph before it fails.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

/**
 * Normalise `autoImport.modules` into entries.
 *
 * Accepted per package:
 *   ['a', 'b']                  — named imports
 *   [['a', 'alias']]            — named import under a local alias
 *   { default: 'Name' }         — default import
 *   { star: 'Name' }            — namespace import
 * The object form may also carry `named: [...]`.
 *
 * @param {object} modules
 * @returns {Array<{ local: string, from: string, imported: string|null, kind: 'named'|'default'|'star' }>}
 */
export function normalizeModules(modules = {}) {
  const out = []

  for (const [from, spec] of Object.entries(modules)) {
    const named = []

    if (Array.isArray(spec)) {
      named.push(...spec)
    } else if (spec && typeof spec === 'object') {
      if (spec.default) out.push({ local: spec.default, from, imported: null, kind: 'default' })
      if (spec.star)    out.push({ local: spec.star,    from, imported: null, kind: 'star' })
      if (Array.isArray(spec.named)) named.push(...spec.named)
    } else if (typeof spec === 'string') {
      // 'pkg': 'Name' is the default import — the one-binding case, written short.
      out.push({ local: spec, from, imported: null, kind: 'default' })
    }

    for (const entry of named) {
      const [imported, local] = Array.isArray(entry) ? entry : [entry, entry]
      out.push({ local: local ?? imported, from, imported, kind: 'named' })
    }
  }

  return out
}

/**
 * @param {object} config        — sierra.config.js
 * @param {object} sierraContext — shared context
 * @returns {import('vite').Plugin}
 */
export function autoImportPlugin(config, sierraContext) {
  const dirs    = config.autoImport?.components ?? []
  const modules = normalizeModules(config.autoImport?.modules ?? {})
  if (dirs.length === 0 && modules.length === 0) return null

  // Map: local name → { kind, from, imported }
  let componentMap = new Map()
  let root = process.cwd()

  async function scan(root) {
    const map = new Map()
    // Where each name came from, for the conflict message. A package entry has
    // no file path, so this is what both halves can report.
    const origin = new Map()

    const claim = (name, entry, where) => {
      if (map.has(name)) {
        throw new Error(
          `[Sierra] Auto-import naming conflict: '${name}' is provided by both\n` +
          `  ${origin.get(name)}\n` +
          `  ${where}\n` +
          `Rename one of the components, alias the module binding, or remove its directory from autoImport.components`
        )
      }
      map.set(name, entry)
      origin.set(name, where)
    }

    for (const dir of dirs) {
      const absDir = resolve(root, dir)
      let files

      try {
        files = await walk(absDir)
      } catch {
        console.warn(`[Sierra] autoImport dir not found: ${dir}`)
        continue
      }

      for (const abs of files) {
        const ext = extname(abs)
        if (ext !== '.mesa' && ext !== '.md') continue

        const name = basename(abs, ext)
        // Only PascalCase components
        if (!/^[A-Z]/.test(name)) continue

        claim(name, { kind: 'default', from: abs, imported: null }, relative(root, abs))
      }
    }

    for (const mod of modules) {
      const what = mod.kind === 'named' && mod.imported !== mod.local
        ? `{ ${mod.imported} as ${mod.local} }`
        : mod.kind === 'star' ? `* as ${mod.local}` : mod.local
      claim(mod.local, mod, `import ${what} from '${mod.from}'`)
    }

    return map
  }

  return {
    name: 'sierra:auto-import',
    enforce: 'pre',

    configResolved(viteConfig) {
      root = viteConfig.root ?? process.cwd()
    },

    async buildStart() {
      componentMap = await scan(root)
      sierraContext.autoImportMap = componentMap

      if (componentMap.size > 0) {
        console.log(
          `[Sierra] Auto-import: ${componentMap.size} name${componentMap.size === 1 ? '' : 's'} ` +
          `(${[...componentMap.keys()].slice(0, 5).join(', ')}${componentMap.size > 5 ? '…' : ''})`
        )
      }
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
    },

    load(id) {
      if (id !== RESOLVED_ID) return null
      return generateVirtualModule(componentMap)
    },

    // Re-scan when component files are added/removed in dev
    configureServer(server) {
      for (const dir of dirs) {
        const absDir = resolve(root, dir)
        server.watcher.add(absDir)
      }

      const rescan = async (file) => {
        const isInAutoImportDir = dirs.some(d => file.startsWith(resolve(root, d)))
        if (!isInAutoImportDir) return

        try {
          componentMap = await scan(root)
          sierraContext.autoImportMap = componentMap
          // Invalidate virtual module
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
          if (mod) server.moduleGraph.invalidateModule(mod)
        } catch (err) {
          console.error(err.message)
        }
      }

      server.watcher.on('add', rescan)
      server.watcher.on('unlink', rescan)
    },
  }
}

/**
 * Recursively collect file paths under a directory.
 * Sorted at each level so the scan order — and therefore which side of a
 * naming conflict is reported first — does not depend on the filesystem.
 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      out.push(...await walk(join(dir, entry.name)))
    } else {
      out.push(join(dir, entry.name))
    }
  }

  return out
}

/** One `import` statement for a map entry. */
function importStatement(local, entry) {
  const from = entry.from.replace(/\\/g, '/')

  if (entry.kind === 'star')  return `import * as ${local} from '${from}'`
  if (entry.kind === 'named') {
    return entry.imported === local
      ? `import { ${local} } from '${from}'`
      : `import { ${entry.imported} as ${local} } from '${from}'`
  }
  return `import ${local} from '${from}'`
}

/**
 * Generate the virtual:sierra-autoimport module.
 * Exports each name so a consumer can see the whole registry at once.
 */
function generateVirtualModule(componentMap) {
  if (componentMap.size === 0) return 'export default {}'

  const imports = []
  const exports = []

  for (const [name, entry] of componentMap) {
    imports.push(importStatement(name, entry))
    exports.push(`  ${name}`)
  }

  return [
    '// virtual:sierra-autoimport — auto-generated by Sierra',
    ...imports,
    '',
    'export default {',
    exports.join(',\n'),
    '}',
  ].join('\n')
}

/**
 * Given a .mesa source string and the auto-import map, prepend import
 * statements for any registered name the file actually uses and has not
 * already imported.
 *
 * Components are found as PascalCase TAGS in the template. Module bindings are
 * found as bare IDENTIFIERS anywhere — a store is used in the script, a
 * formatter in a template expression, and neither is a tag.
 *
 * Called by mesa-plugin.js before compilation.
 *
 * @param {string} source          — original Mesa source
 * @param {Map<string,object>} map — name → { kind, from, imported }
 * @returns {string}               — source with auto-imports prepended
 */
export function injectAutoImports(source, map) {
  if (!map || map.size === 0) return source

  // A pre-2026-08 map held name → path. Accept it so a caller holding one is
  // not silently skipped: every entry becomes the default import it was.
  const entries = new Map(
    [...map].map(([name, v]) =>
      [name, typeof v === 'string' ? { kind: 'default', from: v, imported: null } : v]
    )
  )

  // Names the file already binds itself — an explicit import, or a local
  // declaration. Injecting over either is a redeclaration the module will not
  // parse, so a local `const page = …` must win over a registered `page`.
  const bound = collectBoundNames(source)

  // Strip script blocks so tag scanning sees only the template.
  const templateOnly = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  // Identifier scanning sees CODE only — script blocks and {…} expressions.
  // Ordinary template text is prose, and a word in prose is not a reference:
  // `<p>Page not found</p>` must not import `page`.
  const scannable = stripNonCode(codeRegions(source))

  const needed = new Set()

  const tagRe = /<([A-Z][a-zA-Z0-9]*)\b/g
  let m
  while ((m = tagRe.exec(templateOnly)) !== null) {
    const name = m[1]
    const entry = entries.get(name)
    // Only a component can be a tag. A module binding that happens to be
    // PascalCase is still matched below, as an identifier.
    if (entry && isComponent(entry) && !bound.has(name)) needed.add(name)
  }

  for (const [name, entry] of entries) {
    if (isComponent(entry) || bound.has(name) || needed.has(name)) continue
    if (usesIdentifier(scannable, name)) needed.add(name)
  }

  if (needed.size === 0) return source

  const injected = [...needed]
    .sort()
    .map(name => importStatement(name, entries.get(name)))
    .join('\n')

  // Inject after the opening instance <script> tag (not module script).
  // <script module> is for module-level shared code — imports belong in the
  // instance script block where the component's reactive context lives.
  const scriptMatch = source.match(/(<script(?!\s+module)[^>]*>)/)
  if (scriptMatch) {
    const idx = source.indexOf(scriptMatch[0]) + scriptMatch[0].length
    return source.slice(0, idx) + '\n' + injected + '\n' + source.slice(idx)
  }

  return injected + '\n\n' + source
}

/** A component is a default import from a file path, not from a package. */
function isComponent(entry) {
  return entry.kind === 'default' && /\.(mesa|md)$/.test(entry.from)
}

/**
 * Names the source already binds: explicit imports plus top-level-ish
 * declarations. Deliberately over-inclusive — a false positive costs one
 * missing auto-import, which the author fixes by writing the import; a false
 * negative emits a duplicate binding and the module does not parse.
 */
function collectBoundNames(source) {
  const bound = new Set()
  const code = stripNonCode(codeRegions(source))

  // import X, { a as b, c } from '…'  /  import * as ns from '…'
  // The specifier is not matched — stripNonCode has already blanked the string
  // literal it lives in, so requiring the quote matches nothing.
  const importRe = /\bimport\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s*from\b/g
  let m
  while ((m = importRe.exec(code)) !== null) {
    if (m[1]) bound.add(m[1])
    if (m[3]) bound.add(m[3])
    if (m[4]) bound.add(m[4])
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) bound.add(name)
      }
    }
  }

  // const/let/var/function/class declarations, and `{#snippet name(…)}`
  const declRe = /\b(?:const|let|var|function|class)\s+(\w+)/g
  while ((m = declRe.exec(code)) !== null) bound.add(m[1])

  const snippetRe = /\{#snippet\s+(\w+)/g
  while ((m = snippetRe.exec(source)) !== null) bound.add(m[1])

  return bound
}

/**
 * Is `name` used as a bare identifier — not as a property, not as a key, not
 * as its own declaration?
 */
function usesIdentifier(code, name) {
  // (^|not . or $) name (not : in `{ name: … }`, not = in a declaration)
  const re = new RegExp(`(^|[^.$\\w'"])${escapeRe(name)}\\b`, 'g')
  let m

  while ((m = re.exec(code)) !== null) {
    const after = code.slice(m.index + m[0].length)
    // `{ name: value }` is an object key, not a use of the binding.
    if (/^\s*:/.test(after)) continue
    return true
  }

  return false
}

/**
 * Blank out everything that is not code: template prose, and the markup around
 * it. What survives is every `<script>` body and every `{…}` expression —
 * the two places a module binding can actually be referenced.
 *
 * Blanked with spaces rather than removed so offsets stay meaningful and a
 * name never fuses with the character that preceded it.
 */
function codeRegions(source) {
  const out = source.split('')
  const keep = new Array(source.length).fill(false)

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = scriptRe.exec(source)) !== null) {
    const start = m.index + m[0].indexOf('>') + 1
    for (let i = start; i < start + m[1].length; i++) keep[i] = true
  }

  // Brace matching rather than a regex: `{items.map(x => ({ id: x }))}` nests,
  // and a non-greedy `\{[^}]*\}` stops at the first inner brace.
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    if (keep[i]) continue
    if (source[i] === '{') { depth++; continue }
    if (source[i] === '}') { if (depth > 0) depth--; continue }
    if (depth > 0) keep[i] = true
  }

  for (let i = 0; i < out.length; i++) {
    if (!keep[i] && out[i] !== '\n') out[i] = ' '
  }

  return out.join('')
}

/**
 * Blank out comments and string/template literals so a name inside one is not
 * read as a use. Replaced with spaces rather than removed, so offsets — and
 * therefore the `[^.$\w'"]` lookbehind stand-in — stay meaningful.
 */
function stripNonCode(source) {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (match) => match.replace(/[^\n]/g, ' ')
  )
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
