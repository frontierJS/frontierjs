// src/core/workbench-diff.ts — a pinned checkout's working tree against HEAD,
// or a branch's against the commit it was cut from, for the workbench's diff panel.
//
// The tree, not the run: another session may share the checkout, so what a
// run changed and what the tree holds are not separable from git alone. The
// panel says so rather than claiming the lines as the run's.
//
// Git is called the way `core/local-git.ts` calls it — `core.fsmonitor` pinned
// off, `--no-optional-locks`, the path one argv element after `-C`. An
// untracked file has no diff, so it is read and drawn as all added.
//
// Every list is capped. A run that regenerates a lockfile or a snapshot can
// change a hundred thousand lines, and the panel is a card in a grid.

import { execFileSync }                   from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join }                           from 'node:path'

export type DiffLine = { kind: 'add' | 'del' | 'ctx', text: string, old: number | null, new: number | null }
export type DiffHunk = { header: string, lines: DiffLine[] }
export type DiffFile = {
  path:   string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'binary'
  adds:   number
  dels:   number
  hunks:  DiffHunk[]
  /** Lines past `MAX_FILE_LINES` were left out; `adds`/`dels` still count them. */
  cut:    boolean
}

export const MAX_FILES       = 150
export const MAX_FILE_LINES  = 600
export const MAX_TOTAL_LINES = 6000
const MAX_UNTRACKED_BYTES    = 64 * 1024

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/**
 * `git diff` output → files. A hunk is consumed by its header's line counts,
 * because a removed line reading `-- x` is `--- x` in the diff and would
 * otherwise read as the next file's header.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLeft = 0, newLeft = 0, oldAt = 0, newAt = 0

  for (const line of text.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('\\')) continue
      const sign = line[0]
      const body = line.slice(1)
      if (sign === '+')      { addLine(file!, hunk, { kind: 'add', text: body, old: null, new: newAt++ }); newLeft-- }
      else if (sign === '-') { addLine(file!, hunk, { kind: 'del', text: body, old: oldAt++, new: null }); oldLeft-- }
      else                   { addLine(file!, hunk, { kind: 'ctx', text: body, old: oldAt++, new: newAt++ }); oldLeft--; newLeft-- }
      continue
    }
    const head = line.match(/^diff --git a\/(.*) b\/(.*)$/)
    if (head) {
      file = { path: head[2], status: 'modified', adds: 0, dels: 0, hunks: [], cut: false }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (line.startsWith('new file mode'))     { file.status = 'added';   continue }
    if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue }
    if (line.startsWith('Binary files') || line === 'GIT binary patch') { file.status = 'binary'; continue }
    const m = line.match(HUNK)
    if (m) {
      oldAt   = Number(m[1]); oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newAt   = Number(m[3]); newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk    = { header: line, lines: [] }
      file.hunks.push(hunk)
    }
  }
  return files
}

function addLine(file: DiffFile, hunk: DiffHunk, line: DiffLine) {
  if (line.kind === 'add') file.adds++
  if (line.kind === 'del') file.dels++
  if (file.cut) return
  if (lineCount(file) >= MAX_FILE_LINES) { file.cut = true; return }
  hunk.lines.push(line)
}

const lineCount = (f: DiffFile) => f.hunks.reduce((n, h) => n + h.lines.length, 0)

function git(root: string, argv: string[]): string | null {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '--no-optional-locks', '-C', root, ...argv], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { return null }
}

function untrackedFile(root: string, path: string): DiffFile {
  const file: DiffFile = { path, status: 'untracked', adds: 0, dels: 0, hunks: [], cut: false }
  let buf: Buffer
  try {
    const size = statSync(join(root, path)).size
    const fd = openSync(join(root, path), 'r')
    try {
      buf = Buffer.alloc(Math.min(size, MAX_UNTRACKED_BYTES))
      readSync(fd, buf, 0, buf.length, 0)
    } finally { closeSync(fd) }
    if (size > MAX_UNTRACKED_BYTES) file.cut = true
  } catch { return file }
  if (buf.includes(0)) { file.status = 'binary'; return file }
  const lines = buf.toString('utf8').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const hunk: DiffHunk = { header: `@@ -0,0 +1,${lines.length} @@`, lines: [] }
  file.hunks.push(hunk)
  const wasCut = file.cut
  lines.forEach((text, i) => addLine(file, hunk, { kind: 'add', text, old: null, new: i + 1 }))
  file.cut ||= wasCut
  return file
}

/**
 * The working tree against `base`, untracked files included. `cut` says some
 * file or line was left out of the answer; `files` counts what the tree has.
 */
export function readDiff(root: string, base = 'HEAD'): { files: DiffFile[], total: number, cut: boolean } {
  const tracked   = parseUnifiedDiff(git(root, ['diff', base, '--no-color', '--no-ext-diff', '--no-renames', '-U3']) ?? '')
  const untracked = (git(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean)
  const total     = tracked.length + untracked.length

  const files: DiffFile[] = []
  let lines = 0
  let cut   = total > MAX_FILES
  for (const f of tracked) {
    if (files.length >= MAX_FILES) break
    files.push(f)
    lines += lineCount(f)
  }
  for (const path of untracked) {
    if (files.length >= MAX_FILES) break
    files.push(untrackedFile(root, path))
    lines += lineCount(files.at(-1)!)
  }

  // Past the total, a file keeps its counts and loses its lines; the panel
  // still lists it, so nothing the tree holds is missing from the list.
  if (lines > MAX_TOTAL_LINES) {
    let kept = 0
    for (const f of files) {
      const n = lineCount(f)
      if (kept + n > MAX_TOTAL_LINES) { f.hunks = []; f.cut = true; continue }
      kept += n
    }
    cut = true
  }
  return { files, total, cut: cut || files.some(f => f.cut) }
}
