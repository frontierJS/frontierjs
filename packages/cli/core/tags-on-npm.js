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
import { hosts }                    from './publish-hosts.js'

const TIMEOUT = 5_000

// Versions written into source that a machine installs, from npm or else the
// release host (`FJS-D1989`). A pin follows the tree's bump, and the bump is not
// the publish.
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

/** The version npm's `latest` tag names, or null where it could not be asked:
 *  `outpost:status` says a box's pin is behind it, never that it is current. */
export async function latestOn(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`,
      { signal: AbortSignal.timeout(TIMEOUT) })
    return res.ok ? (await res.json())?.version ?? null : null
  } catch { return null }
}

/** Each install pin with the version its source names; a pin whose file or
 *  constant is gone is left out. */
export function readInstallPins(root) {
  return INSTALL_PINS.flatMap(({ file, name, constant, pattern }) => {
    const path    = join(root, file)
    const version = existsSync(path) ? pattern.exec(readFileSync(path, 'utf8'))?.[1] : null
    return version ? [{ file, name, constant, version }] : []
  })
}

/**
 * Each install pin a release left behind: the run shipped `name@shipped`
 * and the pin names another version. The pin is moved by hand after the publish,
 * never in it (`FJS-D1773`), and this is what says the move is owed (`FJS-D1941`): the
 * 2026-11-04 release shipped outpost@0.1.11 with the pin still at 0.1.9.
 *
 * @param {string[]} published `<name>@<version>` the run put on the release host
 */
export function pinsToMove(root, published = []) {
  const shipped = new Map(published.map(e => [e.slice(0, e.lastIndexOf('@')), e.slice(e.lastIndexOf('@') + 1)]))
  return readInstallPins(root)
    .filter(pin => shipped.has(pin.name) && shipped.get(pin.name) !== pin.version)
    .map(pin => ({ ...pin, shipped: shipped.get(pin.name) }))
}

/** Each install pin older than npm's `latest`, for a release whose own reminder
 *  went unread. A registry that cannot be asked says nothing. */
export async function pinsBehindLatest(root, { latest = latestOn } = {}) {
  const pins = readInstallPins(root)
  const answers = await Promise.all(pins.map(pin => latest(pin.name)))
  return pins
    .map((pin, i) => ({ ...pin, latest: answers[i] }))
    .filter(pin => pin.latest && Bun.semver.order(pin.version, pin.latest) < 0)
}

/**
 * Every `<name>@<version>` tag on a member's current version, and every install
 * pin, that neither npm nor the release host holds. A tag shipped `--to tarballs`
 * (ws:pub's default, `FJS-D1613`) is finished with npm never asked to hold it,
 * and a machine installs a pin from npm and falls back to the release (`FJS-D1989`).
 *
 * @returns {{ lacking: [{ name, version, from }], unknown: [{ name, version, from }], asked: number }}
 *   `from` is `tag` or the pin's `file`
 */
export async function tagsNpmLacks(root, { ask = onRegistry, askRelease = hosts(root).tarballs } = {}) {
  const tags = new Set((gitOut(root, ['tag', '--list', '*@*']) ?? '').split('\n').filter(Boolean))
  const wanted = workspaceMembers(root)
    .filter(m => !m.private && m.version && tags.has(`${m.name}@${m.version}`))
    .map(m => ({ name: m.name, version: m.version, from: 'tag' }))

  for (const pin of readInstallPins(root)) wanted.push({ ...pin, from: pin.file })

  const key    = (w) => `${w.name}@${w.version}`
  const askAll = async (list, asker) => {
    const out = new Map()
    await Promise.all([...new Set(list.map(key))].map(async k => {
      const at = k.lastIndexOf('@')
      out.set(k, await asker(k.slice(0, at), k.slice(at + 1)))
    }))
    return out
  }

  // The release host is asked only about a version npm did not hold: held on
  // npm is finished, and a gh call per package is the cost of a `fli done`.
  const npm      = await askAll(wanted, ask)
  const released = await askAll(wanted.filter(w => npm.get(key(w)) !== true), askRelease)

  const held = (w) => {
    const onNpm = npm.get(key(w)), rel = released.get(key(w))
    if (onNpm === true || rel === true) return true
    return onNpm === false && rel === false ? false : null
  }

  return {
    lacking: wanted.filter(w => held(w) === false),
    unknown: wanted.filter(w => held(w) === null),
    asked:   new Set(wanted.map(key)).size,
  }
}
