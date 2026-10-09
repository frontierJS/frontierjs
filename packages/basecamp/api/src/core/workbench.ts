// src/core/workbench.ts — Claude Code sessions in the checkouts the operator pinned.
//
// The sibling of `core/local-git.ts`, behind the same refusal: a pinned checkout
// is a folder on the operator's own machine, and a run is `claude -p` started in
// it with EVERY permission. The argv and the reading of its stream are the cli's
// (`askArgv({ work })` and `readAskEvent` in `@frontierjs/cli/core/ask-claude.js`),
// the one owner of how this repo talks to Claude Code.
//
// Nothing here is in the database. A pin names a folder on THIS machine, which
// no workspace owns, and `db:reset` must not take a chat with it. The state is a
// directory — `WORKBENCH_DIR`, default ~/.config/basecamp/workbench:
//
//   pins.json                 the pinned checkouts, in pin order
//   logs/<id>.ndjson          every run in that checkout, appended — a `prompt`
//                             line written here, claude's stream-json, then an
//                             `exit` line
//   logs/<id>.review.ndjson   every reviewer run, the same shape
//   logs/<id>.checks.json     the latest checks report, replaced whole
//   trees/<parent id>/<slug>  a BRANCH's linked worktree — outside the repo, or
//                             fli check, the typecheck globs and the packages/*
//                             glob would each find a second copy of every package
//
// A branch is a pin like any other, plus where it came from: Fork snapshots the
// parent's tree (`core/workbench-branch.ts`), cuts `wb/<slug>` from it into a
// worktree and pins that; Land applies the branch's work back to the parent's
// tree, uncommitted; Archive removes the worktree and keeps the branch.
//
// When a run ends with nothing queued behind it, two follow-ups may start:
// the CHECKS — the checkout's own `fli done` (`core/workbench-check.ts`), only
// where the checkout carries one — and, where the pin asks for it, a REVIEW: a
// fresh read-only `claude -p` over the tree. Each is stamped with when it
// started, and a follow-up that started before the latest message is stale and
// is not shown; the next message stops any still going.
//
// A run is DETACHED and writes straight to its log, never through a pipe to
// this process. `bun run api` is `bun --watch`, which restarts on an edit to any
// file the API imports, and a checkout pinned here is often this repo: a pipe
// would close on the restart and take the run with it. So whether a run is going
// is read off the disk — the pid in pins.json, still alive — and a restart loses
// the queue and nothing else.
//
// A log can be megabytes (a verbose stream carries every tool result whole), and
// the grid asks for status every second or two, so each log is read
// INCREMENTALLY: the bytes since the last read, folded into a cached state.

import { spawn }                       from 'node:child_process'
import { createHash }                  from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir }                     from 'node:os'
import { basename, join }              from 'node:path'
import { fileURLToPath }               from 'node:url'
import { resolveRoot }                 from './local-git.ts'
import { readDiff }                    from './workbench-diff.ts'
import { addWorktree, branchName, land as landBranch, pendingFiles, removeWorktree, snapshot } from './workbench-branch.ts'

export type Pin = {
  id:       string
  path:     string
  name:     string
  /** The Claude Code session the next message resumes; null starts a new one. */
  session:  string | null
  budget:   number
  /** Run the checkout's own Claude Code hooks. Off: a Stop hook that blocks
   *  spends the run's turns on the hook instead of the request. */
  hooks:    boolean
  /** Start a read-only review whenever a run finishes. Off: each one is paid. */
  review:   boolean
  pinnedAt: string
  seenAt:   string | null
  pid:      number | null
  reviewPid: number | null
  /** A branch's parent pin; null on a checkout pinned by hand. */
  from:     string | null
  /** The commit a branch diffs and lands against — its cut, then each landing. */
  base:     string | null
  /** `wb/<slug>`, the git branch the worktree has checked out. */
  branch:   string | null
  /** The session a branch's first message forks; spent once `session` is set. */
  forkOf:   string | null
  /** What the snapshot held beyond the parent's HEAD — files a run there had
   *  not committed, which a concurrent session may have been halfway through. */
  carried:  { total: number, files: string[] } | null
}

