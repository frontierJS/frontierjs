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

const NAMESPACE_PATTERNS = [
  // Match: chrome.foo, chrome.foo., chrome.foo(, chrome.foo[
  // Captures: namespace name
  // Excludes: chrome.bar where bar is followed by another identifier char
  //           that would imply a different namespace (chrome.foobar isn't
  //           chrome.foo).
  /\b(?:chrome|browser)\.([a-z][A-Za-z0-9]*)\b/g,

  // Match: chrome['foo'], chrome["foo"]
  /\b(?:chrome|browser)\[\s*["']([a-z][A-Za-z0-9]*)["']\s*\]/g,
]

const DYNAMIC_PATTERN = /\b(?:chrome|browser)\[(?!\s*["'])/g

/**
 * Scan source text for chrome/browser namespace usages.
 * Returns:
 *   {
 *     namespaces: Set<string>     — every <ns> seen via chrome.<ns> / browser.<ns>
 *     dynamicAccessCount: number  — count of chrome[<expression>] dynamic accesses
 *   }
 *
 * @param {string} source — raw source text
 */
export function scanSource(source) {
  const namespaces = new Set()
  let dynamicAccessCount = 0

  // Strip line comments and block comments. Imperfect (won't handle nested
  // /* */) but good enough for bundled output.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  for (const pat of NAMESPACE_PATTERNS) {
    pat.lastIndex = 0
    let m
    while ((m = pat.exec(stripped))) {
      namespaces.add(m[1])
    }
  }

  DYNAMIC_PATTERN.lastIndex = 0
  let dm
  while ((dm = DYNAMIC_PATTERN.exec(stripped))) {
    dynamicAccessCount++
  }

  return { namespaces, dynamicAccessCount }
}
