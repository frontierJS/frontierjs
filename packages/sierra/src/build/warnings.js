/**
 * src/build/warnings.js — Sierra-specific build warnings
 *
 * Two warning passes:
 *
 * 1. warnUnexportedSnippets(source, id, emitWarning)
 *    Called by mesa-plugin after compilation of each route file.
 *    Detects top-level {#snippet} definitions that aren't exported
 *    from <script module> — they'll be silently ignored by the router.
 *
 * 2. warnDuplicateSnippets(tree, layoutPropMap, emitWarning)
 *    Called by scanner-plugin after the route tree is built.
 *    Detects the same snippet name declared as export let in multiple
 *    layouts within the same chain — both layouts will render it.
 */

import { relative } from 'path'

import { firstRealFailure } from './app-import.js'

// ─── Warning 1: unexported top-level snippets ─────────────────────────────────

/**
 * Parse a .mesa source file and warn if any top-level {#snippet name()}
 * is not exported from <script module>.
 *
 * @param {string} source     — original Mesa source (before frontmatter strip)
 * @param {string} id         — absolute file path
 * @param {string} routesDir  — absolute path to routes directory
 * @param {function} emit     — emitWarning(message) or this.warn() from Vite plugin
 */
export function warnUnexportedSnippets(source, id, routesDir, emit) {
  // Only lint route files — not layouts, components, or non-route files
  const rel = relative(routesDir, id).replace(/\\/g, '/')
  if (rel.startsWith('..')) return  // outside routes dir
  if (rel.includes('_module')) return  // layout files don't pass snippets up

  const snippetNames = extractTopLevelSnippets(source)
  if (snippetNames.length === 0) return

  const exportedNames = extractModuleExports(source)
  const providedNames = extractProvidedSlots(source)

  for (const name of snippetNames) {
    // Suppress if: exported, passed via provideSlot(), or has a sierra-ignore comment
    if (exportedNames.has(name) || providedNames.has(name)) continue
    const ignoreRe = new RegExp(
      `<!--\\s*sierra-ignore\\s+unexported-snippet\\b[^>]*-->|` +
      `/\\*\\s*sierra-ignore\\s+unexported-snippet\\b[^*]*\\*/`
    )
    if (ignoreRe.test(source)) continue
    emit(
      `[Sierra] Snippet '${name}' is defined at the top level of\n` +
      `${id}\n` +
      `but not exported from <script module>. It won't be passed to the parent layout.\n\n` +
      `To pass it to the layout via pageSlots:  {provideSlot('${name}', ${name})}\n` +
      `To pass it via the old export pattern:   export { ${name} } in <script module>\n` +
      `To suppress this warning:                move it inside a block if it's a local helper, or add <!-- sierra-ignore unexported-snippet -->`
    )
  }
}

