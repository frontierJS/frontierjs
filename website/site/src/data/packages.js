// site/src/data/packages.js — read the site's package data, do not restate it.
//
// `website/packages.js` is the single source of truth for what every package
// is and what it replaces, and its own header says so: a feature is written
// once. It is a CLASSIC script that assigns `window.FJS`, deliberately — the
// legacy hand-written pages open straight from the repo, and a browser blocks
// a module import over file://.
//
// So this evaluates it rather than importing it, and rather than keeping a
// second copy in module syntax. A copy would be the failure the original file
// exists to prevent, and it would go stale the first time a feature is added.
// The whole cost is a fake `window` and one `AsyncFunction`.
//
// It runs at BUILD time only: `[pkg].meta.js` is a companion, so nothing here
// enters the browser graph. What a package page ships is HTML.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE   = dirname(fileURLToPath(import.meta.url))
const SOURCE = resolve(HERE, '../../../packages.js')

let cached = null

/** `window.FJS` — `{ PKGS, esc, hl, theme, SWATCHES, SWATCH_HEX }`. */
export async function loadFJS() {
  if (cached) return cached

  const src = await readFile(SOURCE, 'utf8')
  const win = {}
  // `document` is referenced by the `theme` helper's body, which is never
  // called here. Declared so the IIFE's own top level cannot trip over it if
  // that ever changes.
  const run = new Function('window', 'document', `${src}\nreturn window.FJS`)
  cached = run(win, undefined)

  if (!cached?.PKGS?.length) {
    throw new Error(
      `[website] ${SOURCE} did not assign window.FJS.PKGS. ` +
      `It is a classic script assigning one global — see its header.`
    )
  }
  return cached
}
