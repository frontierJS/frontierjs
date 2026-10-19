// core/gitignore.js
// Would git commit this path? Read from the `.gitignore` files themselves, so it
// answers for a tree that is not a repository yet (a scaffold, a test fixture),
// where `git check-ignore` has nothing to ask.
//
// `build-check.js` has a matcher too, and it is Docker's: every pattern is
// anchored at the context root. Git's is not — `*.db` and `audit/` match at any
// depth, a trailing `/` matches a directory only, and a pattern holding a slash
// is the anchored one — so reusing that matcher would call `db/audit/` committed
// under a `.gitignore` that says `audit/`.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { compileGlob } from './build-check.js'

/** The patterns of one `.gitignore`, in file order. */
function parseGitignore(text) {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    if (negate) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.includes('/')
    line = line.replace(/^\//, '')
    const re = line ? compileGlob(line) : null
    if (re) out.push({ negate, dirOnly, anchored, re })
  }
  return out
}

/** Every `.gitignore` from the repository root (or the filesystem's) down to `dir`, outermost first. */
function gitignoresFor(dir) {
  const found = []
  for (let d = resolve(dir); ; d = dirname(d)) {
    const file = join(d, '.gitignore')
    if (existsSync(file)) found.unshift({ dir: d, patterns: parseGitignore(readFileSync(file, 'utf8')) })
    if (existsSync(join(d, '.git')) || dirname(d) === d) break
  }
  return found
}

/**
 * Is `path` (absolute, inside `root`'s tree) ignored by the `.gitignore` files
 * that apply to it? `null` when no `.gitignore` applies at all, since "nothing
 * says" is a different answer from "nothing matched".
 *
 * Git cannot re-include a file whose parent directory is excluded, so each
 * ancestor is decided first and an ignored one settles the rest.
 */
export function ignoredByGit(root, path, isDir) {
  const files = gitignoresFor(root)
  if (!files.length) return null

  const parts = relative(files[0].dir, resolve(path)).split(sep)
  if (parts[0] === '..') return null

  for (let n = 1; n <= parts.length; n++) {
    const last = n === parts.length
    let ignored = false
    for (const { dir, patterns } of files) {
      const rel = relative(dir, join(files[0].dir, ...parts.slice(0, n)))
      if (rel.startsWith('..')) continue
      const segments = rel.split(sep)
      for (const p of patterns) {
        if (p.dirOnly && last && !isDir) continue
        const hit = p.anchored ? p.re.test(segments.join('/')) : p.re.test(segments.at(-1))
        if (hit) ignored = !p.negate
      }
    }
    if (ignored) return true
  }
  return false
}
