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

// The big tiles, by slug and in this order. Every other package follows in
// the small grid, so a new one is never hidden.
const PRIMARY = ['litestone', 'junction', 'sierra', 'fli', 'basecamp', 'conduit', 'css', 'workbench']
const REST = [
  'mesa', 'auth', 'caravan', 'ui', 'testing', 'notifications', 'mcp', 'orion',
  'outpost', 'create-frontier', 'toolbelt', 'config', 'email-kit', 'print-kit', 'jetty', 'vscode',
]
const rank = (p) => (REST.indexOf(p.slug) + 1) || REST.length + 1

const ICONS = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons')

export async function load(ctx) {
  const { PKGS } = await loadFJS()
  const folders = await folderByName()
  const tile = (p) => {
    const folder = folders.get(p.who) ?? p.id
    return {
      name: p.slug,
      href: hrefFor(p),
      // A package with no icon yet shows its initial instead of a broken image.
      icon: existsSync(`${ICONS}/${folder}.png`) ? `/icons/${folder}.png` : null,
    }
  }
  return {
    ...(await landscape(ctx)),
    packages: [
      { key: 'primary', items: PRIMARY.map((slug) => PKGS.find((p) => p.slug === slug)).filter(Boolean).map(tile) },
      { key: 'rest',    items: PKGS.filter((p) => !PRIMARY.includes(p.slug)).sort((a, b) => rank(a) - rank(b)).map(tile) },
    ],
  }
}
