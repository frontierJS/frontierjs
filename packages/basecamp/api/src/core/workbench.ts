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
//   logs/<id>.<chat>.ndjson   every run in one chat of that checkout, appended —
//                             a `prompt` line written here, claude's stream-json,
//                             then an `exit` line
//   logs/<id>.review.ndjson   every reviewer run, the same shape
//   logs/<id>.checks.json     the latest checks report, replaced whole
//   logs/<id>.run.<row>.log   what a dev server or script started from the Run
//                             tab wrote, from its latest start
//   trees/<parent id>/<slug>  a BRANCH's linked worktree — outside the repo, or
//                             fli check, the typecheck globs and the packages/*
//                             glob would each find a second copy of every package
//
// A checkout holds several CHATS, each its own Claude Code session and log, and
// one of them is the one the screen shows. They share one tree, so only one
// runs at a time: a message to another chat while one is working is refused,
// and Fork is the way to run two at once.
//
// A branch is a pin like any other, plus where it came from: Fork snapshots the
// parent's tree (`core/workbench-branch.ts`), cuts `wb/<slug>` from it into a
// worktree and pins that; Land applies the branch's work back to the parent's
// tree, uncommitted; Archive removes the worktree and keeps the branch.
// A new branch is SET UP before its first message: the gitignored paths the
// parent's copy list names are copied across (a worktree has no `.env`), then
// `bun install --no-save` where the tree has a bun lockfile — no-save, or the
// install rewrites the lockfile and the next Land carries it. A failure is a
// plain line in the branch's log, which the transcript draws as an error. Its
// ports are `fli dev`'s (`claimSession` gives a linked worktree its own block),
// and Archive gives the block back.
//
// A checkout whose pin carries `preview` settings can fork a PREVIEW: the
// branch's worktree is marked (`markPreview`, the cli's) so `fli check` and the
// ask panel's Submit hold it to `web/`, and its web port is claimed at the cut
// so the route Open sends names the port `fli dev` will bind there. The rows
// are `core/preview.ts`'s, written by the service as the caller.
//
// The Run tab starts what the checkout declares — `fli dev` per app, and its
// package.json scripts (`core/workbench-run.ts`) — detached, each with a log
// of its own and its pid on the pin, like a run. Unpin and Archive stop them.
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
// A pin may carry a PLAN — a Phases-of-Steps file in the checkout (`FJS-D966`),
// parsed by the cli's `parsePlan` on every read and never cached, because the
// session edits it. Build plan writes it from a goal in a session that may edit
// that one file and nothing else (`askArgv({ edit })`, `buildPlanPrompt`). Go
// sends the first open box's `stepPrompt` into the shown chat and records the
// step on the pin with the registers' high-water marks (`registerHigh`).
//
// A log can be megabytes (a verbose stream carries every tool result whole), and
// the grid asks for status every second or two, so each log is read
// INCREMENTALLY: the bytes since the last read, folded into a cached state.

import { spawn }                       from 'node:child_process'
import { createHash, randomBytes }     from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir }                     from 'node:os'
import { basename, join }              from 'node:path'
import { fileURLToPath }               from 'node:url'
import { resolveRoot }                 from './local-git.ts'
import { readDiff }                    from './workbench-diff.ts'
import { addWorktree, branchName, copyIgnored, land as landBranch, pendingFiles, removeWorktree, snapshot } from './workbench-branch.ts'
import { previewLabelRefusal, previewSettings, type Opened, type PreviewSettings } from './preview.ts'
import { inventory, resolveArgv, servedBy, tail, type RunRecord, type Served } from './workbench-run.ts'

export type Chat = {
  id:      string
  /** The Claude Code session the next message resumes; null starts a new one. */
  session: string | null
  /** The session this chat's first message forks; spent once `session` is set. */
  forkOf:  string | null
}

export type Pin = {
  id:       string
  path:     string
  name:     string
  /** In the order they were opened; never empty. */
  chats:    Chat[]
  /** The chat the screen shows and a message goes to unless it names another. */
  chat:     string
  /** The chat `pid` is running in. */
  runChat:  string | null
  /** Cost by day of the chats closed here, so the card's total keeps them. */
  closedByDay: Record<string, number>
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
  /** What the snapshot held beyond the parent's HEAD — files a run there had
   *  not committed, which a concurrent session may have been halfway through. */
  carried:  { total: number, files: string[] } | null
  /** Globs over the gitignored paths a new branch copies from this checkout. */
  copy:     string[]
  /** What a branch was given before its first message: the paths copied, and
   *  whether `bun install` ran, failed, or had no bun lockfile to run on. */
  setup:    { copied: string[], install: 'ran' | 'failed' | 'none' } | null
  /** On a checkout: where a preview forked from it is opened. Null forks none. */
  preview:  PreviewSettings | null
  /** On a preview branch: its web port from the cut, and what Open made. */
  opened:   ({ port: number } & Partial<Omit<Opened, 'port'>>) | null
  /** What the Run tab started here, by row id (`core/workbench-run.ts`). */
  runs:     Record<string, RunRecord>
  /** The plan this checkout is working through: its path in the checkout,
   *  and each step a Go started, by step id. */
  plan:     { path: string, steps: Record<string, PlanStep> } | null
}

