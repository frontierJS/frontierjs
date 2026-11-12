// ─── home.js — every per-user entry fli writes, and what is on disk ──────────
//
// `paths.js` says WHERE the four roots are; this says WHAT lives in them. One
// catalog, so `fli doctor`, a Disk screen and a Keys screen read the same list
// instead of each keeping a string of their own: a hand-written table drifts
// from the writers, and an entry nobody listed is an entry nobody can size,
// clear or check the mode of. A test fails when a join under a root names an
// entry this file lacks.
//
// `homeReport()` walks the roots and never reads a file's contents -- a report
// that touched values could leak a key into a log or a page. Sizes cost a walk
// of every file (0.85 s for 110k files), so they are opt-in and `fli doctor`
// never asks.
//
// Not here: Workbench's own root (`~/.config/workbench`) is its package's.
//
// Zero dependencies beyond `paths.js`, plain ESM, node or bun.

import { lstatSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, dataDir, cacheDir, stateDir } from './paths.js'

const ROOTS = { config: configDir, data: dataDir, cache: cacheDir, state: stateDir }

const row = (root, name, what, writer, { secret = false, reclaim = null, pattern = null } = {}) =>
  ({ root, name, what, writer, secret, reclaim, pattern })

/**
 * One row per known top-level entry. `name` is relative to its root; `pattern`
 * matches a family of names (`registry-<key>.json`) that `name` only labels.
 * `reclaim` is how a Disk screen may free it: `clear` for a cache, `remove-lane`
 * for a lane, else `null` (a person decides).
 */
export const entries = [
  // ─── config ──────────────────────────────────────────────────────────────
  row('config', '.env',           'Global environment variables, loaded under every project\'s own .env.',   'core/global-env.js', { secret: true }),
  row('config', 'commands',       'Your own fli commands, found beside the package\'s.',                     'core/registry.js'),
  row('config', 'profiles',       'One env file per client profile, loaded when a project or the shell sets FLI_PROFILE.', 'core/global-env.js', { secret: true }),
  row('config', 'basecamps.json', 'The index of Basecamps this machine made, with each one\'s admin key.',   'core/basecamps.js',  { secret: true }),
  row('config', 'basecamp',       'One directory per Basecamp holding a copy of its keys.',                  'core/basecamp.js',   { secret: true }),
  row('config', 'config.json',    'The Frontier member settings: nick, box and the post key.',               'core/tell.js',       { secret: true }),
  row('config', 'autopilot.json', 'The schedule and caps for the unattended loops.',                         'core/autopilot.js'),

  // ─── data ────────────────────────────────────────────────────────────────
  row('data', 'basecamp', 'Backups pulled from each Basecamp, one directory per box, never pruned.', 'core/basecamp.js'),

  // ─── cache ───────────────────────────────────────────────────────────────
  row('cache', 'registry-<key>.json', 'A compiled command registry per source set; rebuilt on demand.', 'core/registry.js', { reclaim: 'clear', pattern: /^registry-[0-9a-f]+\.json$/ }),
  row('cache', 'release',     'The cargo build of fli top.',                  'commands/utils/top.md', { reclaim: 'clear' }),
  row('cache', 'fli-top-c',   'The compiled fli top fallback binary.',        'commands/utils/top.md', { reclaim: 'clear' }),

  // ─── state ───────────────────────────────────────────────────────────────
  row('state', 'holds',             'One file per tree an agent holds, so two sessions do not edit one.', 'core/guard.js'),
  row('state', 'lanes',             'One worktree per fix-loop lane, plus the patches they produce.',     'scripts/lanes.mjs', { reclaim: 'remove-lane' }),
  row('state', 'registers',         'A register cache per project, keyed by a hash of its root.',         'core/registers.js'),
  row('state', 'register-<key>.guard', 'The lock around one register rebuild.',                           'core/registers.js', { pattern: /^register-.+\.guard$/ }),
  // The names are `autopilot.js`'s `LOOPS`; a pattern here, because a second spelling of them is a log some reader never learns.
  row('state', '<loop>-loop.jsonl',   'One line per event of an unattended loop.',                          'scripts/headless.mjs', { pattern: /^[a-z]+-loop\.jsonl$/ }),
  row('state', 'fix-trial-<id>.jsonl', 'The log of one fix-loop trial run.',                                'scripts/fix-loop.mjs', { pattern: /^fix-trial-.+\.jsonl$/ }),
  row('state', 'fix-loop-review.md', 'The reviewer\'s notes on the last fix-loop attempts.',              'scripts/loop-review.mjs'),
  row('state', 'sessions.lock',     'Which sessions hold which ports.',                                   'core/ports.js'),
  row('state', 'stress',            'Sites the stress loop built.',                                       'scripts/stress-loop.mjs'),
  row('state', 'feed',              'The feed loop\'s working files and locks.',                          'scripts/feed-loop.mjs'),
  row('state', 'frontier',          'This member\'s key, chain, peers and last check -- key.json signs for you.', 'core/tell.js', { secret: true }),
  row('state', 'haven',             'Haven\'s agents, reports and API log; key.json is its signing key.', 'commands/haven/walk.md', { secret: true }),
]

