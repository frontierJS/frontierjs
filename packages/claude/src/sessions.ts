// src/sessions.ts — the sessions Claude Code saved for a folder.
//
// Claude Code keeps a session as `<config dir>/projects/<folder>/<uuid>.jsonl`,
// the folder being the working directory with every non-alphanumeric character
// a `-`. `claude --resume <uuid>` finds a session only under the folder it runs
// in, so a session whose recorded cwd is another folder is never offered.
//
// The folder name flattens `/` and `.` alike, so two checkouts can share one
// folder; the `cwd` a transcript records is what decides whose a session is.
//
// The "already held" check is not here: what a chat is, and how a host words a
// refusal, are each host's own.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_ID } from './argv.ts'
import { readMessages } from './messages.ts'
import { claudeConfigDir, read, unreadable, type Read } from './read.ts'

/** A transcript's head is enough for its `cwd` and first prompt; the file can be hundreds of MB. */
const PEEK_BYTES = 128 * 1024
const TITLE_MAX = 60
/** The most sessions a list reads a head of. */
const LIST_MAX = 50

/** Claude Code's folder for a working directory: every character that is not a letter or digit becomes `-`. */
export const encodeCwd = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-')

/** The first line of `text`, cut: a chat's title. */
export function titleOf(text: string): string {
  const line = text.trim().split('\n')[0].trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

export type Peek = {
  cwd:      string
  /** The first prompt's line, else Claude Code's own title; null when the head holds neither. */
  title:    string | null
  at:       string
  /** A `claude -p` run: a machine's work. */
  headless: boolean
}

/** The head of a transcript: where it started and what was asked first; null when it cannot be read or records no `cwd`. */
export function peekSession(path: string): Peek | null {
  try {
    const fd = openSync(path, 'r')
    let text: string
    try {
      const buf = Buffer.allocUnsafe(PEEK_BYTES)
      text = buf.toString('utf8', 0, readSync(fd, buf, 0, PEEK_BYTES, 0))
    } finally { closeSync(fd) }
    const { file } = readMessages(text)
    if (!file.cwd) return null
    const line = file.firstPrompt ? titleOf(file.firstPrompt) : file.title
    return { cwd: file.cwd, title: line || null, at: file.startedAt ?? statSync(path).mtime.toISOString(), headless: file.headless }
  } catch { return null }
}

export type SessionRow = { session: string, title: string, at: string }
export type ListSessionsOptions = { held?: Set<string>, limit?: number, configDir?: string }

/**
 * The sessions started in `cwd` that `held` does not name, newest first. A
 * headless run (`claude -p`) is a machine's work and is left out.
 */
export function listSessions(cwd: string, opts: ListSessionsOptions = {}): SessionRow[] {
  const { held = new Set<string>(), limit = LIST_MAX } = opts
  const folder = join(claudeConfigDir({ configDir: opts.configDir }), 'projects', encodeCwd(cwd))
  let names: string[]
  try { names = readdirSync(folder) } catch { return [] }
  const files = names
    .filter(n => n.endsWith('.jsonl') && SESSION_ID.test(n.slice(0, -6)) && !held.has(n.slice(0, -6)))
    .map(n => { const path = join(folder, n); try { return { path, session: n.slice(0, -6), mtime: statSync(path).mtimeMs } } catch { return null } })
    .filter((f): f is { path: string, session: string, mtime: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime)
  const out: SessionRow[] = []
  for (const f of files) {
    if (out.length >= limit) break
    const head = peekSession(f.path)
    if (!head || head.cwd !== cwd || head.headless) continue
    out.push({ session: f.session, title: head.title ?? `Session ${f.session.slice(0, 8)}`, at: new Date(f.mtime).toISOString() })
  }
  return out
}

export type FoundSession = { session: string, path: string, title: string, startedAt: string, at: string }

/**
 * One session `claude --resume` can pick up from `cwd`. Refused by name for an
 * id that is no session, one with no transcript anywhere in Claude Code's
 * history, one that records no folder, and one that ran in another folder.
 */
export function findSession(cwd: string, session: unknown, opts: { configDir?: string } = {}): Read<FoundSession> {
  const sid = String(session ?? '').trim()
  if (!SESSION_ID.test(sid)) return unreadable(`'${sid}' is not a session id`)
  const projects = join(claudeConfigDir({ configDir: opts.configDir }), 'projects')
  let folders: string[] = []
  try { folders = readdirSync(projects) } catch { /* no Claude Code history here */ }
  const path = folders.map(f => join(projects, f, `${sid}.jsonl`)).find(f => existsSync(f))
  if (!path) return unreadable(`no session '${sid}' in Claude Code's history on this machine`)
  const head = peekSession(path)
  if (!head) return unreadable(`session '${sid}' records no folder to resume it in`)
  if (head.cwd !== cwd) return unreadable(`that session ran in ${head.cwd}, not ${cwd} — Claude Code resumes a session only from the folder it started in`)
  let at: string
  try { at = statSync(path).mtime.toISOString() } catch { return unreadable(`no session '${sid}' in Claude Code's history on this machine`) }
  return read({ session: sid, path, title: head.title ?? `Session ${sid.slice(0, 8)}`, startedAt: head.at, at })
}
