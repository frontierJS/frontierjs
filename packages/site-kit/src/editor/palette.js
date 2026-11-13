// src/editor/palette.js — what the editor's command palette (Cmd/Ctrl+K) lists.
//
// The pages are the draft's route files, because an owner editing a page wants
// to reach the next one without leaving the editor, and a click on a link is a
// pick. A page is named by the words of a link to it on this page (the menu's
// "About us"), the address otherwise; home is Home, since a link to it is a
// logo or a copyright line.

import { routeFile } from './pick.js'

/**
 * The address Sierra writes a route file to, or null for a file no address
 * reaches: one outside routes, one with a parameter, a `_` file (ksite's
 * `_module.md`), and `404.md`, written as `404.html`.
 * The inverse of `routeFile`: `x.md` and `x/index.md` are `/x/`, a `(group)` is
 * not part of the address.
 * @param {string} file
 */
export function pageAddress(file) {
  const m = /^content\/routes\/(.+)\.md$/.exec(file)
  if (!m || /\[|(^|\/)_/.test(m[1]) || m[1] === '404') return null
  const p = m[1].replace(/(^|\/)\([^/]+\)(?=\/)/g, '').replace(/^\/+/, '').replace(/(^|\/)index$/, '')
  return p ? `/${p}/` : '/'
}

/**
 * Every page of the draft as `{ address, label, file, here }`, home first, then
 * address order.
 * @param {string[]} files — the draft's editable files
 * @param {{ pathname: string, text: string }[]} links — the page's same-site links
 * @param {string} pathname — this page's address
 */
export function pagesOf(files, links, pathname) {
  const named = new Map()
  for (const l of links) {
    const at = routeFile(l.pathname, files)
    const text = l.text.replace(/\s+/g, ' ').trim()
    if (at && text && text.length <= 60 && !named.has(at)) named.set(at, text)
  }
  const here = routeFile(pathname, files)
  return files
    .map((file) => ({ file, address: pageAddress(file) }))
    .filter((p) => p.address)
    .map((p) => ({ ...p, label: p.address === '/' ? 'Home' : named.get(p.file) ?? p.address, here: p.file === here }))
    .sort((a, b) => (a.address === '/' ? -1 : b.address === '/' ? 1 : a.address.localeCompare(b.address)))
}

/**
 * The commands whose words hold every term of the query, in their own order.
 * @template {{ label: string, hint?: string, group: string }} C
 * @param {C[]} commands
 * @param {string} query
 * @returns {C[]}
 */
export function matching(commands, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((c) => {
    const text = `${c.group} ${c.label} ${c.hint ?? ''}`.toLowerCase()
    return terms.every((t) => text.includes(t))
  })
}
