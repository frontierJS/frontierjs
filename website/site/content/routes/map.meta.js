// site/content/routes/map.meta.js — the territory map: a picture, and where each
// package sits on it.
//
// The picture carries its own lettering, and lettering in a raster is invisible
// to a crawler and a screen reader. So every territory's words come from
// packages.js at build time and are prerendered as a list below the map; the
// map's hotspots link into that list, and the island moves the same entry into
// a panel over the map. The picture adds nothing a reader cannot get without it.
//
// Coordinates are in the IMAGE's pixels (2560 × 1707), which is the SVG's own
// viewBox, so they hold at every zoom. A sharper image at the same aspect ratio
// drops in with no change here; a re-drawn one needs every ellipse re-traced.

import { loadFJS, HELD_BACK } from '../data/packages.js'

const IMAGE = { src: '/map/territory.webp', width: 2560, height: 1707 }

// `status` is for a territory with no package page, and is required there —
// without it the entry would show a name and nothing else.
const TERRITORIES = [
  { id: 'litestone',      cx: 699,  cy: 666,  rx: 251, ry: 169 },
  { id: 'junction',       cx: 1272, cy: 671,  rx: 225, ry: 159 },
  { id: 'sierra',         cx: 1823, cy: 691,  rx: 225, ry: 143 },
  { id: 'mesa',           cx: 1874, cy: 1165, rx: 197, ry: 115 },
  { id: 'css',            cx: 1562, cy: 952,  rx: 195, ry: 102 },
  { id: 'ui',             cx: 1920, cy: 947,  rx: 154, ry: 92 },
  { id: 'email-kit',      cx: 2278, cy: 947,  rx: 179, ry: 102 },
  { id: 'auth',           cx: 996,  cy: 358,  rx: 131, ry: 115 },
  { id: 'caravan',        cx: 1295, cy: 374,  rx: 148, ry: 105 },
  { id: 'conduit',        cx: 251,  cy: 346,  rx: 205, ry: 110 },
  { id: 'notifications',  cx: 655,  cy: 356,  rx: 197, ry: 113 },
  { id: 'mcp',            cx: 1597, cy: 387,  rx: 143, ry: 113 },
  { id: 'orion',          cx: 1874, cy: 374,  rx: 133, ry: 108,
    name: 'Orion', realm: 'Automations',
    pitch: 'Flows of triggers, conditions and actions, run by an engine installed into the app.',
    status: HELD_BACK['@frontierjs/orion'] },
  { id: 'cli',            cx: 986,  cy: 978,  rx: 230, ry: 133 },
  { id: 'toolbelt',       cx: 1324, cy: 1439, rx: 486, ry: 90 },
  { id: 'basecamp',       cx: 2138, cy: 430,  rx: 154, ry: 146 },
  { id: 'outpost',        cx: 2412, cy: 466,  rx: 120, ry: 123 },
  { id: 'oracle',         cx: 300,  cy: 896,  rx: 210, ry: 128,
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
