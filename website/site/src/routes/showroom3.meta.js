// site/src/routes/showroom3.meta.js — the ripple's data, built.
//
// Both halves are prerendered. The five edits and everything each one moves are
// in the file, and so is the eighteen-seam request path, which was never
// interactive at all — it was built by JavaScript only because everything else
// on the page was.

import { CHANGES, HOPS } from '../data/showroom3.js'
import { line, esc } from '../data/code.js'

export async function load() {
  return {
    changes: CHANGES.map((c) => {
      const moved = c.hits.filter((h) => h.moved).length
      return {
        id:    c.id,
        label: c.label,
        // Every edit on this page is to the seed, and the page draws its own
        // +/- stripes, so glow's line prefixes stay off (code.js) — a `-` here
        // is a removed FIELD and the character is part of the diff, not a marker.
        diff:  c.diff.map(([kind, src]) => ({ kind, html: line(src, 'lite') })),
        moved,
        // The count that did NOT move is half the argument the page makes, so
        // it is carried rather than derived in the markup.
        still: c.hits.length - moved,
        hits:  c.hits.map((h) => ({ ...h })),
      }
    }),
    // A seam whose name is a call gets `<code>`; the rest are prose.
    hops: HOPS.map((h) => ({
      r:     h.r,
      name:  h.name.includes('(') ? `<code>${esc(h.name)}</code>` : esc(h.name),
      where: h.where,
      say:   h.say,
    })),
    first: CHANGES.some((c) => c.id === 'field') ? 'field' : CHANGES[0].id,
  }
}
