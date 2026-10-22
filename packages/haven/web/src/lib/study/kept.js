// src/lib/study/kept.js — the study's tabs across a restart (`IDEAS/study.md`
// 2.2): `~/.fli/haven/study.json`, beside `key.json` and `seen/`.
//
// A tab is kept as a pointer, `{ sessionId, model }`, and never a copy: the
// transcript stays Claude's own, and a kept tab is reopened by `--resume` on
// its next line. The file holds one entry per checkout, since a session id
// resumes only from the directory it ran in, and a second checkout's Haven
// must not reopen this one's sessions.
//
// Terminal only, like `session.js`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { FOLDS } from './tabs.js'

export const STUDY_FILE = join(homedir(), '.fli', 'haven', 'study.json')

const readAll = (file) => {
  try {
    const all = JSON.parse(readFileSync(file, 'utf8'))
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch { return {} }
}

/**
 * What a tab keeps: its session id once the CLI named one, the model it
 * asked for, its `/fold` and the plan `/go` last read. A read-along (`IDEAS/study.md` 3.3) keeps the session it reads as
 * `reads` and never as `sessionId`, so no reader of the file can resume it.
 */
export const keptOf = (tabs, at) => ({
  at,
  tabs: tabs.map((t) => ({
    ...(t.reads
      ? { reads: t.reads, transcript: t.transcript ?? null }
      : { sessionId: t.session?.state.sessionId ?? t.resume ?? null, model: t.model ?? null, plan: t.plan ?? null }),
    fold: t.fold ?? 'none',
  })),
})

/** The tabs kept for `cwd`, `{ at, tabs }`, or null; a torn file or a stray shape is none. */
export function readStudy(cwd, { file = STUDY_FILE } = {}) {
  const kept = readAll(file)[cwd]
  if (!Array.isArray(kept?.tabs) || !kept.tabs.length) return null
  const str = (v) => typeof v === 'string' ? v : null
  const tabs = kept.tabs.map((t) => ({
    ...(typeof t?.reads === 'string'
      ? { reads: t.reads, transcript: str(t.transcript) }
      : { sessionId: str(t?.sessionId), model: str(t?.model), plan: str(t?.plan) }),
    fold: FOLDS.includes(t?.fold) ? t.fold : 'none',
  }))
  const at = Number.isInteger(kept.at) ? Math.min(Math.max(0, kept.at), tabs.length - 1) : 0
  return { at, tabs }
}

/** Keep `kept` as `cwd`'s entry, the other checkouts' left as they were. */
export function writeStudy(cwd, kept, { file = STUDY_FILE } = {}) {
  const all = readAll(file)
  all[cwd] = kept
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Written whole and renamed over, so a Haven killed mid-write leaves the last file rather than half of one.
  const tmp = `${file}.${process.pid}`
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
