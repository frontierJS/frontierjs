// site/src/data/packages.js — read the site's package data, do not restate it.
//
// `website/packages.js` is the single source of truth for what every package
// is and what it replaces, and its own header says so: a feature is written
// once. It is a CLASSIC script that assigns `window.FJS`.
//
// So this evaluates it rather than importing it, and rather than keeping a
// second copy in module syntax. A copy would be the failure the original file
// exists to prevent, and it would go stale the first time a feature is added.
// The whole cost is a fake `window` and one `AsyncFunction`.
//
// It runs at BUILD time only: `[pkg].meta.js` is a companion, so nothing here
// enters the browser graph. What a package page ships is HTML.

import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { range } from './pin.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const SOURCE   = resolve(HERE, '../../../packages.js')
const PACKAGES = resolve(HERE, '../../../../packages')

/*
 * A package the workspace publishes and this site does not describe is a silent
 * hole: the build is green, the stack page is complete-looking, and the only
 * symptom is a visitor who never learns the thing exists. Fourteen of them sat
 * that way. So the set is compared rather than trusted, and holding one back is
 * a named entry with a reason — which goes stale loudly, because deleting the
 * reason is the fix once the package is ready to be described.
 *
 * A `private` package is out of the walk by its own manifest and needs no entry
 * here; the first version of this list carried one and the check refused it.
 */
export const HELD_BACK = {
  '@frontierjs/orion': 'mid-port and never released to npm, so a page would hand a visitor an install that 404s',
}

let cached = null

/** `window.FJS` — `{ PKGS, esc, hl, theme, SWATCHES, SWATCH_HEX }`. */
export async function loadFJS() {
  if (cached) return cached

  const src = await readFile(SOURCE, 'utf8')
  const win = {}
  // `document` is referenced by the `theme` helper's body, which is never
  // called here. Declared so the IIFE's own top level cannot trip over it if
  // that ever changes.
  // `range` is the one thing the script cannot know for itself: the version an
  // install command pins, which lives in the package's manifest (see pin.js).
  const run = new Function('window', 'document', 'range', `${src}\nreturn window.FJS`)
  cached = run(win, undefined, range)

  if (!cached?.PKGS?.length) {
    throw new Error(
      `[website] ${SOURCE} did not assign window.FJS.PKGS. ` +
      `It is a classic script assigning one global — see its header.`
    )
  }

  await assertEveryPublishablePackageIsDescribed(cached.PKGS)
  return cached
}

/**
 * Every `@frontierjs/*` the workspace publishes has an entry here, or a reason
 * not to.
 *
 * The count is asserted before the difference is: an empty walk and a complete
 * site produce the same empty diff, and only one of them is good news.
 */
async function assertEveryPublishablePackageIsDescribed(pkgs) {
  const described = new Set(pkgs.map((p) => p.who))
  const publishable = []

  for (const folder of await readdir(PACKAGES)) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(PACKAGES, folder, 'package.json'), 'utf8')) }
    catch { continue }
    if (manifest.private !== true && manifest.name) publishable.push(manifest.name)
  }

  if (publishable.length < 10) {
    throw new Error(
      `[website] read ${publishable.length} publishable package(s) under ${PACKAGES}. ` +
      `That is a broken walk, not a small workspace.`
    )
  }

  const missing = publishable.filter((name) => !described.has(name) && !(name in HELD_BACK))
  if (missing.length) {
    throw new Error(
      `[website] published, and described nowhere on this site:\n` +
      missing.map((n) => `  · ${n}`).join('\n') +
      `\n\nAdd an entry to website/packages.js, or a reason to HELD_BACK in ${'site/src/data/packages.js'}.`
    )
  }

  const stale = Object.keys(HELD_BACK).filter((name) => described.has(name) || !publishable.includes(name))
  if (stale.length) {
    throw new Error(
      `[website] HELD_BACK names ${stale.join(', ')}, which is now described or no longer published. ` +
      `Delete the entry.`
    )
  }
}
