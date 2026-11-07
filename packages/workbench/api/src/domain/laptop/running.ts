// api/src/domain/laptop/running.ts
// What fli is running on this laptop across every project: the dev sessions
// `fli dev` records in `<stateDir>/sessions.lock` and the tree holds a drive or
// a loop takes in `<stateDir>/holds`. Read only -- nothing here stops a server
// or frees a hold; the loop that took one releases it.
//
// The lock is read through `ports.js` (`getSessionStatus`), never re-parsed, so
// a field `fli dev` adds reaches the page without a second reader. A session's
// pid is the `fli dev` process, which lives as long as the servers it runs, so
// `alive` is the pid and `answering` is the port: a session can be alive with a
// port still booting, or dead with a stray server left on its port, and those
// are different things to act on.
//
// A hold file is named `<sha1 of the tree's real path>-<resource>.guard` and
// holds the pid (`guard.js` `treeHold`), so the path is not in the file. It is
// recovered by hashing the places a hold can come from -- every session root and
// the folders above it, and the holder's own working directory -- and a hold
// that matches none shows its key rather than a guessed path.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash }                                                    from 'node:crypto'
import { basename, dirname, join }                                       from 'node:path'
import { stateDir }                                                      from '@frontierjs/cli/core/paths.js'
import { describeProcess, getSessionStatus, isPortInUse, listeningPorts, processCwd } from '@frontierjs/cli/core/ports.js'
import type { Where }                                                    from './laptop.ts'

export type Port    = { category: string, port: number, answering: boolean }
export type Session = {
  root: string, name: string, env: string | null, pid: number | null, alive: boolean,
  /** The branch number a linked worktree took (`ports.js` § Branches), or null for a main checkout. */
  branch: number | null, worktree: string | null, startedAt: string | null,
  ports: Port[],
  /** Alive, or any of its ports answers: the rows worth showing as running. */
  running: boolean,
}
export type Hold = {
  file: string, resource: string, tree: string | null, key: string,
  pid: number | null, alive: boolean, what: string | null, since: string | null,
}
export type Running = { sessions: Session[], holds: Hold[] }

type Raw = {
  root: string, name?: string, env?: string, pid?: number, alive: boolean, branch?: number,
  worktree?: string, startedAt?: string, ports?: Record<string, number[]>,
}

// `paths.js` and `ports.js` are untyped JS; the lock's own file is the only thing the two disagree on.
const sessionsOf = getSessionStatus as unknown as (o: { lockFile: string }) => Raw[]
const pinned = (home?: string) => home === undefined ? {} : { home }
const keyOf  = (path: string) => {
  let real = path
  try { real = realpathSync(path) } catch {}
  return createHash('sha1').update(real).digest('hex').slice(0, 12)
}
const alive = (pid: number | null) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}
const iso = (ms: number) => new Date(ms).toISOString()

function sessions(home?: string, listening?: Map<number, Set<string>> | null): Promise<Session[]> {
  const rows = sessionsOf({ lockFile: join(stateDir(pinned(home)), 'sessions.lock') })
  return Promise.all(rows.map(async s => {
    const ports: Port[] = []
    for (const [category, list] of Object.entries(s.ports ?? {})) {
      for (const port of list) {
        // lsof cannot see another user's socket or is missing; the socket probe answers either way.
        const answering = listening ? listening.has(port) : await isPortInUse(port)
        ports.push({ category, port, answering })
      }
    }
    const running = s.alive || ports.some(p => p.answering)
    return {
      root: s.root, name: s.name ?? basename(s.root), env: s.env ?? null, pid: s.pid ?? null, alive: s.alive,
      branch: Number.isInteger(s.branch) ? s.branch! : null, worktree: s.worktree ?? null,
      startedAt: s.startedAt ?? null, ports, running,
    }
  }))
}

function holds(home: string | undefined, roots: string[]): Hold[] {
  const dir = join(stateDir(pinned(home)), 'holds')
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter(f => f.endsWith('.guard'))

  // The folders a hold can name, hashed once: each root and every folder above it.
  const known = new Map<string, string>()
  const remember = (path: string | null | undefined) => {
    for (let p = path; p && p !== '/' && p !== '.'; p = dirname(p)) known.set(keyOf(p), p)
  }
  roots.forEach(remember)

  return names.map(file => {
    const m   = /^([0-9a-f]{12})-(.+)\.guard$/.exec(file)
    const key = m?.[1] ?? ''
    let pid: number | null = null
    try { pid = parseInt(readFileSync(join(dir, file), 'utf8'), 10) || null } catch {}
    let since: string | null = null
    try { since = iso(statSync(join(dir, file)).mtimeMs) } catch {}
    const up   = alive(pid)
    // A live holder's cwd is the tree it works in, or inside it.
    const cwd  = up && pid ? processCwd(pid) : null
    if (cwd) remember(cwd)
    return {
      file, key, resource: m?.[2] ?? file.replace(/\.guard$/, ''),
      tree: known.get(key) ?? null, pid, alive: up,
      what: up && pid ? describeProcess(pid) || null : null, since,
    }
  }).sort((a, b) => String(b.since).localeCompare(String(a.since)))
}

/** Dev sessions with the ports each holds and which of them answer; the tree holds beside them. */
export async function running({ home }: Where = {}): Promise<Running> {
  const rows = await sessions(home, listeningPorts() as Map<number, Set<string>> | null)
  return {
    sessions: rows.sort((a, b) => Number(b.running) - Number(a.running) || String(b.startedAt).localeCompare(String(a.startedAt))),
    holds:    holds(home, rows.flatMap(s => [s.root, s.worktree].filter((p): p is string => !!p))),
  }
}