export type Item =
  | { kind: 'you',    text: string, at: string }
  | { kind: 'text',   text: string }
  | { kind: 'tool',   text: string }
  | { kind: 'result', ok: boolean, stop: string | null, cost: number | null, turns: number | null }
  | { kind: 'error',  text: string }

export type RunState = 'idle' | 'working' | 'done' | 'error'

export type ChecksState = 'running' | 'pass' | 'fail' | 'error'

/** What `logs/<id>.checks.json` holds: `fli done`'s report and when it started. */
export type ChecksFile = {
  state:   ChecksState
  at:      string
  pid:     number | null
  report?: { changed: number, unfinished: number, items: Array<{ check: string, subject: string, ok: boolean, message: string }>, drives: Array<{ changed: string, tier: string | null, on: string[], run: string[] }> }
  error?:  string
}

export type Spent = { total: number, today: number }

export type PinStatus = {
  id:      string
  state:   RunState
  /** What the run is doing now — the last tool call, cleared by text. */
  tool:    string | null
  cost:    number | null
  turns:   number | null
  unread:  boolean
  queued:  number
  /** Moves whenever the transcript would: a screen refetches when it does. */
  rev:     string
  session: string | null
  /** Every run and review in this checkout, and those started today. */
  spent:   Spent
  checks:  { state: ChecksState, at: string, changed: number, unfinished: number, drives: number } | null
  review:  { state: RunState, cost: number | null } | null
}

type Folded = {
  offset:  number
  partial: string
  items:   Item[]
  session: string | null
  run:     { state: RunState, tool: string | null, cost: number | null, turns: number | null, at: string | null }
  /** Cost by the local day each run started, kept across a new chat. */
  byDay:   Record<string, number>
}

/** Kept per chat; older items stay in the log and in Claude Code's own session. */
const MAX_ITEMS = 400

const DEFAULT_BUDGET = 10

const freshFold = (): Folded => ({
  offset: 0, partial: '', items: [], session: null,
  run: { state: 'idle', tool: null, cost: null, turns: null, at: null }, byDay: {},
})

// The operator's own day: the workbench runs only on their machine, so this
// process's zone is theirs.
export function dayOf(at: string | number | Date): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function spentOf(f: Folded, today: string): Spent {
  return {
    total: Object.values(f.byDay).reduce((n, c) => n + c, 0),
    today: f.byDay[today] ?? 0,
  }
}

const CHECK_SCRIPT = fileURLToPath(new URL('./workbench-check.ts', import.meta.url))

/**
 * The `done.js` that states what finished means in this checkout, or null:
 * the workspace's own (what its Stop hook runs), else the one its fli install
 * carries.
 */
export function doneScript(root: string): string | null {
  for (const rel of ['packages/cli/core/done.js', 'node_modules/@frontierjs/cli/core/done.js']) {
    const path = join(root, rel)
    if (existsSync(path)) return path
  }
  return null
}

function killGroup(pid: number | null | undefined) {
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
}

export const pinId = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 12)

function alive(pid: number | null): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the workbench is offered at all.
type AskClaude = {
  askArgv:       (o?: { session?: string | null, fork?: boolean, work?: { budget?: number, hooks?: boolean } }) => string[]
  readAskEvent:  (event: unknown) => Array<Record<string, any>>
  resumeCommand: (root: string, session: string) => string | null
  reviewPrompt:  (o: { request?: string }) => string
}
let askClaude: Promise<AskClaude> | null = null
const loadAskClaude = () => askClaude ??= import('@frontierjs/cli/core/ask-claude.js') as Promise<AskClaude>

export type Workbench = ReturnType<typeof createWorkbench>