/**
 * Extract all top-level {#snippet name()} names from Mesa source.
 * "Top-level" means not nested inside a block directive AND not inside a
 * component tag — a snippet written inside `<Table> … </Table>` is that
 * component's `row` prop (Mesa VISION §9.5), not something the route meant to
 * hand up to its layout. Counting only block directives reported every kit
 * component's snippet as a mistake, on every build.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractTopLevelSnippets(source) {
  // Strip script blocks so we only scan the template
  const withoutScripts = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')

  const names = []
  // Track nesting: count opening block directives and component tags against
  // their closers. Only collect snippets at depth 0.
  const openRe  = /\{#(?:if|each|await|key|snippet)\b/g
  const closeRe = /\{\/(?:if|each|await|key|snippet)\}/g
  const snippetRe = /\{#snippet\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g

  // Build a flat list of events in source order: open, close, or snippet-start
  const events = []

  let m
  openRe.lastIndex = 0
  while ((m = openRe.exec(withoutScripts)) !== null) {
    events.push({ type: 'open', pos: m.index })
  }
  closeRe.lastIndex = 0
  while ((m = closeRe.exec(withoutScripts)) !== null) {
    events.push({ type: 'close', pos: m.index })
  }
  snippetRe.lastIndex = 0
  while ((m = snippetRe.exec(withoutScripts)) !== null) {
    events.push({ type: 'snippet', pos: m.index, name: m[1] })
  }
  events.push(...componentTagEvents(withoutScripts))

  // At the same position a `{#snippet name}` is BOTH the name event and an
  // open: the name is read at the depth it was written at, and everything
  // after it is one level deeper.
  const rank = { snippet: 0, close: 1, open: 2 }
  events.sort((a, b) => a.pos - b.pos || rank[a.type] - rank[b.type])

  let depth = 0
  for (const ev of events) {
    if (ev.type === 'open')    { depth++; continue }
    if (ev.type === 'close')   { depth = Math.max(0, depth - 1); continue }
    if (ev.type === 'snippet' && depth === 0) names.push(ev.name)
  }

  return names
}

/**
 * Open/close events for component tags — `<Table …>` … `</Table>`.
 *
 * Attribute values are skipped by brace and quote depth rather than by
 * scanning to the first `>`: an ordinary handler contains one.
 * `onclick={() => run(id)}` ends a naive `[^>]*>` match in the middle of the
 * arrow, and the tag is then read as unclosed.
 *
 * @param {string} src — template source, scripts already stripped
 * @returns {{type: 'open'|'close', pos: number}[]}
 */
function componentTagEvents(src) {
  const events = []

  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue

    const close = /^<\/([A-Z][A-Za-z0-9_.]*)\s*>/.exec(src.slice(i))
    if (close) {
      events.push({ type: 'close', pos: i })
      i += close[0].length - 1
      continue
    }

    const open = /^<([A-Z][A-Za-z0-9_.]*)/.exec(src.slice(i))
    if (!open) continue

    let j = i + open[0].length
    let braces = 0, quote = null, selfClosing = false
    for (; j < src.length; j++) {
      const c = src[j]
      if (quote) { if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") { quote = c; continue }
      if (c === '{') { braces++; continue }
      if (c === '}') { braces = Math.max(0, braces - 1); continue }
      if (braces > 0) continue
      if (c === '/' && src[j + 1] === '>') { selfClosing = true; j++; break }
      if (c === '>') break
    }

    if (!selfClosing) events.push({ type: 'open', pos: i })
    i = j
  }

  return events
}

/**
 * Extract names exported from <script module>.
 *
 * Handles:
 *   export { sidebar }
 *   export { sidebar, toolbar }
 *   export function sidebar() {}
 *   export const sidebar = ...
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function extractModuleExports(source) {
  const names = new Set()

  // Extract <script module> content
  const moduleMatch = source.match(/<script\s+module[^>]*>([\s\S]*?)<\/script>/i)
  if (!moduleMatch) return names

  const moduleContent = moduleMatch[1]

  // export { a, b, c }
  const reExportList = /export\s*\{([^}]+)\}/g
  let m
  while ((m = reExportList.exec(moduleContent)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name) names.add(name)
    }
  }

  // export function name() / export const name = / export let name =
  const reExportDecl = /export\s+(?:function|const|let|var|async\s+function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
  while ((m = reExportDecl.exec(moduleContent)) !== null) {
    names.add(m[1])
  }

  return names
}

// ─── Warning 2: duplicate snippet props across layout chain ──────────────────

/**
 * Walk the route tree and warn when the same named snippet is declared
 * as a prop in multiple layouts within the same ancestor chain.
 *
 * @param {object} tree           — root node from buildTree()
 * @param {Map<string,Set<string>>} layoutPropMap
 *   Map from layout file path → Set of prop names declared with `export let`
 *   (populated by the mesa-plugin after compiling each layout file)
 * @param {function} emit         — emitWarning(message)
 */
