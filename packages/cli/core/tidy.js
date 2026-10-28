// ─── tidy.js — what piles up in a working tree, read in one pass ─────────────
//
// The reader behind `fli tidy`. Five piles, each of which grows in silence
// because nothing that adds to it ever reads it back:
//
//   records    § Closed and HANDOFF.md past their keep — `archive.js` moves them
//   worktrees  git worktrees whose directory is gone, or that sit in a temp dir
//   strays     a SQLite file outside every `<app>/db/` (Invariant 3) — a
//              process started from the wrong directory, or a path bug
//   tmp        temp entries this repo's own `mkdtemp` calls named, grouped by
//              prefix with the file that makes them
//   bulky      ignored directories past `BULKY` bytes. A `target/` beside a
//              Cargo.toml is a build cache cargo never prunes, so it carries
//              its `cargo clean` and any binary the crate no longer names — a
//              renamed crate leaves the old build's whole dependency tree
//
// Nothing here deletes. `--apply` runs the two moves `archive.js` owns and
// `git worktree prune`, which removes only entries whose directory is already
// gone; every other pile is reported, because a gitignored `.db` in this tree
// is as often somebody's dev data as it is debris.
//
// Zero dependencies, plain ESM, node or bun.

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, sep, extname }        from 'node:path'
import { execFileSync }                       from 'node:child_process'
import { gitOut }                             from './git.js'
import { tmpdir }                             from 'node:os'

import { archiveClosed, rotateHandoff } from './archive.js'
import { crateName }                    from './desktop-surface.js'

export const BULKY = 500 * 1024 * 1024

const git = (root, args) => gitOut(root, args) ?? ''
const z = text => text.split('\0').filter(Boolean)

export function tidy({ root, registerRoot = root, apply = false }) {
  const records = {
    handoff: rotateHandoff({ root: registerRoot, dry: !apply }),
    closed:  archiveClosed({ root: registerRoot, dry: !apply }),
  }
  const worktrees = readWorktrees(root)
  if (apply && worktrees.some(w => w.prunable)) git(root, ['worktree', 'prune'])
  return { applied: apply, records, worktrees, strays: strays(root), tmp: tmpPiles(root), bulky: bulky(root) }
}

// ─── worktrees ────────────────────────────────────────────────────────────────

// Every worktree but the one being read from. `prunable` is git's own word for
// a worktree whose directory is gone.
function readWorktrees(root) {
  const tmp = tmpRoots()
  return git(root, ['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).slice(1).map(block => {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    return {
      path,
      head:     block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? 'detached',
      prunable: /^prunable/m.test(block),
      inTmp:    tmp.some(t => path?.startsWith(t + sep)),
    }
  })
}

// ─── strays ───────────────────────────────────────────────────────────────────

// A db directory is one holding a `schema.lite`. A SQLite file belongs to the
// nearest one above it unless a further `db/` sits between them — `db/db/` is
// a process started inside `db/`. A dot-directory is a tool's own state
// (`.wrangler` keeps miniflare's databases), never an app's.
function strays(root) {
  const homes = z(git(root, ['ls-files', '-co', '--exclude-standard', '-z', '--', '*schema.lite']))
    .map(f => dirname(f))
  const files = z(git(root, ['ls-files', '-o', '-i', '--exclude-standard', '-z', '--',
    '*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite3']))
    .filter(f => !f.split('/').some(s => s === 'node_modules' || s.startsWith('.')))

  const byDir = new Map()
  for (const file of files) {
    const home = homes.filter(h => h === '.' || file.startsWith(h + '/')).sort((a, b) => b.length - a.length)[0]
    const rest = home == null ? null : (home === '.' ? file : file.slice(home.length + 1)).split('/').slice(0, -1)
    if (rest && !rest.includes('db')) continue
    const dir = dirname(file)
    const st  = statOr(join(root, file))
    const row = byDir.get(dir) ?? { dir, files: 0, bytes: 0, newest: 0 }
    row.files++
    row.bytes += st?.size ?? 0
    row.newest = Math.max(row.newest, st?.mtimeMs ?? 0)
    byDir.set(dir, row)
  }
  return [...byDir.values()].sort((a, b) => b.bytes - a.bytes)
}

// ─── tmp ──────────────────────────────────────────────────────────────────────

const MKDTEMP = /mkdtemp(?:Sync)?\(\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*['"`]([A-Za-z0-9._-]{4,})/g

function tmpRoots() {
  return [...new Set([tmpdir(), '/tmp'].filter(d => existsSync(d)))]
}

// The prefixes come from the source, so a new leaking suite is named the day it
// lands. An entry matches its LONGEST prefix — `litestone-` and
// `litestone-audit-host-` are two different writers.
function tmpPiles(root) {
  const sources = new Map()
  for (const line of git(root, ['grep', '-nE', 'mkdtemp', '--', '*.js', '*.mjs', '*.ts', ':!**/node_modules/**', ':!**/dist*/**']).split('\n')) {
    const at = line.match(/^([^:]+):(\d+):/)
    if (!at) continue
    for (const m of line.matchAll(MKDTEMP)) if (!sources.has(m[1])) sources.set(m[1], `${at[1]}:${at[2]}`)
  }
  const prefixes = [...sources.keys()].sort((a, b) => b.length - a.length)
  const uid = process.getuid?.()

  const piles = new Map()
  let entries = 0
  for (const dir of tmpRoots()) {
    let names
    try { names = readdirSync(dir) } catch { continue }
    entries += names.length
    for (const name of names) {
      const prefix = prefixes.find(p => name.startsWith(p))
      if (!prefix) continue
      const st = statOr(join(dir, name))
      if (!st || (uid != null && st.uid !== uid)) continue
      const pile = piles.get(prefix) ?? { prefix, dir, count: 0, oldest: Infinity, source: sources.get(prefix) }
      pile.count++
      pile.oldest = Math.min(pile.oldest, st.mtimeMs)
      piles.set(prefix, pile)
    }
  }
  return { entries, piles: [...piles.values()].sort((a, b) => b.count - a.count) }
}

// ─── bulky ────────────────────────────────────────────────────────────────────

function bulky(root) {
  const dirs = z(git(root, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']))
    .filter(p => p.endsWith('/') && !p.split('/').includes('node_modules'))
  if (!dirs.length) return []
  let out = ''
  try { out = execFileSync('du', ['-sk', ...dirs], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 }) }
  catch (err) { out = err.stdout ?? '' }
  return out.split('\n').filter(Boolean)
    .map(l => { const [kb, path] = l.split('\t'); return { path, bytes: Number(kb) * 1024 } })
    .filter(r => r.bytes >= BULKY)
    .map(r => ({ ...r, cargo: cargoCache(root, r.path) }))
    .sort((a, b) => b.bytes - a.bytes)
}

function cargoCache(root, path) {
  const target = join(root, path)
  const toml   = join(dirname(target), 'Cargo.toml')
  if (!path.endsWith('target/') || !existsSync(toml)) return null
  const crate  = crateName(toml)
  const stale  = []
  for (const profile of ['debug', 'release']) {
    let names
    try { names = readdirSync(join(target, profile), { withFileTypes: true }) } catch { continue }
    for (const e of names) {
      if (!e.isFile() || extname(e.name) || e.name === crate) continue
      if (statSync(join(target, profile, e.name)).mode & 0o111) stale.push(`${profile}/${e.name}`)
    }
  }
  return { crate, stale, clean: `cargo clean --manifest-path ${relativeTo(root, toml)}` }
}

function relativeTo(root, abs) {
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function statOr(abs) {
  try { return statSync(abs) } catch { return null }
}
