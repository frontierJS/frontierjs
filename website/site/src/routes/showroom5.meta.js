// site/src/routes/showroom5.meta.js — the stack page's data.
//
// Same source as the package pages: `website/packages.js`, read once at build
// time. The page it feeds prerenders EVERY feature row and every detail panel,
// where the hand-written version built all of it from JavaScript on load — so
// this page had the same problem the eight package stubs had, and the fix is
// the same one.

import { loadFJS } from '../data/packages.js'
import { block, sniff } from '../data/code.js'

const slugFor = (p) => p.page.replace(/\.html$/, '')

export async function load() {
  const { PKGS } = await loadFJS()

  const group = (id, rows) => ({
    id,
    rows: rows.map((r, i) => ({
      i,
      k:        r.k,
      v:        r.v,                        // already HTML — may carry <code>
      why:      r.why,
      code:     r.code ? block(r.code, sniff(r.code)) : null, // already HTML
      replaces: r.r ?? [],
    })),
  })

  return {
    packages: PKGS.map((p) => ({
      id:    p.id,
      slug:  slugFor(p),
      name:  p.name,
      realm: p.realm,
      tone:  p.tone,
      who:   p.who,
      pitch: p.pitch,
      groups: [
        group(p.id, p.rows),
        ...(p.extra ? [{ ...group(p.id + 'x', p.extra.rows), title: p.extra.title }] : []),
      ],
      chips: (p.chips ?? []).map(([heading, terms]) => ({ heading, terms: terms.split(' ') })),
    })),
  }
}