export function createWorkbench({ dir, bin = 'claude', env = {} }: {
  dir?: string
  bin?: string
  /** Variables taken OUT of a run's environment — this API's own, so a dev
   *  server the run starts does not bind this API's PORT. */
  env?: Record<string, unknown>
} = {}) {
  const root     = dir || join(homedir(), '.config', 'basecamp', 'workbench')
  const pinsFile = join(root, 'pins.json')
  const logFile    = (id: string) => join(root, 'logs', `${id}.ndjson`)
  const reviewFile = (id: string) => join(root, 'logs', `${id}.review.ndjson`)
  const checksFile = (id: string) => join(root, 'logs', `${id}.checks.json`)
  const folds    = new Map<string, Folded>()
  const queues   = new Map<string, string[]>()

  // ─── pins ─────────────────────────────────────────────────────────────

  function readPins(): Pin[] {
    let pins: Array<Partial<Pin>>
    try { pins = JSON.parse(readFileSync(pinsFile, 'utf8')).pins ?? [] } catch { return [] }
    return pins.map(p => ({ review: false, reviewPid: null, from: null, base: null, branch: null, forkOf: null, carried: null, ...p }) as Pin)
  }

  // Through a rename, so a crash mid-write cannot leave half a file that reads
  // as no pins at all.
  function writePins(pins: Pin[]) {
    mkdirSync(root, { recursive: true })
    const tmp = `${pinsFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pins }, null, 2) + '\n')
    renameSync(tmp, pinsFile)
  }

  function updatePin(id: string, patch: Partial<Pin>): Pin {
    const pins = readPins()
    const i = pins.findIndex(p => p.id === id)
    if (i === -1) throw new Error(`no pinned checkout '${id}'`)
    pins[i] = { ...pins[i], ...patch }
    writePins(pins)
    return pins[i]
  }

  function getPin(id: string): Pin | null {
    return readPins().find(p => p.id === id) ?? null
  }

  /** Pin a git checkout. Pinning one twice answers the pin already there. */
  function pin(input: unknown): { pin: Pin } | { refused: string } {
    const where = resolveRoot(input)
    if ('refused' in where) return where
    if (!existsSync(join(where.root, '.git'))) return { refused: `'${where.root}' is not a git checkout` }
    const pins = readPins()
    const id   = pinId(where.root)
    const had  = pins.find(p => p.id === id)
    if (had) return { pin: had }
    const next: Pin = {
      id, path: where.root, name: basename(where.root), session: null,
      budget: DEFAULT_BUDGET, hooks: false, review: false,
      pinnedAt: new Date().toISOString(), seenAt: null, pid: null, reviewPid: null,
      from: null, base: null, branch: null, forkOf: null, carried: null,
    }
    writePins([...pins, next])
    return { pin: next }
  }

  /** Unpinning stops a run and forgets the chat; Claude Code keeps its session. */
  function unpin(id: string): { refused: string } | null {
    const p = getPin(id)
    if (p?.from) return { refused: `${p.name} is a branch — archive it, or its worktree is left behind with nothing pointing at it` }
    const branches = readPins().filter(b => b.from === id)
    if (branches.length) return { refused: `archive ${p!.name}'s ${branches.length} branch${branches.length === 1 ? '' : 'es'} first` }
    forget(id)
    return null
  }

  function forget(id: string) {
    stop(id)
    writePins(readPins().filter(p => p.id !== id))
    for (const file of [logFile(id), reviewFile(id), checksFile(id)]) {
      rmSync(file, { force: true })
      folds.delete(file)
    }
  }

  // ─── branches ─────────────────────────────────────────────────────────

  /** The lowest `branch-<n>` that is neither a branch of the repository nor a tree here. */
  function freeSlug(parent: Pin): string {
    for (let n = 1; ; n++) {
      const slug = `branch-${n}`
      if ('branch' in branchName(parent.path, slug) && !existsSync(join(root, 'trees', parent.id, slug))) return slug
    }
  }

  /**
   * A branch of a pinned checkout: its tree as the operator sees it, uncommitted
   * and untracked files included, in a worktree of its own, pinned beside it.
   * Where the parent has a chat the branch's first message forks it.
   */
  function fork(id: string, input: { slug?: unknown } = {}): { pin: Pin } | { refused: string } {
    const parent = getPin(id)
    if (!parent) return { refused: `no pinned checkout '${id}'` }
    if (parent.from) return { refused: `${parent.name} is itself a branch — fork its parent` }
    const slug  = input.slug == null || input.slug === '' ? freeSlug(parent) : String(input.slug).trim()
    const named = branchName(parent.path, slug)
    if ('refused' in named) return named
    const path = join(root, 'trees', parent.id, slug)
    if (existsSync(path)) return { refused: `'${path}' already exists` }

    let cut: ReturnType<typeof snapshot>
    try {
      cut = snapshot(parent.path)
      mkdirSync(join(root, 'trees', parent.id), { recursive: true })
      addWorktree(parent.path, path, named.branch, cut.base)
    } catch (e) { return { refused: `git refused the branch: ${(e as Error).message}` } }

    const pinned = pin(path)
    if ('refused' in pinned) return pinned
    return {
      pin: updatePin(pinned.pin.id, {
        name: `${parent.name} · ${slug}`, from: parent.id, base: cut.base, branch: named.branch,
        forkOf: parent.session, carried: cut.carried,
        budget: parent.budget, hooks: parent.hooks, review: parent.review,
      }),
    }
  }

  /** The branch's work since its base, into the parent's tree, uncommitted. */
  function land(id: string): { landed: string[] } | { refused: string, files?: string[] } {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const parent = p.from ? getPin(p.from) : null
    if (!p.from || !p.base) return { refused: `${p.name} is not a branch` }
    if (!parent)            return { refused: `${p.name}'s parent is no longer pinned` }
    if (alive(p.pid))       return { refused: `${p.name} is still working; land it when the run ends` }
    if (alive(parent.pid))  return { refused: `${parent.name} is working; land when its run ends` }
    let out: ReturnType<typeof landBranch>
    try { out = landBranch(parent.path, p.path, p.base) }
    catch (e) { return { refused: `git refused the landing: ${(e as Error).message}` } }
    if ('refused' in out) return out
    updatePin(id, { base: out.base })
    return { landed: out.landed }
  }

  /**
   * Stop everything running in the branch, remove its worktree and unpin it;
   * `wb/<slug>` stays, holding what was committed there. Work not yet landed
   * is refused by count unless `discard` says to lose it.
   */
  function archive(id: string, { discard = false }: { discard?: unknown } = {}): { archived: string } | { refused: string, pending?: number } {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const parent = p.from ? getPin(p.from) : null
    if (!p.from || !p.base || !p.branch) return { refused: `${p.name} is not a branch — unpin it instead` }
    let pending = 0
    try { pending = existsSync(p.path) ? pendingFiles(p.path, p.base).length : 0 } catch {}
    if (pending && discard !== true)
      return { refused: `${p.name} holds ${pending} file${pending === 1 ? '' : 's'} not landed`, pending }
    stop(id)
    try { removeWorktree(parent?.path ?? p.path, p.path) }
    catch (e) { return { refused: `git refused to remove the worktree: ${(e as Error).message}` } }
    forget(id)
    return { archived: p.branch }
  }

  function configure(id: string, patch: { name?: unknown, budget?: unknown, hooks?: unknown, review?: unknown }): Pin | { refused: string } {
    const out: Partial<Pin> = {}
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) return { refused: 'name cannot be empty' }
      out.name = name.slice(0, 80)
    }
    if (patch.budget !== undefined) {
      const budget = Number(patch.budget)
      if (!(budget > 0 && budget <= 500)) return { refused: 'budget is dollars per run, more than 0 and at most 500' }
      out.budget = budget
    }
    if (patch.hooks !== undefined)  out.hooks  = patch.hooks === true
    if (patch.review !== undefined) out.review = patch.review === true
    return updatePin(id, out)
  }

  // ─── the log ──────────────────────────────────────────────────────────

  function appendLine(file: string, line: object) {
    mkdirSync(join(root, 'logs'), { recursive: true })
    appendFileSync(file, JSON.stringify(line) + '\n')
  }

  function push(f: Folded, item: Item) {
    f.items.push(item)
    if (f.items.length > MAX_ITEMS) f.items.splice(0, f.items.length - MAX_ITEMS)
  }

  async function foldLine(f: Folded, line: string) {
    if (!line.trim()) return
    let event: Record<string, any>
    try { event = JSON.parse(line) } catch {
      // stderr shares the file: `claude` saying it is not logged in lands here.
      push(f, { kind: 'error', text: line.slice(0, 2000) })
      return
    }
    if (event.type === 'new') { Object.assign(f, freshFold(), { offset: f.offset, partial: f.partial, byDay: f.byDay }); return }
    if (event.type === 'prompt') {
      const at = String(event.at ?? '')
      push(f, { kind: 'you', text: String(event.text ?? ''), at })
      f.run = { state: 'working', tool: null, cost: null, turns: null, at }
      return
    }
    if (event.type === 'exit') {
      if (f.run.state === 'working') {
        f.run.state = 'error'
        push(f, { kind: 'error', text: event.stopped ? 'Stopped.' : `claude exited ${event.code ?? '?'} without a result` })
      }
      f.run.tool = null
      return
    }
    const { readAskEvent } = await loadAskClaude()
    for (const e of readAskEvent(event)) {
      if (e.type === 'session') f.session = e.id
      if (e.type === 'text')    { push(f, { kind: 'text', text: e.text }); f.run.tool = null }
      if (e.type === 'tool')    { push(f, { kind: 'tool', text: e.text }); f.run.tool = e.text }
      if (e.type === 'result') {
        push(f, { kind: 'result', ok: e.ok, stop: e.stop, cost: e.cost, turns: e.turns })
        f.run = { ...f.run, state: e.ok ? 'done' : 'error', tool: null, cost: e.cost, turns: e.turns }
        if (e.cost != null && f.run.at) {
          const day = dayOf(f.run.at)
          f.byDay[day] = (f.byDay[day] ?? 0) + Number(e.cost)
        }
      }
    }
  }

  /** A log folded up to its current end, reading only the bytes since last time. */
  async function fold(file: string): Promise<Folded> {
    let f = folds.get(file) ?? freshFold()
    let size = 0
    try { size = statSync(file).size } catch { folds.delete(file); return freshFold() }
    if (size < f.offset) f = freshFold()
    if (size > f.offset) {
      const fd  = openSync(file, 'r')
      const buf = Buffer.alloc(size - f.offset)
      try { readSync(fd, buf, 0, buf.length, f.offset) } finally { closeSync(fd) }
      const lines = (f.partial + buf.toString('utf8')).split('\n')
      f.partial = lines.pop() ?? ''
      f.offset  = size
      for (const line of lines) await foldLine(f, line)
    }
    folds.set(file, f)
    return f
  }

  // A run whose process is gone and wrote no result died with the API's
  // previous process, which was the one that would have written `exit`.
  const settled = (state: RunState, pid: number | null): RunState =>
    state === 'working' && !alive(pid) ? 'error' : state

  // Started before the latest message: about a tree that has moved since.
  const stale = (at: string | null, main: Folded) =>
    !at || (!!main.run.at && Date.parse(at) < Date.parse(main.run.at))

  const checksCache = new Map<string, { mtime: number, value: ChecksFile | null }>()

  function readChecks(id: string): ChecksFile | null {
    const file = checksFile(id)
    let mtime: number
    try { mtime = statSync(file).mtimeMs } catch { checksCache.delete(file); return null }
    const hit = checksCache.get(file)
    if (hit?.mtime === mtime) return hit.value
    let value: ChecksFile | null = null
    try { value = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    checksCache.set(file, { mtime, value })
    return value
  }

  /** The current checks, or null when there are none or they are stale. */
  function currentChecks(id: string, main: Folded): ChecksFile | null {
    const c = readChecks(id)
    if (!c || stale(c.at, main)) return null
    if (c.state === 'running' && !alive(c.pid)) return { ...c, state: 'error', error: 'the check stopped before it wrote a report' }
    return c
  }

  async function currentReview(p: Pin, main: Folded) {
    const r = await fold(reviewFile(p.id))
    if (r.run.state === 'idle' || stale(r.run.at, main)) return null
    return { fold: r, state: settled(r.run.state, p.reviewPid) }
  }

  async function status(p: Pin): Promise<PinStatus> {
    const f = await fold(logFile(p.id))
    const state = settled(f.run.state, p.pid)
    let mtime = 0
    try { mtime = statSync(logFile(p.id)).mtimeMs } catch {}
    const ended  = state === 'done' || state === 'error'
    const review = await currentReview(p, f)
    const checks = currentChecks(p.id, f)
    const today  = dayOf(Date.now())
    const own    = spentOf(f, today)
    const rev    = spentOf(await fold(reviewFile(p.id)), today)
    return {
      id: p.id, state, tool: state === 'working' ? f.run.tool : null,
      cost: f.run.cost, turns: f.run.turns,
      unread: ended && (!p.seenAt || mtime > Date.parse(p.seenAt)),
      queued: queues.get(p.id)?.length ?? 0,
      rev:    [f.offset, review?.fold.offset ?? 0, checks ? `${checks.state}@${checks.at}` : ''].join('.'),
      session: p.session,
      spent:  { total: own.total + rev.total, today: own.today + rev.today },
      checks: checks && {
        state: checks.state, at: checks.at,
        changed:    checks.report?.changed ?? 0,
        unfinished: checks.report?.unfinished ?? 0,
        drives:     checks.report?.drives.length ?? 0,
      },
      review: review && { state: review.state, cost: review.fold.run.cost },
    }
  }

  async function statuses(): Promise<PinStatus[]> {
    return Promise.all(readPins().map(status))
  }

  async function transcript(id: string) {
    const p = getPin(id)
    if (!p) return null
    const f = await fold(logFile(id))
    const { resumeCommand } = await loadAskClaude()
    const review = await currentReview(p, f)
    // The review's own prompt is the rules; what is worth reading is the reply.
    const from = review ? review.fold.items.findLastIndex(i => i.kind === 'you') + 1 : 0
    return {
      id, items: f.items, resume: p.session ? resumeCommand(p.path, p.session) : null,
      checks: currentChecks(id, f),
      review: review && { state: review.state, items: review.fold.items.slice(from) },
    }
  }

  /** The checkout's working tree against HEAD — a branch's against its base. */
  function diff(id: string) {
    const p = getPin(id)
    if (!p) return null
    return { id, base: p.base, ...readDiff(p.path, p.base ?? 'HEAD') }
  }

  // ─── runs ─────────────────────────────────────────────────────────────

  function childEnv() {
    const out: Record<string, string | undefined> = { ...process.env }
    for (const key of Object.keys(env)) delete out[key]
    return out
  }

  /**
   * One detached `claude -p` writing to `file`. The child gets its own
   * descriptor on the log and keeps writing after this process is gone;
   * O_APPEND keeps its lines and the `exit` line whole. `onEnd` runs once,
   * on `exit` or on a spawn that fails and never exits.
   */
  function launch(file: string, cwd: string, argv: string[], prompt: string, onEnd: (code: number | null, signal: string | null) => void) {
    appendLine(file, { type: 'prompt', text: prompt, at: new Date().toISOString() })
    const fd = openSync(file, 'a')
    let child
    try {
      child = spawn(bin, argv, { cwd, detached: true, env: childEnv(), stdio: ['pipe', fd, fd] })
    } finally { closeSync(fd) }
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
    child.unref()

    let ended = false
    const end = (code: number | null, signal: string | null) => {
      if (ended) return
      ended = true
      onEnd(code, signal)
    }
    child.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      // A plain line: the fold reads anything not JSON as an error to show.
      appendFileSync(file, `${code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message}\n`)
      end(null, null)
    })
    child.on('exit', (code, signal) => end(code, signal))
    return child
  }

  async function start(p: Pin, prompt: string) {
    const { askArgv } = await loadAskClaude()
    cancelFollowUps(p)
    const forking = !p.session && !!p.forkOf
    const argv    = askArgv({ session: p.session ?? p.forkOf, fork: forking, work: { budget: p.budget, hooks: p.hooks } })
    const child = launch(logFile(p.id), p.path, argv, prompt, async (code, signal) => {
      const still = getPin(p.id)
      if (!still) return
      const stopped = stopping.delete(p.id)
      appendLine(logFile(p.id), { type: 'exit', code, signal, stopped, at: new Date().toISOString() })
      // The session id is read off the log rather than caught off the stream,
      // so a run that outlived an API restart still leaves its id behind.
      const f = await fold(logFile(p.id))
      updatePin(p.id, { pid: null, session: f.session ?? still.session })
      const next = queues.get(p.id)?.shift()
      if (next !== undefined) { await start(getPin(p.id)!, next); return }
      if (!stopped) await followUp(p.id, f.run.state)
    })
    updatePin(p.id, { pid: child.pid ?? null })
  }

  // ─── follow-ups ───────────────────────────────────────────────────────

  /** After a run with nothing queued: the checks where the checkout has them,
   *  and a review where the pin asks for one and the run finished. */
  async function followUp(id: string, ended: RunState) {
    const p = getPin(id)
    if (!p) return
    if (doneScript(p.path)) check(id)
    if (p.review && ended === 'done') await review(id)
  }

  /** The next message is about to move the tree; what was reading it stops. */
  function cancelFollowUps(p: Pin) {
    const c = readChecks(p.id)
    if (c?.state === 'running' && alive(c.pid)) killGroup(c.pid)
    if (alive(p.reviewPid)) { reviewStopping.add(p.id); killGroup(p.reviewPid) }
  }

  /** Run the checkout's own `fli done` over its tree, replacing any check in flight. */
  function check(id: string): { started: string } | { refused: string } {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    if (alive(p.pid)) return { refused: 'the run is still working; checks run when it ends' }
    const done = doneScript(p.path)
    if (!done) return { refused: `${p.name} carries no fli done — neither packages/cli/core/done.js nor @frontierjs/cli` }
    const prior = readChecks(id)
    if (prior?.state === 'running' && alive(prior.pid)) killGroup(prior.pid)

    mkdirSync(join(root, 'logs'), { recursive: true })
    const at = new Date().toISOString()
    const child = spawn(process.execPath, [CHECK_SCRIPT, done, p.path, checksFile(id), at], {
      cwd: p.path, detached: true, env: childEnv(), stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    // Written in the tick the child was spawned in, before it can have
    // imported anything, so its own report always lands on top of this.
    writeFileSync(checksFile(id), JSON.stringify({ state: 'running', at, pid: child.pid ?? null } satisfies ChecksFile))
    return { started: at }
  }

  /** A fresh read-only session reviewing the tree, given the last request. */
  async function review(id: string): Promise<{ started: string } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    if (alive(p.pid))       return { refused: 'the run is still working; review it when it ends' }
    if (alive(p.reviewPid)) return { refused: 'a review is already running' }
    const { askArgv, reviewPrompt } = await loadAskClaude()
    const request = (await fold(logFile(id))).items.findLast(i => i.kind === 'you')
    const child = launch(reviewFile(id), p.path, askArgv(), reviewPrompt({ request: request?.kind === 'you' ? request.text : '' }), (code, signal) => {
      if (!getPin(id)) return
      appendLine(reviewFile(id), { type: 'exit', code, signal, stopped: reviewStopping.delete(id), at: new Date().toISOString() })
      updatePin(id, { reviewPid: null })
    })
    updatePin(id, { reviewPid: child.pid ?? null })
    return { started: new Date().toISOString() }
  }

  const stopping       = new Set<string>()
  const reviewStopping = new Set<string>()

  /** Send a message. A checkout already working queues it behind the run. */
  async function send(id: string, prompt: string): Promise<{ queued: number } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const text = prompt.trim()
    if (!text) return { refused: 'say something' }
    if (alive(p.pid)) {
      const q = queues.get(id) ?? []
      q.push(text)
      queues.set(id, q)
      return { queued: q.length }
    }
    await start(p, text)
    return { queued: 0 }
  }

  /** Stop the run, its review and its checks, and drop the queue. Signals
   *  each GROUP — a run's own children (a test runner, a dev server) go with it. */
  function stop(id: string): boolean {
    queues.delete(id)
    const p = getPin(id)
    if (!p) return false
    const running = alive(p.pid)
    const c = readChecks(id)
    const following = alive(p.reviewPid) || (c?.state === 'running' && alive(c.pid))
    cancelFollowUps(p)
    if (running) { stopping.add(id); killGroup(p.pid) }
    return running || following
  }

  /** A new chat: the next message starts a session instead of resuming one. */
  function fresh(id: string) {
    const p = getPin(id)
    if (!p) return null
    if (alive(p.pid)) return { refused: 'stop the run before starting a new chat' }
    appendLine(logFile(id), { type: 'new' })
    return updatePin(id, { session: null, forkOf: null })
  }

  function seen(id: string) {
    return updatePin(id, { seenAt: new Date().toISOString() })
  }

  return {
    dir: root, readPins, getPin, pin, unpin, configure, statuses, status, transcript, diff,
    send, stop, fresh, seen, check, review, fork, land, archive,
  }
}
