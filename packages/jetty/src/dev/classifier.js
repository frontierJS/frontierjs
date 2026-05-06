// classifier.js — file path → dev WS event.
//
// Runs server-side when chokidar reports a change. Returns a structured
// event the WS server broadcasts to connected clients. Clients react per
// event.kind:
//
//   - 'extension:reload'   → chrome.runtime.reload() (full ext reload)
//   - 'page:reload'        → location.reload() in the affected Page
//   - 'island:reload-tabs' → harbor calls chrome.tabs.reload() for matches
//   - 'rebuild'            → a non-runtime file changed; rebuild bundle
//   - 'noop'               → ignore (e.g. files we don't care about)
//
// Decision tree, top-down (first match wins):
//
//   1. config/jetty.config.js     → extension:reload (manifest may have changed)
//   2. src/harbor/**              → extension:reload
//   3. src/islands/<id>.js        → island:reload-tabs (per-island)
//   4. src/dock/**                → page:reload (target='dock')
//   5. src/options/**             → page:reload (target='options')
//   6. src/piers/<id>/**          → page:reload (target=`pier:<id>`)
//   7. public/**                  → extension:reload (assets in dist)
//   8. anything else under src/   → rebuild (Vite handles HMR for Pages,
//                                            but custom extensions via
//                                            shared/ etc. need rebuild)
//
// Note: Vite HMR handles per-component .mesa updates inside Pages
// AUTOMATICALLY without our intervention — Vite's own dev server WS is
// separate from ours. Our classifier only fires when a change can't be
// hot-replaced by Vite alone.

import { posix, sep } from 'node:path'

export function classifyChange({ relPath, found }) {
  // Normalize separators — chokidar may give backslashes on Windows.
  const p = relPath.split(sep).join('/')

  // 1. Config
  if (p === 'config/jetty.config.js') {
    return { kind: 'extension:reload', reason: 'config:changed', file: p }
  }

  // 2. Harbor
  if (p.startsWith('src/harbor/')) {
    return { kind: 'extension:reload', reason: 'harbor:changed', file: p }
  }

  // 3. Islands — exactly src/islands/<id>.js (flat layout, per discover.js)
  const islandMatch = p.match(/^src\/islands\/([^/]+)\.js$/)
  if (islandMatch) {
    const id = islandMatch[1]
    const island = found?.islands?.find((i) => i.id === id)
    if (island) {
      return { kind: 'island:reload-tabs', islandId: id, file: p }
    }
    // File matches the path pattern but isn't a discovered island (yet).
    // A full rebuild + reload picks it up.
    return { kind: 'extension:reload', reason: 'island:added', file: p }
  }

  // 4. Dock — .mesa changes get HMR; other files trigger full reload.
  if (p.startsWith('src/dock/')) {
    if (p.endsWith('.mesa')) {
      return { kind: 'mesa:hot-update', target: 'dock', moduleId: p, file: p }
    }
    return { kind: 'page:reload', target: 'dock', file: p }
  }

  // 5. Options
  if (p.startsWith('src/options/')) {
    if (p.endsWith('.mesa')) {
      return { kind: 'mesa:hot-update', target: 'options', moduleId: p, file: p }
    }
    return { kind: 'page:reload', target: 'options', file: p }
  }

  // 6. Piers
  const pierMatch = p.match(/^src\/piers\/([^/]+)\//)
  if (pierMatch) {
    if (p.endsWith('.mesa')) {
      return { kind: 'mesa:hot-update', target: `pier:${pierMatch[1]}`, moduleId: p, file: p }
    }
    return { kind: 'page:reload', target: `pier:${pierMatch[1]}`, file: p }
  }

  // 7. Public assets — get copied into dist; extension reload picks them up.
  if (p.startsWith('public/')) {
    return { kind: 'extension:reload', reason: 'public:changed', file: p }
  }

  // 8. Anything else under src/ — rebuild bundle but don't broadcast a
  //    reload event. Vite's own HMR handles in-page hot updates; Phase 5
  //    rebuild path is for shared/ code that affects multiple targets.
  if (p.startsWith('src/')) {
    return { kind: 'rebuild', file: p }
  }

  return { kind: 'noop', file: p }
}
