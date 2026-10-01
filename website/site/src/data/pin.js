// site/src/data/pin.js — the version range an install command on this site names.
//
// An unpinned `npx` or `npm create` runs whatever was published last, and on an
// alpha framework that is whatever landed this morning. A number typed into the
// copy is the other failure: nothing regenerates it, and the last one rotted for
// months. So the range is read off the package's own manifest at build time.
//
// Below 1.0 a minor bump is the breaking one, so the range is the minor.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages')

let versions = null

/** `range('@frontierjs/cli')` → `'0.1'`. */
export function range(name) {
  if (!versions) {
    versions = {}
    for (const folder of readdirSync(PACKAGES)) {
      try {
        const m = JSON.parse(readFileSync(join(PACKAGES, folder, 'package.json'), 'utf8'))
        if (m.name && m.version) versions[m.name] = m.version
      } catch {}
    }
  }
  const v = versions[name]
  if (!v) throw new Error(`[website] range('${name}'): no package of that name under ${PACKAGES}.`)
  const [major, minor] = v.split('.')
  return major === '0' ? `${major}.${minor}` : major
}

/** `pinned('@frontierjs/cli')` → `'@frontierjs/cli@0.1'`. */
export const pinned = (name) => `${name}@${range(name)}`
