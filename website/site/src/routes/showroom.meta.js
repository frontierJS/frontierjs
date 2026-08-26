// site/src/routes/showroom.meta.js — the showroom's build-time data.
//
// Everything the page shows is highlighted here and baked into the file: the
// seed, one span per line, and all seventeen derived panels. The hand-written
// version built every one of them from JavaScript on load, so the page a
// crawler saw was three empty divs.

import { SCHEMA, FIELDS, RULES, CHIPS } from '../data/showroom.js'
import { block, line, esc, langOf } from '../data/code.js'

const TONE = { Data: 'primary', API: 'info', UI: 'success' }

export async function load() {
  return {
    // One node per line, because the page lights individual ones.
    schema: SCHEMA.map((src, i) => ({ i, html: line(src, 'lite') })),
    fields: FIELDS,
    rules:  RULES,
    // Grouped by realm, in first-appearance order, which is the reading order
    // the page is written in — Data, then API, then UI, then what is proposed.
    realms: [...new Set(CHIPS.map((c) => c.realm))].map((realm) => ({
      realm,
      label: realm === 'Soon' ? 'Direction — not yet built' : `${realm} realm`,
      chips: CHIPS.filter((c) => c.realm === realm)
        .map((c) => ({ id: c.id, label: c.label, soon: !!c.soon })),
    })),
    panels: CHIPS.map((c) => ({
      id:    c.id,
      label: c.label,
      realm: c.soon ? 'proposed' : c.realm,
      tone:  c.soon ? 'warning' : (TONE[c.realm] ?? 'success'),
      blurb: c.blurb,
      from:  esc(c.from),
      code:  block(c.code, langOf(c.lang, c.code)),
      lines: c.lines,
    })),
    first: CHIPS.some((c) => c.id === 'migration') ? 'migration' : CHIPS[0].id,
  }
}
