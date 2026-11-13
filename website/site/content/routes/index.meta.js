// The home page's word cloud is the landscape's, built from the same register —
// one loader, so the two pages cannot read projects.json two ways. The package
// grid reads packages.js, the list every package page is built from.
//
// public/icons is a symlink to brand/assets/icons: a static page is prerendered
// outside Vite, so an image import never resolves to a URL, and a copy would
// drift from the brand folder the first time an icon is redrawn.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as landscape } from './why/landscape.meta.js'
import { loadFJS, hrefFor, folderByName } from '../data/packages.js'

// Three tile sizes, by slug and in this order. A package named in none of
// them lands at the end of the third, so a new one is never hidden.
const TIERS = [
  ['litestone', 'junction', 'sierra', 'fli', 'basecamp', 'conduit', 'css', 'workbench'],
  ['mesa', 'auth', 'caravan', 'ui'],
  ['testing', 'notifications', 'mcp', 'orion', 'outpost', 'create-frontier',
   'toolbelt', 'config', 'email-kit', 'print-kit', 'jetty', 'vscode'],
]
const NAMED = TIERS.flat()

const ICONS = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons')

export async function load(ctx) {
  const { PKGS } = await loadFJS()
  const folders = await folderByName()
  const tile = (p) => {
    const folder = folders.get(p.who) ?? p.id
    // A traced SVG wins over the PNG; a package with neither shows its initial.
    const file = [`${folder}.svg`, `${folder}.png`].find((f) => existsSync(`${ICONS}/${f}`))
    return {
      name: p.slug,
      href: hrefFor(p),
      icon: file ? `/icons/${file}` : null,
    }
  }
  return {
    ...(await landscape(ctx)),
    packages: TIERS.map((slugs, i) => ({
      key:   `tier${i + 1}`,
      items: [
        ...slugs.map((slug) => PKGS.find((p) => p.slug === slug)).filter(Boolean),
        ...(i === TIERS.length - 1 ? PKGS.filter((p) => !NAMED.includes(p.slug)) : []),
      ].map(tile),
    })),
  }
}