/**
 * Warn when a route's frontmatter uses a field name the router owns.
 *
 * Frontmatter is spread onto `page`, so `{page.title}` works directly — but the
 * router assigns its own fields afterwards and therefore wins. A route declaring
 * `data:` or `path:` in its frontmatter would see that value silently replaced
 * by the loader result or the URL.
 *
 * @param {object} tree      route tree from the scanner
 * @param {string[]} reserved PAGE_RESERVED from router/index.js
 * @param {(msg: string) => void} emit
 */
export function warnReservedFrontmatter(tree, reserved, emit) {
  if (!tree || !emit) return
  const seen = new Set()

  const walk = (node) => {
    if (!node) return
    const meta = node.meta ?? {}
    for (const key of Object.keys(meta)) {
      if (!reserved.includes(key)) continue
      const at = node.file ?? node.layout ?? node.id
      const sig = `${at}:${key}`
      if (seen.has(sig)) continue
      seen.add(sig)
      emit(
        `${at}: frontmatter key '${key}' is reserved — the router assigns page.${key} ` +
        `after spreading frontmatter, so this value is discarded. Rename it, or read it ` +
        `from page.meta.${key}, which keeps the raw frontmatter object.`
      )
    }
    node.children?.forEach(walk)
  }

  walk(tree)
}

export function warnDuplicateSnippets(tree, layoutPropMap, emit) {
  // Build all root-to-leaf paths through the tree
  const chains = collectLayoutChains(tree)

  for (const chain of chains) {
    checkChainForDuplicates(chain, layoutPropMap, emit)
  }
}

/**
 * Collect all unique layout chains in the tree.
 * Each chain is an ordered array of layout file paths, outermost first.
 * We deduplicate chains — many routes share the same layout chain.
 *
 * @param {object} tree
 * @returns {string[][]}
 */
function collectLayoutChains(tree) {
  const seen = new Set()
  const chains = []

  function walk(node, ancestorLayouts) {
    const nodeLayout = node.layout

    // Build this node's layout chain
    let chain
    if (!nodeLayout) {
      // reset: true — no layouts
      chain = []
    } else if (!ancestorLayouts.includes(nodeLayout)) {
      chain = [...ancestorLayouts, nodeLayout]
    } else {
      chain = ancestorLayouts
    }

    // Only record chains with 2+ layouts (need at least two to conflict)
    if (chain.length >= 2) {
      const key = chain.join('|')
      if (!seen.has(key)) {
        seen.add(key)
        chains.push(chain)
      }
    }

    for (const child of node.children ?? []) {
      walk(child, chain)
    }
  }

  walk(tree, [])
  return chains
}

/**
 * Check a single layout chain for duplicate snippet prop names.
 *
 * @param {string[]} chain      — layout file paths, outermost first
 * @param {Map<string, Set<string>>} layoutPropMap
 * @param {function} emit
 */
function checkChainForDuplicates(chain, layoutPropMap, emit) {
  // Build a map: propName → [layoutPaths that declare it]
  const propToLayouts = new Map()

  for (const layoutPath of chain) {
    const props = layoutPropMap.get(layoutPath)
    if (!props) continue

    for (const prop of props) {
      // Skip 'children' — that's always present and not a snippet conflict
      if (prop === 'children') continue

      if (!propToLayouts.has(prop)) {
        propToLayouts.set(prop, [])
      }
      propToLayouts.get(prop).push(layoutPath)
    }
  }

  // Warn for any prop declared in 2+ layouts
  for (const [prop, layouts] of propToLayouts) {
    if (layouts.length >= 2) {
      emit(
        `[Sierra] Snippet '${prop}' is declared as a prop in multiple layouts in the same chain:\n` +
        layouts.map(l => `  - ${l}`).join('\n') + '\n\n' +
        `Both layouts will render the same snippet. If this is intentional, suppress\n` +
        `this warning with /* sierra-ignore duplicate-snippet */ in one of the layouts.\n` +
        `Otherwise, remove the prop declaration from whichever layout should not render it.`
      )
    }
  }
}

// ─── Layout prop extraction ────────────────────────────────────────────────────

