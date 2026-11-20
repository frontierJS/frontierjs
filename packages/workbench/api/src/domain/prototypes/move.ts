// src/domain/prototypes/move.ts — move a recorded prototype to another folder, and its history with it.
//
// A repo's identity is its record's name, but three things on this machine are
// keyed by its PATH (`IDEAS/prototypes-catalog.md` § What exists):
//   - its record's `path` in CATALOG.json
//   - Claude Code's history, `<claude dir>/projects/<path with every non-alphanumeric as ->`,
//     one folder per directory a session started in, the repo's subfolders included
//   - the `cwd` every transcript line records, which Workbench's Claude screens
//     and Import read as where a session ran (`FJS-D2279`)
//   - every relative symlink inside it that points outside it: bun links
//     `@frontierjs/*` into node_modules as `../../../../frontierjs/packages/auth`,
//     and a destination at another depth leaves every one of them dangling
// A move updates all four, or refuses before touching any of them.
//
// The folder name cannot be decoded: `lynx-spike-device` is a sibling repo of
// `lynx-spike`, not its `device/` folder. So a history folder belongs to the repo
// only when the cwd its transcripts recorded is the repo or under it.
//
// Refused, with nothing moved:
//   - a record that does not exist, or whose folder is gone or is a linked worktree
//   - a destination folder that does not exist, or that already holds the name
//   - a checkout Workbench has pinned: its chats, logs and branches are keyed by a
//     hash of the path (`pinId`), so the pin goes first
//   - a process whose working directory is inside the repo: a dev server or a
//     Claude session would keep writing to the old history folder
//   - a history folder whose new name is already taken

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { workbenchDir } from '../../core/env.ts'
import { claudeConfigDir } from '../claude/claude-scan.ts'
import { projectFolderName } from '../claude/claude-context.ts'
import { expandPath, readCatalog, writeRecord } from './catalog.ts'

export type MoveOptions = {
  /** The prototypes folder (CATALOG.json's parent's parent); `prototypesDir()` when absent. */
  dir?:       string
  /** Workbench's own directory, for pins.json. */
  wb?:        string
  /** Claude Code's config directory, for `projects/`. */
  claudeDir?: string
  /** The working directory of every other process on this machine; /proc when absent. */
  cwds?:      () => string[]
}

export type MovedHistory = { from: string, to: string, transcripts: number }
export type Moved = { name: string, from: string, to: string, path: string, histories: MovedHistory[], links: number, worktrees: boolean }

const isDir   = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }
const under   = (p: string, root: string) => p === root || p.startsWith(root + '/')
const rebase  = (p: string, from: string, to: string) => to + p.slice(from.length)
const tilde   = (p: string) => under(p, homedir()) ? '~' + p.slice(homedir().length) : p

/** Every other process's working directory, from /proc. Off Linux there is no /proc and no check. */
function procCwds(): string[] {
  let pids: string[]
  try { pids = readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid) } catch { return [] }
  const out: string[] = []
  for (const pid of pids) { try { out.push(readlinkSync(`/proc/${pid}/cwd`)) } catch { /* gone, or not ours to read */ } }
  return out
}

function pinnedPaths(wb: string): string[] {
  try {
    const pins = JSON.parse(readFileSync(join(wb, 'pins.json'), 'utf8'))?.pins
    return Array.isArray(pins) ? pins.map(p => p?.path).filter((p): p is string => typeof p === 'string') : []
  } catch { return [] }
}

const HEAD = 64 * 1024

/** The first `cwd` a transcript records, from its head; null when none does. */
function firstCwd(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(HEAD)
    const text = buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD, 0))
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue
      try { const o = JSON.parse(line); if (typeof o?.cwd === 'string') return o.cwd } catch { /* a line cut by the head */ }
    }
  } catch { /* unreadable: no answer */ } finally { if (fd !== null) closeSync(fd) }
  return null
}

const transcripts = (folder: string): string[] =>
  (readdirSync(folder, { recursive: true }) as string[]).filter(n => n.endsWith('.jsonl')).map(n => join(folder, n))

/**
 * The history folders that belong to `src`: the one its path names, and every
 * `<that>-…` folder whose sessions started under `src`. The one its path names
 * may hold only `memory/`, so it belongs unless a transcript says otherwise.
 */
export function historiesOf(src: string, projects: string): Array<{ folder: string, cwd: string }> {
  let names: string[]
  try { names = readdirSync(projects) } catch { return [] }
  const own = projectFolderName(src)
  const out: Array<{ folder: string, cwd: string }> = []
  for (const name of names) {
    if (name !== own && !name.startsWith(own + '-')) continue
    const folder = join(projects, name)
    if (!isDir(folder)) continue
    const cwd = transcripts(folder).map(firstCwd).find((c): c is string => !!c) ?? (name === own ? src : null)
    if (cwd && under(cwd, src) && projectFolderName(cwd) === name) out.push({ folder, cwd })
  }
  return out
}

