// ─── fs.js — reading the tree, one spelling ──────────────────────────────────
//
// Every helper here answers a missing or unreadable path with an empty value
// rather than a throw: a directory that vanished between listing and reading
// is not a finding, and each caller had its own try/catch saying so.
//
// A listing is SORTED. Filesystem order differs between machines, so a check,
// a snapshot or a page built off an unsorted listing reorders on someone
// else's disk and reads as a change nobody made.
//
// A leaf: node:fs and node:path only, so `checks.js`, which may run before
// install, can import it.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative }                     from 'node:path'

/** Directories no walk descends into — build output and other people's code. */
export const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.output', '.vite'])

/** A directory's entry names, sorted; [] when it cannot be listed. */
export function safeRead(dir) { try { return readdirSync(dir).sort() } catch { return [] } }

export function isDir(path)    { try { return statSync(path).isDirectory() } catch { return false } }

/** A file's text, or null — never '' — so an empty file and a missing one stay two answers. */
export function read(path)     { try { return readFileSync(path, 'utf8') } catch { return null } }

export function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/**
 * `p` from `root`, with forward slashes, so a finding names the same file on every
 * machine. A path outside root, or one already relative, comes back as given: a
 * `../` path is a different question, and resolving a relative one would answer
 * from process.cwd. Root itself is ''.
 */
export function rel(root, p) {
  if (!p || !isAbsolute(p)) return p
  const r = relative(root, p)
  return r.startsWith('..') || isAbsolute(r) ? p : r.split('\\').join('/')
}

/**
 * `fn(dir)` for a directory and every directory under it to `depth`, parents
 * first, skipping SKIP and dot-directories.
 */
export function walk(dir, depth, fn) {
  if (depth < 0 || !existsSync(dir)) return
  try { fn(dir) } catch { /* an unreadable directory is not a finding */ }
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const child = join(dir, name)
    try { if (statSync(child).isDirectory()) walk(child, depth - 1, fn) } catch { /* dangling link */ }
  }
}