const matches = (e, name) => e.pattern ? e.pattern.test(name) : e.name === name

/** The catalog rows for one root. */
export const entriesOf = (root) => entries.filter(e => e.root === root)

/** The names of one root's entries, for a line that says what it holds. */
export const holdsOf = (root) => entriesOf(root).map(e => e.name)

/** Whether a mode lets anyone but the owner in. */
export const exposed = (mode) => (mode & 0o077) !== 0

const bytesUnder = (path) => {
  let st
  try { st = lstatSync(path) } catch { return 0 }
  if (!st.isDirectory()) return st.size
  let total = 0
  let names = []
  try { names = readdirSync(path) } catch { return 0 }
  for (const n of names) total += bytesUnder(join(path, n))
  return total
}

const octal = (mode) => (mode & 0o777).toString(8).padStart(3, '0')

const statOf = (path) => {
  try { return statSync(path) } catch {}
  try { return lstatSync(path) } catch { return null }
}

const present = (root, name, path, { sizes }) => {
  const st = statOf(path)
  if (!st) return null
  const known = entriesOf(root).find(e => matches(e, name))
  return {
    root, name, path,
    ...(known ? { what: known.what, writer: known.writer, secret: known.secret, reclaim: known.reclaim, known: true }
              : { what: null, writer: null, secret: false, reclaim: null, known: false }),
    present: true,
    mode:    octal(st.mode),
    mtime:   st.mtime.toISOString(),
    ...(sizes ? { bytes: bytesUnder(path) } : {}),
  }
}

/**
 * Walk the four roots one level deep.
 *
 * @param {object}  o
 * @param {string}  o.home   pins every root under one directory, as `paths.js` takes it
 * @param {boolean} o.sizes  also total each entry's bytes (recursive); off by default
 * @returns {{ roots: Record<string, { path: string, exists: boolean, entries: object[] }>, walkMs: number }}
 */
export function homeReport({ home, sizes = false } = {}) {
  const t0  = performance.now()
  const out = {}
  for (const [root, dirOf] of Object.entries(ROOTS)) {
    const path = dirOf({ home })
    let names = null
    try { names = readdirSync(path) } catch {}
    const rows = (names ?? []).map(n => present(root, n, join(path, n), { sizes })).filter(Boolean)

    // A secret that is absent still gets a row: a Keys screen shows what is
    // missing as well as what is there.
    for (const e of entriesOf(root)) {
      if (!e.secret || e.pattern || rows.some(r => r.name === e.name)) continue
      rows.push({
        root, name: e.name, path: join(path, e.name),
        what: e.what, writer: e.writer, secret: true, reclaim: e.reclaim, known: true,
        present: false, mode: null, mtime: null,
        ...(sizes ? { bytes: 0 } : {}),
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    out[root] = { path, exists: names !== null, entries: rows }
  }
  return { roots: out, walkMs: Math.round(performance.now() - t0) }
}