/**
 * Every line whose top-level `cwd` is under `from` gets it rebased onto `to`; no
 * other byte changes. Written beside the file and renamed over it, with its
 * times kept: Workbench orders sessions by mtime. A line that does not survive a
 * parse-and-print unchanged is left as written. Returns how many files changed.
 */
export function rewriteCwds(folder: string, from: string, to: string): number {
  let changed = 0
  for (const file of transcripts(folder)) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes(JSON.stringify(from).slice(0, -1))) continue
    let touched = false
    const lines = text.split('\n').map(line => {
      if (!line.includes('"cwd"')) return line
      let o: { cwd?: unknown }
      try { o = JSON.parse(line) } catch { return line }
      if (typeof o?.cwd !== 'string' || !under(o.cwd, from) || JSON.stringify(o) !== line) return line
      touched = true
      return JSON.stringify({ ...o, cwd: rebase(o.cwd, from, to) })
    })
    if (!touched) continue
    const { atime, mtime } = statSync(file)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, lines.join('\n'))
    renameSync(tmp, file)
    utimesSync(file, atime, mtime)
    changed++
  }
  return changed
}

/**
 * Every relative symlink under `root` whose target lies outside it, as the link's
 * path inside `root` and the absolute target it resolves to. Directories are not
 * followed through a link, and `.git` is skipped.
 */
export function outwardLinks(root: string): Array<{ at: string, target: string }> {
  const out: Array<{ at: string, target: string }> = []
  const walk = (dir: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!(dir === root && e.name === '.git')) walk(p); continue }
      if (!e.isSymbolicLink()) continue
      let link: string
      try { link = readlinkSync(p) } catch { continue }
      if (isAbsolute(link)) continue
      const target = resolve(dir, link)
      if (!under(target, root)) out.push({ at: relative(root, p), target })
    }
  }
  walk(root)
  return out
}

/** Move the recorded prototype `name` into the folder `into`, keeping its folder name. */
export function movePrototype(name: string, into: string, o: MoveOptions = {}): Moved | { refused: string } {
  const catalog = readCatalog(o.dir)
  if (catalog.error) return { refused: `${catalog.error} — fix it by hand before moving anything` }
  const rec = Object.hasOwn(catalog.records, name) ? catalog.records[name] : undefined
  if (!rec) return { refused: `no prototype is recorded as '${name}'` }

  const src = expandPath(rec.path)
  if (!isDir(src)) return { refused: `${name}'s folder ${src} is gone, so there is nothing to move — fix its path instead` }
  if (existsSync(join(src, '.git')) && !isDir(join(src, '.git')))
    return { refused: `${src} is a linked worktree; move it with git worktree move` }

  const parent = expandPath(into.trim())
  if (!isAbsolute(parent)) return { refused: `'${into}' must start with / or ~/` }
  if (!isDir(parent)) return { refused: `the folder ${parent} does not exist — make it first` }
  const dest = join(parent, basename(src))
  if (dest === src) return { refused: `${name} is already in ${parent}` }
  if (under(dest, src)) return { refused: `${parent} is inside ${name} itself` }
  if (existsSync(dest)) return { refused: `${dest} already exists` }

  const pinned = pinnedPaths(o.wb || workbenchDir()).find(p => under(p, src))
  if (pinned) return { refused: `${pinned} is pinned in Workbench — unpin it first, or its chats lose their checkout` }
  const busy = (o.cwds ?? procCwds)().find(c => under(c, src))
  if (busy) return { refused: `a process is running in ${busy} — stop it first, or it keeps writing to the old place` }

  const projects = join(o.claudeDir || claudeConfigDir(), 'projects')
  const histories = historiesOf(src, projects).map(h => ({ ...h, next: join(projects, projectFolderName(rebase(h.cwd, src, dest))) }))
  const taken = histories.find(h => existsSync(h.next))
  if (taken) return { refused: `Claude Code already has history at ${taken.next} — merge or remove it first` }

  const links = outwardLinks(src)

  // Past here every step is one the disk already accepted; the repo moves first,
  // and a cross-device rename is the one way it can still refuse.
  try { renameSync(src, dest) } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { refused: code === 'EXDEV' ? `${parent} is on another disk; move it by hand and fix the path` : `could not move ${src}: ${(e as Error).message}` }
  }
  const wrote = writeRecord(name, { path: tilde(dest) }, o.dir)
  if ('refused' in wrote) {
    renameSync(dest, src)
    return { refused: wrote.refused }
  }

  for (const l of links) {
    const at = join(dest, l.at)
    unlinkSync(at)
    symlinkSync(relative(dirname(at), l.target), at)
  }

  const moved: MovedHistory[] = []
  for (const h of histories) {
    renameSync(h.folder, h.next)
    moved.push({ from: h.folder, to: h.next, transcripts: rewriteCwds(h.next, src, dest) })
  }

  // A main repo's linked worktrees find it by its old path until told.
  const worktrees = isDir(join(dest, '.git', 'worktrees'))
  if (worktrees) spawnSync('git', ['-C', dest, 'worktree', 'repair'], { stdio: 'ignore' })

  return { name, from: src, to: dest, path: tilde(dest), histories: moved, links: links.length, worktrees }
}
