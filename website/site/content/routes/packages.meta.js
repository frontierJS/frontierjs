// site/content/routes/packages.meta.js — the package index, from packages.js.
//
// The list is read from the same data the package pages are, so a package
// added there appears here without an edit.

import { loadFJS } from '../data/packages.js'

export async function load() {
  const { PKGS } = await loadFJS()
  return {
    pkgs: PKGS.map((p) => ({
      slug:  p.page.replace(/\.html$/, ''),
      name:  p.name,
      realm: p.realm,
      tone:  p.tone,
      pitch: p.pitch,
    })),
  }
}