/**
 * Extract all `export let` prop names from a Mesa layout source.
 * Called by mesa-plugin when compiling a _module.mesa file.
 *
 * @param {string} source — Mesa source (with or without frontmatter)
 * @returns {Set<string>}
 */
export function extractLayoutProps(source) {
  const props = new Set()

  // Strip frontmatter
  const withoutFm = source.replace(/^---[\s\S]*?---\n?/, '')

  // Find <script> block (not module)
  const scriptMatch = withoutFm.match(/<script(?!\s+module)[^>]*>([\s\S]*?)<\/script>/i)
  if (!scriptMatch) return props

  const scriptContent = scriptMatch[1]

  // Match: export let name / export let name = ...
  const re = /export\s+let\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
  let m
  while ((m = re.exec(scriptContent)) !== null) {
    props.add(m[1])
  }

  return props
}

/**
 * Extract snippet names that are either:
 *   a) passed to provideSlot() in the template, or
 *   b) declared with <mesa:slot name="X"> (before the plugin rewrites them)
 *
 * These are intentionally "local" snippets — they pass content up to the
 * layout via the pageSlots signal. No warning should be emitted for them.
 *
 * @param {string} source — Mesa source (original, before slot rewrite)
 * @returns {Set<string>}
 */
function extractProvidedSlots(source) {
  const names = new Set()

  // Match provideSlot('name', ...) in the template
  const withoutScripts = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const provideRe = /provideSlot\s*\(\s*['"]([a-zA-Z_$][a-zA-Z0-9_$]*)['"][\s\S]*?\)/g
  let m
  while ((m = provideRe.exec(withoutScripts)) !== null) {
    names.add(m[1])
  }

  // Match <mesa:slot name="X"> tags (the sugar form, before rewrite)
  const slotRe = /<mesa:slot\s+name="([a-zA-Z_$][a-zA-Z0-9_$]*)"/g
  while ((m = slotRe.exec(source)) !== null) {
    names.add(m[1])
  }

  return names
}

// ─── A module that failed to initialize, read a second time ───────────────────

/**
 * Explain a TDZ error that is really a re-import of a module that already
 * threw (`FJS-551`).
 *
 * A module ending in a top-level `await` — which is what an app's own db module
 * is, `export const db = await openShop(…)` — reports its real error exactly
 * once. Every import after that resolves to a partially-initialized namespace
 * instead of re-throwing, so the next reader gets `Cannot access 'X' before
 * initialization` naming whichever binding it happened to touch first, and the
 * cause is gone.
 *
 * A build imports the app's db module from several places, so what it usually
 * holds is the SECOND kind. Four messages of that shape once hid a schema parse
 * error naming a file and a line, and cost two people the same wrong diagnosis
 * on the same day — they read as a broken build rather than as a broken schema.
 *
 * Additive: the original message is kept in front, because it is still the only
 * thing that names where the read happened.
 *
 * **And where the build caught the first failure itself, it says what it was.**
 * `app-import.js` records the earliest failure that was not already a TDZ, so
 * the cause the runtime threw away is still in the build's own hands — printing
 * the advice instead would be asking the reader to reproduce something this
 * process already knows.
 */
export function explainModuleInitFailure(message, specifier) {
  if (!/before initialization/.test(String(message ?? ''))) return message
  const where = specifier ? ` '${specifier}'` : ''
  const first = firstRealFailure()

  const head = `${message}\n` +
    `      This is not the real error. A module${where} in this import graph threw while\n` +
    `      it was initializing; re-importing it yields a half-built namespace rather than\n` +
    `      the original throw, so what you are reading is a binding that never got a value.`

  if (!first) return `${head}\n` +
    `      To see the cause, import it once on its own:  bun -e "await import('<the module>')"`

  return `${head}\n` +
    `      The first module that failed in this build was '${first.path}', and this is\n` +
    `      what it said:\n` +
    `        ${String(first.error?.message ?? first.error).split('\n').join('\n        ')}`
}