/** A step Go started: the chat it ran in, when, and the highest `FJS-###` and
 *  `FJS-D##` the registers held then — every row above them is the step's. */
export type PlanStep = {
  chat:         string
  startedAt:    string
  registerHigh: { issue: number, decision: number }
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

export type ChatStatus = {
  id:      string
  /** The chat's first message, cut to a line; null before it has one. */
  title:   string | null
  state:   RunState
  unread:  boolean
  session: string | null
}

export type PinStatus = {
  id:      string
  /** The latest run's, in whichever chat it was. */
  state:   RunState
  /** What the run is doing now — the last tool call, cleared by text. */
  tool:    string | null
  cost:    number | null
  turns:   number | null
  unread:  boolean
  queued:  number
  /** Moves whenever the transcript would: a screen refetches when it does. */
  rev:     string
  /** The chat shown, and the one working when a run is. */
  chat:    string
  running: string | null
  chats:   ChatStatus[]
  /** Every run and review in this checkout, and those started today. */
  spent:   Spent
  checks:  { state: ChecksState, at: string, changed: number, unfinished: number, drives: number } | null
  review:  { state: RunState, cost: number | null } | null
  /** Each dev server or script the Run tab started, and the ports an app holds. */
  runs:    Array<{ id: string, name: string, running: boolean, exit: number | null, stopped: boolean, ports: Served[] }>
}

type Folded = {
  offset:  number
  partial: string
  items:   Item[]
  /** Kept apart from `items`, which drops the oldest past MAX_ITEMS. */
  title:   string | null
  session: string | null
  run:     { state: RunState, tool: string | null, cost: number | null, turns: number | null, at: string | null }
  /** Cost by the local day each run started. */
  byDay:   Record<string, number>
}

/** Kept per chat; older items stay in the log and in Claude Code's own session. */
const MAX_ITEMS = 400

const DEFAULT_BUDGET = 10

/** What an app keeps out of git and cannot start without. A dev database is
 *  the app's call — copy a small one, seed a large one. */
export const DEFAULT_COPY = ['**/.env']

const MAX_COPY = 20

/** A cold install of a large tree; past this the branch is left without one. */
const INSTALL_MS = 10 * 60_000

const freshFold = (): Folded => ({
  offset: 0, partial: '', items: [], title: null, session: null,
  run: { state: 'idle', tool: null, cost: null, turns: null, at: null }, byDay: {},
})

// The operator's own day: the workbench runs only on their machine, so this
// process's zone is theirs.
export function dayOf(at: string | number | Date): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function spentOf(byDay: Record<string, number>, today: string): Spent {
  return {
    total: Object.values(byDay).reduce((n, c) => n + c, 0),
    today: byDay[today] ?? 0,
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

const newChat = (forkOf: string | null = null): Chat => ({ id: randomBytes(4).toString('hex'), session: null, forkOf })

const TITLE_MAX = 60
const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0].trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

function alive(pid: number | null): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the workbench is offered at all.
type Ports = {
  releaseSession: (root: string, o?: { lockFile?: string }) => void
  portFor:        (from: string, category: string, o?: { env?: string, lockFile?: string }) => Promise<number>
}
let ports: Promise<Ports> | null = null
const loadPorts = () => ports ??= import('@frontierjs/cli/core/ports.js') as Promise<Ports>
type Preview = { markPreview: (dir: string) => string }
let previewMod: Promise<Preview> | null = null
const loadPreview = () => previewMod ??= import('@frontierjs/cli/core/preview.js') as Promise<Preview>

type AskClaude = {
  askArgv:       (o?: { session?: string | null, fork?: boolean, edit?: string, work?: { budget?: number, hooks?: boolean } }) => string[]
  buildPlanPrompt: (o: { goal: string, path: string }) => string
  readAskEvent:  (event: unknown) => Array<Record<string, any>>
  resumeCommand: (root: string, session: string) => string | null
  reviewPrompt:  (o: { request?: string }) => string
  stepPrompt:    (o: { path: string, step: Record<string, any>, phase?: Record<string, any> | null }) => string
}
let askClaude: Promise<AskClaude> | null = null
const loadAskClaude = () => askClaude ??= import('@frontierjs/cli/core/ask-claude.js') as Promise<AskClaude>
type PlanMod = {
  parsePlan: (text: string, o?: { file?: string }) => Record<string, any>
  phaseOf:   (plan: Record<string, any>, step: Record<string, any>) => Record<string, any> | null
}
let planMod: Promise<PlanMod> | null = null
const loadPlan = () => planMod ??= import('@frontierjs/cli/core/plan.js') as Promise<PlanMod>
type FileMod = { registerHigh: (root: string) => PlanStep['registerHigh'] }
let fileMod: Promise<FileMod> | null = null
const loadFile = () => fileMod ??= import('@frontierjs/cli/core/file.js') as Promise<FileMod>

/** A plan's path, relative to its checkout: a markdown file inside it. */
export function planPathRefusal(input: unknown): string | null {
  const path = String(input ?? '').trim()
  if (!path) return 'name the plan\'s path in the checkout — IDEAS/<slug>.md or PLAN.md'
  if (path.startsWith('/') || path.split('/').includes('..')) return `'${path}' is not a path inside the checkout`
  if (!/\.md$/.test(path)) return `'${path}' is not a markdown file`
  return null
}

export type Workbench = ReturnType<typeof createWorkbench>

export function createWorkbench({ dir, bin = 'claude', env = {}, portsLock }: {
  dir?: string
  bin?: string
  /** `fli dev`'s sessions lock, where a branch's port block is held; the
   *  cli's own default when unset. */
  portsLock?: string
  /** Variables taken OUT of a run's environment — this API's own, so a dev
   *  server the run starts does not bind this API's PORT. */
  env?: Record<string, unknown>
} = {}) {
  const root     = dir || join(homedir(), '.config', 'basecamp', 'workbench')
  const pinsFile = join(root, 'pins.json')
  const logFile    = (id: string, chat: string) => join(root, 'logs', `${id}.${chat}.ndjson`)
  const reviewFile = (id: string) => join(root, 'logs', `${id}.review.ndjson`)
  const checksFile = (id: string) => join(root, 'logs', `${id}.checks.json`)
  const runFile    = (id: string, row: string) => join(root, 'logs', `${id}.run.${createHash('sha1').update(row).digest('hex').slice(0, 10)}.log`)
  const folds    = new Map<string, Folded>()
  const queues   = new Map<string, string[]>()

  // ─── pins ─────────────────────────────────────────────────────────────

  function readPins(): Pin[] {
    let pins: Array<Partial<Pin>>
    try { pins = JSON.parse(readFileSync(pinsFile, 'utf8')).pins ?? [] } catch { return [] }
    return pins.map(p => ({
      chats: [{ id: '1', session: null, forkOf: null }], chat: '1', runChat: null, closedByDay: {},
      review: false, reviewPid: null, from: null, base: null, branch: null, carried: null,
      copy: DEFAULT_COPY, setup: null, preview: null, opened: null, runs: {}, plan: null, ...p,
    }) as Pin)
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

  /** The chat named, or the one shown when none is; null for a name that is not one. */
  function chatIn(p: Pin, chat?: unknown): Chat | null {
    const want = chat == null || chat === '' ? p.chat : String(chat)
    return p.chats.find(c => c.id === want) ?? (want === p.chat ? p.chats[0] ?? null : null)
  }

  function updateChat(id: string, chat: string, patch: Partial<Chat>): Pin {
    const p = getPin(id)
    if (!p) throw new Error(`no pinned checkout '${id}'`)
    return updatePin(id, { chats: p.chats.map(c => c.id === chat ? { ...c, ...patch } : c) })
  }

  /** A pin outlives its folder: a rename or a delete leaves it naming nothing,
   *  and a run there would fail on spawn rather than say why. */
  function goneRefusal(p: Pin): { refused: string } | null {
    return existsSync(p.path) ? null : { refused: `'${p.path}' is no longer there — unpin ${p.name}, or pin the checkout where it went` }
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
    const first = newChat()
    const next: Pin = {
      id, path: where.root, name: basename(where.root),
      chats: [first], chat: first.id, runChat: null, closedByDay: {},
      budget: DEFAULT_BUDGET, hooks: false, review: false,
      pinnedAt: new Date().toISOString(), seenAt: null, pid: null, reviewPid: null,
      from: null, base: null, branch: null, carried: null,
      copy: DEFAULT_COPY, setup: null, preview: null, opened: null, runs: {}, plan: null,
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
    const p = getPin(id)
    if (p) for (const row of Object.keys(p.runs)) { halt(id, row); rmSync(runFile(id, row), { force: true }) }
    writePins(readPins().filter(p => p.id !== id))
    for (const file of [...(p?.chats ?? []).map(c => logFile(id, c.id)), reviewFile(id), checksFile(id)]) {
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
   * Where the parent's shown chat has a session the branch's first message forks it.
   */
  async function fork(id: string, input: { slug?: unknown, preview?: unknown } = {}): Promise<{ pin: Pin } | { refused: string }> {
    const parent = getPin(id)
    if (!parent) return { refused: `no pinned checkout '${id}'` }
    if (parent.from) return { refused: `${parent.name} is itself a branch — fork its parent` }
    const gone = goneRefusal(parent)
    if (gone) return gone
    const preview = input.preview === true
    if (preview && !parent.preview) return { refused: `${parent.name} has no preview settings — configure them before forking a preview` }
    const slug  = input.slug == null || input.slug === '' ? freeSlug(parent) : String(input.slug).trim()
    const named = branchName(parent.path, slug)
    if ('refused' in named) return named
    const label = preview ? previewLabelRefusal(slug) : null
    if (label) return { refused: label }
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
    const b = updatePin(pinned.pin.id, {
      name: `${parent.name} · ${slug}`, from: parent.id, base: cut.base, branch: named.branch,
      chats: pinned.pin.chats.map(c => ({ ...c, forkOf: chatIn(parent)?.session ?? null })), carried: cut.carried,
      budget: parent.budget, hooks: parent.hooks, review: parent.review,
    })
    const setup = await setUp(parent, b)
    if (!preview) return { pin: updatePin(b.id, { setup }) }
    try {
      const cli = await loadPreview()
      cli.markPreview(b.path)
      const port = await (await loadPorts()).portFor(join(b.path, parent.preview!.app), 'fe', { env: 'dev', lockFile: portsLock })
      return { pin: updatePin(b.id, { setup, opened: { port } }) }
    } catch (e) {
      await archive(b.id, { discard: true })
      return { refused: `the preview could not be set up, so the branch was archived (${named.branch} is kept): ${(e as Error).message}` }
    }
  }

  /** What Open made, onto the preview branch it made it for. */
  function recordOpened(id: string, opened: Opened): Pin {
    return updatePin(id, { opened })
  }

  /** The parent's copy list carried across, then the install. Never refuses:
   *  the branch exists either way, and what went wrong is in its log. */
  async function setUp(parent: Pin, b: Pin): Promise<NonNullable<Pin['setup']>> {
    mkdirSync(join(root, 'logs'), { recursive: true })
    let copied: string[] = []
    try { copied = await copyIgnored(parent.path, b.path, parent.copy) }
    catch (e) { appendFileSync(logFile(b.id, b.chat), `copying the parent's ignored files failed: ${(e as Error).message}\n`) }
    if (!['bun.lock', 'bun.lockb'].some(f => existsSync(join(b.path, f)))) return { copied, install: 'none' }
    const out = await installIn(b.path)
    if (out.ok) return { copied, install: 'ran' }
    appendFileSync(logFile(b.id, b.chat), `bun install failed in the branch (${out.why}):\n${out.tail}\n`)
    return { copied, install: 'failed' }
  }

  function installIn(cwd: string): Promise<{ ok: true } | { ok: false, why: string, tail: string }> {
    return new Promise(done => {
      let out = ''
      const child = spawn(process.execPath, ['install', '--no-save'], { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      const keep  = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-4000) }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_MS)
      const tail  = () => out.trim().split('\n').slice(-20).join('\n')
      child.on('error', e => { clearTimeout(timer); done({ ok: false, why: e.message, tail: '' }) })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        done(code === 0 ? { ok: true } : { ok: false, why: signal ? `stopped after ${INSTALL_MS / 60_000} minutes` : `exit ${code}`, tail: tail() })
      })
    })
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
  async function archive(id: string, { discard = false }: { discard?: unknown } = {}): Promise<{ archived: string } | { refused: string, pending?: number }> {
    const refused = archiveRefusal(id, { discard })
    if (refused) return refused
    const p = getPin(id)!
    const parent = getPin(p.from!)
    stop(id)
    try { removeWorktree(parent?.path ?? p.path, p.path) }
    catch (e) { return { refused: `git refused to remove the worktree: ${(e as Error).message}` } }
    forget(id)
    try { (await loadPorts()).releaseSession(p.path, { lockFile: portsLock }) } catch {}
    return { archived: p.branch! }
  }

  /** Why Archive would refuse, asked before a preview is retired for it. */
  function archiveRefusal(id: string, { discard = false }: { discard?: unknown } = {}): { refused: string, pending?: number } | null {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    if (!p.from || !p.base || !p.branch) return { refused: `${p.name} is not a branch — unpin it instead` }
    let pending = 0
    try { pending = existsSync(p.path) ? pendingFiles(p.path, p.base).length : 0 } catch {}
    if (pending && discard !== true)
      return { refused: `${p.name} holds ${pending} file${pending === 1 ? '' : 's'} not landed`, pending }
    return null
  }

  function configure(id: string, patch: { name?: unknown, budget?: unknown, hooks?: unknown, review?: unknown, copy?: unknown, preview?: unknown }): Pin | { refused: string } {
    const out: Partial<Pin> = {}
    if (patch.preview !== undefined) {
      const p = getPin(id)
      if (p?.from) return { refused: `${p.name} is a branch — a preview is forked from its checkout` }
      if (patch.preview === null) out.preview = null
      else {
        const settings = previewSettings(patch.preview, p?.path ?? '')
        if ('refused' in settings) return settings
        out.preview = settings
      }
    }
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
    if (patch.copy !== undefined) {
      const list = (Array.isArray(patch.copy) ? patch.copy : String(patch.copy).split('\n')).map(g => String(g).trim()).filter(Boolean)
      if (list.length > MAX_COPY) return { refused: `the copy list holds at most ${MAX_COPY} globs` }
      const bad = list.find(g => g.length > 200 || g.startsWith('/') || g.split('/').includes('..'))
      if (bad) return { refused: `'${bad}' is not a glob inside the checkout` }
      out.copy = list
    }
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
    if (event.type === 'prompt') {
      const at = String(event.at ?? '')
      push(f, { kind: 'you', text: String(event.text ?? ''), at })
      f.title ??= titleOf(String(event.text ?? ''))
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

  type ChatFold = { chat: Chat, fold: Folded, state: RunState, mtime: number }

  /** Every chat's log folded, and the one holding the latest run — which,
   *  one run at a time, is the one a run in progress is in. */
  async function chatsOf(p: Pin): Promise<{ all: ChatFold[], latest: ChatFold }> {
    const all = await Promise.all(p.chats.map(async chat => {
      const file = logFile(p.id, chat.id)
      const f = await fold(file)
      let mtime = 0
      try { mtime = statSync(file).mtimeMs } catch {}
      return { chat, fold: f, mtime, state: settled(f.run.state, chat.id === p.runChat ? p.pid : null) }
    }))
    const at = (c: ChatFold) => c.fold.run.at ? Date.parse(c.fold.run.at) : -Infinity
    const latest = all.reduce((a, b) => at(b) > at(a) ? b : a)
    return { all, latest }
  }

  async function status(p: Pin): Promise<PinStatus> {
    const { all, latest } = await chatsOf(p)
    const shown  = all.find(c => c.chat.id === p.chat) ?? all[0]
    const f      = latest.fold
    const state  = latest.state
    const unread = (c: ChatFold) => (c.state === 'done' || c.state === 'error') && (!p.seenAt || c.mtime > Date.parse(p.seenAt))
    const review = await currentReview(p, f)
    const checks = currentChecks(p.id, f)
    const today  = dayOf(Date.now())
    const own    = [...all.map(c => spentOf(c.fold.byDay, today)), spentOf(p.closedByDay, today)]
    const rev    = spentOf((await fold(reviewFile(p.id))).byDay, today)
    return {
      id: p.id, state, tool: state === 'working' ? f.run.tool : null,
      cost: f.run.cost, turns: f.run.turns,
      unread: all.some(unread),
      queued: queues.get(p.id)?.length ?? 0,
      rev:    [shown.chat.id, shown.fold.offset, review?.fold.offset ?? 0, checks ? `${checks.state}@${checks.at}` : ''].join('.'),
      chat:    shown.chat.id,
      running: alive(p.pid) ? p.runChat : null,
      chats:   all.map(c => ({ id: c.chat.id, title: c.fold.title, state: c.state, unread: unread(c), session: c.chat.session })),
      spent:  {
        total: own.reduce((n, s) => n + s.total, 0) + rev.total,
        today: own.reduce((n, s) => n + s.today, 0) + rev.today,
      },
      checks: checks && {
        state: checks.state, at: checks.at,
        changed:    checks.report?.changed ?? 0,
        unfinished: checks.report?.unfinished ?? 0,
        drives:     checks.report?.drives.length ?? 0,
      },
      review: review && { state: review.state, cost: review.fold.run.cost },
      runs:   await runsOf(p),
    }
  }

  async function statuses(): Promise<PinStatus[]> {
    return Promise.all(readPins().map(status))
  }

  /** One chat — the one shown unless another is named — with the checkout's
   *  checks and review. */
  async function transcript(id: string, chat?: unknown) {
    const p = getPin(id)
    const c = p && chatIn(p, chat)
    if (!p || !c) return null
    const f = await fold(logFile(id, c.id))
    const { latest } = await chatsOf(p)
    const { resumeCommand } = await loadAskClaude()
    const review = await currentReview(p, latest.fold)
    // The review's own prompt is the rules; what is worth reading is the reply.
    const from = review ? review.fold.items.findLastIndex(i => i.kind === 'you') + 1 : 0
    return {
      id, chat: c.id, items: f.items, resume: c.session ? resumeCommand(p.path, c.session) : null,
      checks: currentChecks(id, latest.fold),
      review: review && { state: review.state, items: review.fold.items.slice(from) },
    }
  }

  /** The checkout's working tree against HEAD — a branch's against its base. */
  function diff(id: string) {
    const p = getPin(id)
    if (!p) return null
    return { id, base: p.base, ...readDiff(p.path, p.base) }
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

  /** A run in a chat — a work session unless `argv` says otherwise. */
  async function start(p: Pin, chat: Chat, prompt: string, argv?: string[]) {
    const { askArgv } = await loadAskClaude()
    cancelFollowUps(p)
    const forking = !chat.session && !!chat.forkOf
    argv ??= askArgv({ session: chat.session ?? chat.forkOf, fork: forking, work: { budget: p.budget, hooks: p.hooks } })
    const file    = logFile(p.id, chat.id)
    const child = launch(file, p.path, argv, prompt, async (code, signal) => {
      const still = getPin(p.id)
      if (!still) return
      const stopped = stopping.delete(p.id)
      appendLine(file, { type: 'exit', code, signal, stopped, at: new Date().toISOString() })
      // The session id is read off the log rather than caught off the stream,
      // so a run that outlived an API restart still leaves its id behind.
      const f = await fold(file)
      const now = updatePin(p.id, {
        pid: null, runChat: null,
        chats: still.chats.map(c => c.id === chat.id ? { ...c, session: f.session ?? c.session } : c),
      })
      const next = queues.get(p.id)?.shift()
      const same = chatIn(now, chat.id)
      if (next !== undefined && same) { await start(now, same, next); return }
      if (!stopped) await followUp(p.id, f.run.state)
    })
    updatePin(p.id, { pid: child.pid ?? null, runChat: chat.id })
  }

  // ─── the Run tab ──────────────────────────────────────────────────────
  // A dev server or a script, started from the inventory by row id. It is
  // not a chat run: Stop on the chat leaves it up, and a new message does not
  // touch it. Unpin and Archive stop it, since the folder it serves goes.

  /** Without this API's own variables and the ports `fli dev` handed it: a
   *  server that read `FLI_PORT_BE` would bind this API's port. */
  function runEnv() {
    const out = childEnv()
    for (const key of Object.keys(out)) if (key.startsWith('FLI_PORT_')) delete out[key]
    return { ...out, NO_COLOR: '1' }
  }

  async function runnables(id: string) {
    const p = getPin(id)
    if (!p) return null
    const rows = await inventory(p.path, p.name)
    return { id, rows: rows.map(({ argv: _argv, ...r }) => r) }
  }

  async function run(id: string, rowId: unknown): Promise<{ started: string } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const gone = goneRefusal(p)
    if (gone) return gone
    const row = (await inventory(p.path, p.name)).find(r => r.id === rowId)
    if (!row) return { refused: `${p.name} has nothing to run called '${rowId}'` }
    const had = p.runs[row.id]
    if (had && alive(had.pid)) return { refused: `${row.name} is already running (pid ${had.pid}) — stop it first` }
    const argv = resolveArgv(p.path, row)
    if ('refused' in argv) return argv

    mkdirSync(join(root, 'logs'), { recursive: true })
    const file = runFile(id, row.id)
    const at   = new Date().toISOString()
    writeFileSync(file, `$ ${row.start}${row.dir === '.' ? '' : `   (in ${row.dir})`}\n`)
    const fd = openSync(file, 'a')
    let child
    try {
      // Its own group, so Stop reaches what a launcher started; unref'd, so a
      // restart of this API leaves it serving.
      child = spawn(argv[0], argv.slice(1), { cwd: join(p.path, row.dir), detached: true, env: runEnv(), stdio: ['ignore', fd, fd] })
    } finally { closeSync(fd) }
    child.unref()
    // Only onto this start's record: an unpin, an archive or a second start
    // since has removed or replaced it, and its log with it.
    let over = false
    const ended = (line: string, exit: RunRecord['exit']) => {
      if (over) return
      over = true
      const now = getPin(id)
      const cur = now?.runs[row.id]
      if (cur?.at !== at) return
      appendFileSync(file, line)
      updatePin(id, { runs: { ...now!.runs, [row.id]: { ...cur, pid: null, exit } } })
    }
    child.on('error', e => ended(`${e.message}\n`, { code: null, signal: null }))
    child.on('exit', (code, signal) => ended(`\n— exited${signal ? ` on ${signal}` : ` with ${code}`} —\n`, { code, signal }))
    updatePin(id, { runs: { ...p.runs, [row.id]: {
      name: row.name, dir: row.dir, start: row.start, pid: child.pid ?? null, at, exit: null, stopped: false,
    } } })
    return { started: at }
  }

  /** Stop what the Run tab started; on one already stopped, forget it. */
  function halt(id: string, rowId: unknown): { stopped: boolean } | { refused: string } {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const r = p.runs[String(rowId)]
    if (!r) return { refused: `nothing called '${rowId}' was started here` }
    if (alive(r.pid)) {
      killGroup(r.pid)
      updatePin(id, { runs: { ...p.runs, [String(rowId)]: { ...r, stopped: true } } })
      return { stopped: true }
    }
    const { [String(rowId)]: _gone, ...rest } = p.runs
    updatePin(id, { runs: rest })
    rmSync(runFile(id, String(rowId)), { force: true })
    return { stopped: false }
  }

  function output(id: string, rowId: unknown) {
    const p = getPin(id)
    const r = p?.runs[String(rowId)]
    if (!p || !r) return null
    return { id: String(rowId), running: alive(r.pid), lines: tail(runFile(id, String(rowId))) }
  }

  async function runsOf(p: Pin): Promise<PinStatus['runs']> {
    return Promise.all(Object.entries(p.runs).map(async ([id, r]) => {
      const running = alive(r.pid)
      return {
        id, name: r.name, running, stopped: r.stopped,
        // A run that ended while this API was down left no code behind.
        exit: running ? null : r.exit?.code ?? null,
        ports: running && id.startsWith('app:') ? await servedBy(join(p.path, r.dir), portsLock).catch(() => []) : [],
      }
    }))
  }

  // ─── the plan ─────────────────────────────────────────────────────────

  /** The pin's plan, parsed off the file now; `parsed` is null until it exists. */
  async function readPlan(id: string) {
    const p = getPin(id)
    if (!p?.plan) return null
    let text: string
    try { text = readFileSync(join(p.path, p.plan.path), 'utf8') } catch { return { ...p.plan, parsed: null } }
    const { parsePlan } = await loadPlan()
    return { ...p.plan, parsed: parsePlan(text, { file: p.plan.path }) }
  }

  /** A goal written into a plan at `path`, in a new chat that may edit that
   *  file and nothing else. The pin's plan is that path from here on. */
  async function buildPlan(id: string, input: { goal?: unknown, path?: unknown }): Promise<{ chat: string, path: string } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const goal = String(input.goal ?? '').trim()
    if (!goal) return { refused: 'say what the plan is for' }
    const bad = planPathRefusal(input.path)
    if (bad) return { refused: bad }
    const path = String(input.path).trim()
    const gone = goneRefusal(p)
    if (gone) return gone
    if (alive(p.pid)) return { refused: `a chat in ${p.name} is working — one run at a time in a checkout` }
    const shown = await fresh(id)
    const chat  = chatIn(shown!)!
    const now   = updatePin(id, { plan: { path, steps: {} } })
    const { askArgv, buildPlanPrompt } = await loadAskClaude()
    await start(now, chat, buildPlanPrompt({ goal, path }), askArgv({ edit: join(p.path, path) }))
    return { chat: chat.id, path }
  }

  /** Go: the plan's first open box, sent into the shown chat. Refused while
   *  any run is live rather than queued: the marks are read when the step
   *  starts, and read under a run still filing they would hand its rows to
   *  this step. */
  async function go(id: string): Promise<{ step: string, chat: string } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    if (!p.plan) return { refused: `${p.name} has no plan — Build plan writes one` }
    const gone = goneRefusal(p)
    if (gone) return gone
    if (alive(p.pid)) return { refused: `a chat in ${p.name} is working — Go starts the next step once it is done` }
    const plan = await readPlan(id)
    if (!plan?.parsed) return { refused: `nothing is written at ${p.plan.path} yet` }
    const step = plan.parsed.next
    if (!step) return { refused: `every step of ${p.plan.path} is done` }
    const chat = chatIn(p)!
    const [{ stepPrompt }, { phaseOf }, { registerHigh }] = await Promise.all([loadAskClaude(), loadPlan(), loadFile()])
    const record: PlanStep = { chat: chat.id, startedAt: new Date().toISOString(), registerHigh: registerHigh(p.path) }
    const sent = await send(id, stepPrompt({ path: p.plan.path, step, phase: phaseOf(plan.parsed, step) }), chat.id)
    if ('refused' in sent) return sent
    const now = getPin(id)!
    updatePin(id, { plan: { ...now.plan!, steps: { ...now.plan!.steps, [step.id]: record } } })
    return { step: step.id, chat: chat.id }
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
    const gone = goneRefusal(p)
    if (gone) return gone
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
    const gone = goneRefusal(p)
    if (gone) return gone
    const { askArgv, reviewPrompt } = await loadAskClaude()
    const request = (await chatsOf(p)).latest.fold.items.findLast(i => i.kind === 'you')
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

  /** Send a message to a chat, the one shown unless another is named. The
   *  chat already working queues it behind the run; any other is refused. */
  async function send(id: string, prompt: string, chat?: unknown): Promise<{ queued: number } | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const c = chatIn(p, chat)
    if (!c) return { refused: `${p.name} has no chat '${chat}'` }
    const text = prompt.trim()
    if (!text) return { refused: 'say something' }
    const gone = goneRefusal(p)
    if (gone) return gone
    if (alive(p.pid)) {
      if (p.runChat !== c.id) return { refused: `another chat in ${p.name} is working — one run at a time in a checkout; Fork for a second` }
      const q = queues.get(id) ?? []
      q.push(text)
      queues.set(id, q)
      return { queued: q.length }
    }
    await start(p, c, text)
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

  /** A new chat, shown. One shown with nothing in it yet is kept rather than
   *  joined by another, and forks nothing. A run elsewhere keeps going. */
  async function fresh(id: string): Promise<Pin | null> {
    const p = getPin(id)
    if (!p) return null
    const shown = chatIn(p)
    if (shown && !shown.session && !(await fold(logFile(id, shown.id))).items.length)
      return updateChat(id, shown.id, { forkOf: null })
    const next = newChat()
    return updatePin(id, { chats: [...p.chats, next], chat: next.id })
  }

  /** Show another chat. */
  function select(id: string, chat: unknown): Pin | { refused: string } {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const c = chatIn(p, chat)
    if (!c || chat == null || chat === '') return { refused: `${p.name} has no chat '${chat}'` }
    return updatePin(id, { chat: c.id })
  }

  /** Forget a chat here — Claude Code keeps its session — keeping what it cost.
   *  The one shown passes to its neighbour; the last one stays. */
  async function close(id: string, chat: unknown): Promise<Pin | { refused: string }> {
    const p = getPin(id)
    if (!p) return { refused: `no pinned checkout '${id}'` }
    const c = chat == null || chat === '' ? null : chatIn(p, chat)
    if (!c) return { refused: `${p.name} has no chat '${chat}'` }
    if (p.chats.length === 1) return { refused: `${p.name} has one chat — New chat starts another` }
    if (alive(p.pid) && p.runChat === c.id) return { refused: 'that chat is working; stop it before closing it' }
    const file = logFile(id, c.id)
    const closedByDay = { ...p.closedByDay }
    for (const [day, cost] of Object.entries((await fold(file)).byDay)) closedByDay[day] = (closedByDay[day] ?? 0) + cost
    rmSync(file, { force: true })
    folds.delete(file)
    const at    = p.chats.findIndex(x => x.id === c.id)
    const chats = p.chats.filter(x => x.id !== c.id)
    const shown = p.chat === c.id ? chats[Math.max(0, at - 1)].id : p.chat
    return updatePin(id, { chats, chat: shown, closedByDay })
  }

  function seen(id: string) {
    return updatePin(id, { seenAt: new Date().toISOString() })
  }

  return {
    dir: root, readPins, getPin, pin, unpin, configure, statuses, status, transcript, diff,
    send, stop, fresh, select, close, seen, check, review, fork, land, archive, archiveRefusal, recordOpened,
    runnables, run, halt, output, readPlan, buildPlan, go,
  }
}
