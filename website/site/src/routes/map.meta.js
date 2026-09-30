// site/src/routes/map.meta.js — the territory map: a picture, and where each
// package sits on it.
//
// The picture carries its own lettering, and lettering in a raster is invisible
// to a crawler and a screen reader. So every territory's words come from
// packages.js at build time and are prerendered as a list below the map; the
// map's hotspots link into that list, and the island moves the same entry into
// a panel over the map. The picture adds nothing a reader cannot get without it.
//
// Coordinates are in the IMAGE's pixels (1499 × 976), which is the SVG's own
// viewBox, so they hold at every zoom. A sharper image at the same aspect ratio
// drops in with no change here; a re-drawn one needs every ellipse re-traced.

import { loadFJS, HELD_BACK } from '../data/packages.js'

const IMAGE = { src: '/map/territory.webp', width: 1499, height: 976 }

// `status` is for a territory with no package page, and is required there —
// without it the entry would show a name and nothing else.
const TERRITORIES = [
  { id: 'litestone',     cx: 393,  cy: 398, rx: 162, ry: 97 },
  { id: 'junction',      cx: 745,  cy: 408, rx: 135, ry: 88 },
  { id: 'sierra',        cx: 1095, cy: 408, rx: 145, ry: 92 },
  { id: 'mesa',          cx: 1092, cy: 685, rx: 128, ry: 57 },
  { id: 'css',           cx: 912,  cy: 560, rx: 117, ry: 47 },
  { id: 'ui',            cx: 1132, cy: 558, rx: 102, ry: 48 },
  { id: 'email-kit',     cx: 1342, cy: 560, rx: 97,  ry: 50 },
  { id: 'auth',          cx: 577,  cy: 200, rx: 80,  ry: 62 },
  { id: 'caravan',       cx: 757,  cy: 208, rx: 92,  ry: 66 },
  { id: 'conduit',       cx: 125,  cy: 197, rx: 118, ry: 66 },
  { id: 'notifications', cx: 372,  cy: 200, rx: 116, ry: 62 },
  { id: 'mcp',           cx: 937,  cy: 208, rx: 82,  ry: 66,
    name: 'MCP', realm: 'API · the agent surface',
    pitch: 'An MCP endpoint over a running app, with the gate as the permission model.',
    status: HELD_BACK['@frontierjs/mcp'] },
  { id: 'orion',         cx: 1097, cy: 205, rx: 76,  ry: 64,
    name: 'Orion', realm: 'Automations',
    pitch: 'Flows of triggers, conditions and actions, run by an engine installed into the app.',
    status: HELD_BACK['@frontierjs/orion'] },
  { id: 'cli',           cx: 550,  cy: 602, rx: 145, ry: 78 },
  { id: 'toolbelt',      cx: 870,  cy: 842, rx: 175, ry: 40 },
  { id: 'basecamp',      cx: 1258, cy: 245, rx: 93,  ry: 88 },
  { id: 'outpost',       cx: 1425, cy: 268, rx: 66,  ry: 72 },
  { id: 'oracle',        cx: 157,  cy: 525, rx: 107, ry: 75,
    name: 'Oracle', realm: 'Substrate',
    pitch: 'Entity and pattern recognition.',
    status: 'Claimed, not built — version two, owed nothing until the core leaves alpha.' },
]

export async function load() {
  const { PKGS } = await loadFJS()

  const territories = TERRITORIES.map((t) => {
    const pkg = PKGS.find((p) => p.id === t.id)
    if (!pkg && !t.status) {
      throw new Error(
        `[map] territory '${t.id}' names no package in packages.js and states no status. ` +
        `Rename it to the package's id, or give it a status saying why it has no page.`
      )
    }
    return {
      id: t.id, cx: t.cx, cy: t.cy, rx: t.rx, ry: t.ry,
      name:     pkg?.name  ?? t.name,
      realm:    pkg?.realm ?? t.realm,
      pitch:    pkg?.pitch ?? t.pitch,
      features: (pkg?.rows ?? []).map((r) => r.k),
      href:     pkg ? '/' + pkg.page.replace(/\.html$/, '') + '/' : null,
      status:   pkg ? null : t.status,
    }
  })

  return { image: IMAGE, territories }
}
