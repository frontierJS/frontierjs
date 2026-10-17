// ─── export-pairs.js — one spelling per subpath ──────────────────────────────
//
// `./runtime` and `./runtime.js` reaching the same file is an alias by another
// name: READMEs and callers drift onto both, and a rename has to find the pair.
// A pair is two `exports` keys that differ only in a trailing file extension
// and resolve to the same target. `./vocabulary` and `./vocabulary.json` are
// not one — they reach different files, which is why the target is compared.
//
// The spelling kept: a `.mesa` subpath keeps its extension, because a Mesa
// compiler, a prerender and a bundler alias all recognise a component by the
// suffix on the specifier; every other subpath is bare.

const EXT = /\.(?:m?js|json|mesa|css)$/

export const exportPairs = (exportsMap) => {
  if (!exportsMap || typeof exportsMap !== 'object') return []
  const byBare = new Map()
  for (const [key, target] of Object.entries(exportsMap)) {
    if (!key.startsWith('.')) continue
    const bare = key.replace(EXT, '')
    const seen = byBare.get(bare) ?? []
    seen.push({ key, target: JSON.stringify(target) })
    byBare.set(bare, seen)
  }
  const pairs = []
  for (const group of byBare.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].target === group[j].target) pairs.push([group[i].key, group[j].key])
      }
    }
  }
  return pairs
}

// The key of a pair that goes.
export const redundantOf = ([a, b]) => {
  const [bare, withExt] = a.length < b.length ? [a, b] : [b, a]
  return withExt.endsWith('.mesa') ? bare : withExt
}
