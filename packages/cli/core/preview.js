// ─── preview.js — a preview branch changes the UI and nothing else ──────────
//
// A preview serves the branch's `web/` against production's API, so a branch
// that has moved `db/`, `api/` or a `.lite` file is previewing against a schema
// production does not have, and merging it ships a change nobody reviewed as
// one. The ask panel's edit scope keeps its own runs inside `web/`; this is
// what says nothing else reached the branch either — an owner's commit, or a
// file the Workbench's fork carried over from a dirty parent.
//
// A worktree is a preview when its private git directory holds `fjs-preview`
// (`git rev-parse --git-path`). Not in the tree: a file there is a change, and
// Submit would commit it into the pull request. The Workbench's Open writes it
// through `markPreview`, so the name has one spelling.
//
// The diff is graded from where HEAD meets `origin/HEAD` — the branch the pull
// request merges into — so it is the diff a reviewer reads, carried files and
// unpushed parent commits included. Untracked files count: Submit commits them.
//
// `fli check`'s `preview-ui-only` and the ask panel's Submit both call
// `previewScope`, so the two cannot disagree about what a preview may hold.
//
// Zero dependencies, plain ESM: `checks.js` runs on node.

import { gitOut }                        from './git.js'
import { existsSync, writeFileSync }     from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const MARKER = 'fjs-preview'

const git = (cwd, argv) => gitOut(cwd, ['-c', 'core.quotePath=false', ...argv])

const paths = out => out.split('\0').filter(Boolean)

/** Where `dir`'s worktree keeps the marker, or null outside a git checkout. */
export function markerPath(dir) {
  return git(dir, ['rev-parse', '--path-format=absolute', '--git-path', MARKER])?.trim() || null
}

/** Make `dir`'s worktree a preview. Answers the marker's path. */
export function markPreview(dir) {
  const marker = markerPath(dir)
  if (!marker) throw new Error(`${dir} is not in a git checkout, so it cannot be marked a preview`)
  writeFileSync(marker, '')
  return marker
}

/**
 * What a preview worktree holds outside `scope`, the one directory it may change.
 *
 *   { preview: false, why }              not a preview — nothing to grade
 *   { preview: true, why }               a preview whose diff cannot be read
 *   { preview: true, into, top, outside } `outside` relative to the checkout top
 */
export function previewScope(dir, scope) {
  const marker = markerPath(dir)
  if (!marker) return { preview: false, why: 'not in a git checkout' }
  if (!existsSync(marker)) return { preview: false, why: `no ${MARKER} marker in this worktree's git directory` }

  const top  = git(dir, ['rev-parse', '--show-toplevel'])?.trim()
  const into = git(dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD'])?.trim()
  if (!into || into === 'origin/HEAD') {
    return { preview: true, why: 'origin/HEAD is not set, so nothing says what the pull request merges into — `git remote set-head origin --auto`' }
  }
  const base = git(dir, ['merge-base', 'HEAD', into])?.trim()
  if (!base) return { preview: true, why: `this branch shares no history with ${into}` }

  const within = relative(top, resolve(scope))
  if (within.startsWith('..') || isAbsolute(within)) return { preview: true, why: `${scope} is not inside the checkout at ${top}` }

  const changed = git(top, ['diff', '--name-only', '--no-renames', '-z', base])
  const added   = git(top, ['ls-files', '-z', '--others', '--exclude-standard'])
  if (changed == null || added == null) return { preview: true, why: `git could not diff this worktree against ${into}` }

  const inside  = p => within === '' || p === within || p.startsWith(within + '/')
  const outside = [...new Set([...paths(changed), ...paths(added)])].filter(p => !inside(p)).sort()
  return { preview: true, into, top, outside }
}
