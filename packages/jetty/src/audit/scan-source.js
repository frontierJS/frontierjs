// scan-source.js — find chrome.<ns> / browser.<ns> namespace references.
//
// Scans built bundle files (post-bundling, pre-minification) for namespace
// usages. Operates on raw source text — no AST. Tradeoffs:
//   + Fast, no parser dependency
//   + Catches both static and dynamic-feeling patterns (chrome.tabs.query,
//     chrome['tabs'].query, const tabs = chrome.tabs)
//   - String-matching false positives (e.g. a comment "use chrome.tabs.query")
//     are minimized by matching only callable/property-access contexts
//   - Dynamic property names (chrome[apiName]) impossible to resolve — the
//     framework warns when bracket access has a non-string-literal key.
//
// We scan our built dist/<browser>/ outputs because consumer code lives at
// many paths, but after bundling everything is in one place. Bundles include
// transitive deps so we catch indirect usage too.
//
// Known limitation: minified code can mangle property access patterns. Phase 7
// runs the audit on un-minified dev/prod bundles (jetty currently emits
// minify: false). If consumers minify externally, audit may miss usages.

// The API root as it appears in a bundle: chrome, the Firefox browser global,
// or @frontierjs/jetty/browser's `browser` export, which a bundler renames to
// browser$1 / browser2 when another binding in the chunk already holds the name.
const ROOT = String.raw`(?:chrome|browser(?:\$\d+|\d+)?)`

const NAMESPACE_PATTERNS = [
  // Match: chrome.foo, chrome.foo., chrome.foo(, chrome.foo[
  // Captures: namespace name, then the member called on it when there is one
  // Excludes: chrome.bar where bar is followed by another identifier char
  //           that would imply a different namespace (chrome.foobar isn't
  //           chrome.foo).
  new RegExp(String.raw`\b${ROOT}\.([a-z][A-Za-z0-9]*)\b(?:\.([A-Za-z_$][\w$]*))?`, 'g'),

  // Match: chrome['foo'], chrome["foo"]
  new RegExp(String.raw`\b${ROOT}\[\s*["']([a-z][A-Za-z0-9]*)["']\s*\](?:\.([A-Za-z_$][\w$]*))?`, 'g'),
]

// const { alarms, tabs: t } = browser — the surface reaches the code under a
// key, with no root.ns token beside it.
const DESTRUCTURE_PATTERN = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${ROOT}(?![\w$.\[])`, 'g')

const DYNAMIC_PATTERN = /\b(?:chrome|browser(?:\$\d+|\d+)?)\[(?!\s*["'])/g

// A namespace named with no member after it (const t = chrome.tabs) could be
// calling anything on it.
const WHOLE = '*'

/**
 * Scan source text for chrome/browser namespace usages.
 * Returns:
 *   {
 *     namespaces: Set<string>     — every <ns> seen via chrome.<ns> / browser.<ns>
 *     members: Map<string, Set<string>> — ns → members called on it, '*' for a bare reference
 *     dynamicAccessCount: number  — count of chrome[<expression>] dynamic accesses
 *   }
 *
 * @param {string} source — raw source text
 */
export function scanSource(source) {
  const namespaces = new Set()
  const members = new Map()
  let dynamicAccessCount = 0

  const note = (ns, member) => {
    namespaces.add(ns)
    let set = members.get(ns)
    if (!set) { set = new Set(); members.set(ns, set) }
    set.add(member ?? WHOLE)
  }

  // Strip line comments and block comments. Imperfect (won't handle nested
  // /* */) but good enough for bundled output.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  for (const pat of NAMESPACE_PATTERNS) {
    pat.lastIndex = 0
    let m
    while ((m = pat.exec(stripped))) note(m[1], m[2])
  }

  DESTRUCTURE_PATTERN.lastIndex = 0
  let dsm
  while ((dsm = DESTRUCTURE_PATTERN.exec(stripped))) {
    for (const part of dsm[1].split(',')) {
      const key = part.split(':')[0].split('=')[0].trim()
      if (/^[a-z][A-Za-z0-9]*$/.test(key)) note(key)
    }
  }

  DYNAMIC_PATTERN.lastIndex = 0
  let dm
  while ((dm = DYNAMIC_PATTERN.exec(stripped))) {
    dynamicAccessCount++
  }

  return { namespaces, members, dynamicAccessCount }
}
