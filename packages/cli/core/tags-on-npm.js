// ─── tags-on-npm.js — a version tagged and never published ───────────────────
//
// ws:pub's publish step reads a skip as *the next run publishes it*, so a tagged
// version can sit off npm with nothing saying so, and a pin elsewhere in the
// tree that followed the bump names a version no machine can install
// (`FJS-3534`: Basecamp's OUTPOST_VERSION at an outpost npm never had, so every
// enrollment's unit failed its first start). `fli done` asks, not CI, so CI never
// depends on the registry (`FJS-D1598`).
//
// Plain ESM, zero dependencies beyond its neighbors.

import { existsSync, readFileSync } from 'node:fs'
import { join }                     from 'node:path'
import { gitOut }                   from './git.js'
import { workspaceMembers }         from './publish-view.js'

const TIMEOUT = 5_000

// Versions written into source that a machine installs from npm. A pin follows
// the tree's bump, and the bump is not the publish.
export const INSTALL_PINS = [
  { file: 'packages/basecamp/api/src/providers/compute/enrollment.ts', name: '@frontierjs/outpost',
    constant: 'OUTPOST_VERSION', pattern: /\bOUTPOST_VERSION\s*=\s*'([^']+)'/ },
]

/**
 * Does npm hold `name@version` — true, false, or NULL where it could not be
 * asked. A fetch rather than `npm view`: thirty spawned npm processes is the
 * cost of a `fli done`, and every package here is public.
 */
export async function onRegistry(name, version) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`,
      { signal: AbortSignal.timeout(TIMEOUT) })
    if (res.status === 404) return false
    return res.ok ? true : null
  } catch { return null }
}

/**
 * Every `<name>@<version>` tag on a member's current version, and every install
 * pin, that npm does not hold.
 *
 * @returns {{ lacking: [{ name, version, from }], unknown: [{ name, version, from }], asked: number }}
 *   `from` is `tag` or the pin's `file`
 */
export async function tagsNpmLacks(root, { ask = onRegistry } = {}) {
  const tags = new Set((gitOut(root, ['tag', '--list', '*@*']) ?? '').split('\n').filter(Boolean))
  const wanted = workspaceMembers(root)
    .filter(m => !m.private && m.version && tags.has(`${m.name}@${m.version}`))
    .map(m => ({ name: m.name, version: m.version, from: 'tag' }))

  for (const pin of INSTALL_PINS) {
    const path = join(root, pin.file)
    const version = existsSync(path) ? pin.pattern.exec(readFileSync(path, 'utf8'))?.[1] : null
    if (version) wanted.push({ name: pin.name, version, from: pin.file, constant: pin.constant })
  }

  const answers = new Map()
  const key = (w) => `${w.name}@${w.version}`
  await Promise.all([...new Set(wanted.map(key))].map(async k => {
    const at = k.lastIndexOf('@')
    answers.set(k, await ask(k.slice(0, at), k.slice(at + 1)))
  }))

  return {
    lacking: wanted.filter(w => answers.get(key(w)) === false),
    unknown: wanted.filter(w => answers.get(key(w)) === null),
    asked:   answers.size,
  }
}
