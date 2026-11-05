// ─── workspace-members.js — who is in the workspace, one owner ───────────────
//
// The root package.json `workspaces` list is the only statement of what a
// member IS. A walker that lists `packages/` one level deep answers a different
// question, and the day a member lives two levels down (`packages/conduits/
// conduit-stripe`) it silently stops seeing it: no error, a shorter list.
//
// The list stays explicit (`FJS-D1911`) and this reads exactly the two forms
// it uses -- a literal path and a one-level `X/*`. Anything else (`**`, a
// negation, a mid-path star) is refused by name rather than dropped, because a
// pattern this does not understand would otherwise shrink the member list in
// silence. No glob engine on purpose.
//
// A leaf: node:fs, node:path and ./fs.js only, so `checks.js` and the scripts
// that run before install can import it.

import { join, resolve } from 'node:path'
import { SKIP, safeRead, isDir, readJson } from './fs.js'

/**
 * One workspace member (`FJS-D1910`).
 *
 * @typedef {object} WorkspaceMember
 * @property {string} name     package.json `name` (the folder when it has none)
 * @property {string} folder   the directory's basename -- display, and the typecheck-baseline key
 * @property {string} path     root-relative with forward slashes, e.g. `packages/conduits/conduit-stripe`
 * @property {string} dir      absolute
 * @property {object} manifest the parsed package.json
 */

/**
 * Every workspace member under `root`, in the order the `workspaces` list gives
 * and alphabetical within one `X/*`. A directory a glob matches that has no
 * package.json is NOT a member -- that is what keeps a bare grouping folder out
 * -- and neither is a missing literal, a dot-directory or a SKIP directory.
 * `[]` when `root` has no package.json or no `workspaces` list.
 *
 * Not cached: it is ~30 small reads and a fixture that writes a package
 * between two calls must see it.
 *
 * @param {string} root the workspace root
 * @returns {WorkspaceMember[]}
 */
export function workspaceMembers(root) {
  const out  = []
  const seen = new Set()
  for (const entry of workspaceGlobs(root)) {
    const paths = entry.endsWith('/*')
      ? childFolders(root, entry.slice(0, -2)).map(f => `${entry.slice(0, -2)}/${f}`)
      : [entry]
    for (const path of paths) {
      if (seen.has(path)) continue
      const dir      = resolve(root, path)
      const manifest = isDir(dir) ? readJson(join(dir, 'package.json')) : null
      if (!manifest) continue
      seen.add(path)
      const folder = path.slice(path.lastIndexOf('/') + 1)
      out.push({ name: manifest.name ?? folder, folder, path, dir, manifest })
    }
  }
  return out
}

/** The member named `name` (package name), or undefined. */
export function memberByName(root, name) { return workspaceMembers(root).find(m => m.name === name) }

/** The member at root-relative `path` (`packages/cli`), or undefined. */
export function memberByPath(root, path)  { return workspaceMembers(root).find(m => m.path === path) }

/**
 * The members that live under `packages/` and are not nested inside another
 * member -- the releasable set, without the apps (`example`, `website`) and the
 * examples a package carries (`packages/sierra/example`) that the root
 * `workspaces` list also names.
 */
export function packageMembers(root) {
  const all = workspaceMembers(root)
  return all.filter(m => m.path.startsWith('packages/') && !all.some(o => o !== m && m.path.startsWith(`${o.path}/`)))
}

/**
 * The member a root-relative file belongs to: the one whose `path` is the
 * longest prefix of `file`, or undefined. `parts[1]` of `packages/conduits/
 * conduit-x/src/a.js` names the grouping folder, not the package, so a walker
 * that attributes a file reads this against a member list it fetched once.
 *
 * @param {WorkspaceMember[]} members
 * @param {string} file root-relative, forward slashes
 */
export function memberOfFile(members, file) {
  let best
  for (const m of members) {
    if (file.startsWith(`${m.path}/`) && (!best || m.path.length > best.path.length)) best = m
  }
  return best
}

// The array form, or yarn's `{ packages: [...] }`. Trailing slashes and a
// leading `./` are spelling, not meaning.
function workspaceGlobs(root) {
  const raw  = readJson(join(root, 'package.json'))?.workspaces
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : []
  return list.map(e => String(e).replace(/^\.\//, '').replace(/\/+$/, '')).map(entry => {
    const stars = entry.replace(/\/\*$/, '')
    if (entry.startsWith('!') || stars.includes('*')) {
      throw new Error(`workspaces entry "${entry}": only a literal path and a one-level "X/*" are read (FJS-D1911)`)
    }
    return entry
  })
}

function childFolders(root, parent) {
  const dir = resolve(root, parent)
  return safeRead(dir).filter(n => !SKIP.has(n) && !n.startsWith('.') && isDir(join(dir, n)))
}
