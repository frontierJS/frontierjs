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
//   pins.json          the pinned checkouts, in pin order
//   logs/<id>.ndjson   every run in that checkout, appended — a `prompt` line
//                      written here, claude's stream-json, then an `exit` line
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
import { resolveRoot }                 from './local-git.ts'

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
  pinnedAt: string
  seenAt:   string | null
  pid:      number | null
}

export type Item =
  | { kind: 'you',    text: string, at: string }
  | { kind: 'text',   text: string }
  | { kind: 'tool',   text: string }
  | { kind: 'result', ok: boolean, stop: string | null, cost: number | null, turns: number | null }
  | { kind: 'error',  text: string }

export type RunState = 'idle' | 'working' | 'done' | 'error'

export type PinStatus = {
  id:      string
  state:   RunState
  /** What the run is doing now — the last tool call, cleared by text. */
  tool:    string | null
  cost:    number | null
  turns:   number | null
  unread:  boolean
  queued:  number
  /** The log's size: a screen refetches a transcript when this moves. */
  size:    number
  session: string | null
}

type Folded = {
  offset:  number
  partial: string
  items:   Item[]
  session: string | null
  run:     { state: RunState, tool: string | null, cost: number | null, turns: number | null }
}

/** Kept per chat; older items stay in the log and in Claude Code's own session. */
const MAX_ITEMS = 400

const DEFAULT_BUDGET = 10

const freshFold = (): Folded => ({
  offset: 0, partial: '', items: [], session: null,
  run: { state: 'idle', tool: null, cost: null, turns: null },
})

export const pinId = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 12)

function alive(pid: number | null): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// The cli is a devDependency and the image installs none, so it is reached
// only on a machine where the workbench is offered at all.
type AskClaude = {
  askArgv:       (o: { session?: string | null, work?: { budget?: number, hooks?: boolean } }) => string[]
  readAskEvent:  (event: unknown) => Array<Record<string, any>>
  resumeCommand: (root: string, session: string) => string | null
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
  const logFile  = (id: string) => join(root, 'logs', `${id}.ndjson`)
  const folds    = new Map<string, Folded>()
  const queues   = new Map<string, string[]>()

  // ─── pins ─────────────────────────────────────────────────────────────

  function readPins(): Pin[] {
    try { return JSON.parse(readFileSync(pinsFile, 'utf8')).pins ?? [] } catch { return [] }
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
      budget: DEFAULT_BUDGET, hooks: false, pinnedAt: new Date().toISOString(), seenAt: null, pid: null,
    }
    writePins([...pins, next])
    return { pin: next }
  }

  /** Unpinning stops a run and forgets the chat; Claude Code keeps its session. */
  function unpin(id: string) {
    stop(id)
    writePins(readPins().filter(p => p.id !== id))
    rmSync(logFile(id), { force: true })
    folds.delete(id)
  }

  function configure(id: string, patch: { name?: unknown, budget?: unknown, hooks?: unknown }): Pin | { refused: string } {
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
    if (patch.hooks !== undefined) out.hooks = patch.hooks === true
    return updatePin(id, out)
  }

  // ─── the log ──────────────────────────────────────────────────────────

  function appendLine(id: string, line: object) {
    mkdirSync(join(root, 'logs'), { recursive: true })
    appendFileSync(logFile(id), JSON.stringify(line) + '\n')
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
    if (event.type === 'new') { Object.assign(f, freshFold(), { offset: f.offset, partial: f.partial }); return }
    if (event.type === 'prompt') {
      push(f, { kind: 'you', text: String(event.text ?? ''), at: String(event.at ?? '') })
      f.run = { state: 'working', tool: null, cost: null, turns: null }
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
        f.run = { state: e.ok ? 'done' : 'error', tool: null, cost: e.cost, turns: e.turns }
      }
    }
  }

  /** The log folded up to its current end, reading only the bytes since last time. */
  async function fold(id: string): Promise<Folded> {
    const file = logFile(id)
    let f = folds.get(id) ?? freshFold()
    let size = 0
    try { size = statSync(file).size } catch { folds.delete(id); return freshFold() }
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
    folds.set(id, f)
    return f
  }

  async function status(p: Pin): Promise<PinStatus> {
    const f = await fold(p.id)
    let state = f.run.state
    // A run whose process is gone and wrote no result died with the API's
    // previous process, which was the one that would have written `exit`.
    if (state === 'working' && !alive(p.pid)) state = 'error'
    let mtime = 0
    try { mtime = statSync(logFile(p.id)).mtimeMs } catch {}
    const ended = state === 'done' || state === 'error'
    return {
      id: p.id, state, tool: state === 'working' ? f.run.tool : null,
      cost: f.run.cost, turns: f.run.turns,
      unread: ended && (!p.seenAt || mtime > Date.parse(p.seenAt)),
      queued: queues.get(p.id)?.length ?? 0,
      size:   f.offset, session: p.session,
    }
  }

  async function statuses(): Promise<PinStatus[]> {
    return Promise.all(readPins().map(status))
  }

  async function transcript(id: string) {
    const p = getPin(id)
    if (!p) return null
    const f = await fold(id)
    const { resumeCommand } = await loadAskClaude()
    return { id, items: f.items, resume: p.session ? resumeCommand(p.path, p.session) : null }
  }

  // ─── runs ─────────────────────────────────────────────────────────────

  async function start(p: Pin, prompt: string) {
    const { askArgv } = await loadAskClaude()
    appendLine(p.id, { type: 'prompt', text: prompt, at: new Date().toISOString() })

    const childEnv: Record<string, string | undefined> = { ...process.env }
    for (const key of Object.keys(env)) delete childEnv[key]

    // The child gets its own descriptor on the log and keeps writing after this
    // process is gone; O_APPEND keeps its lines and the `exit` line whole.
    const fd = openSync(logFile(p.id), 'a')
    let child
    try {
      child = spawn(bin, askArgv({ session: p.session, work: { budget: p.budget, hooks: p.hooks } }), {
        cwd: p.path, detached: true, env: childEnv, stdio: ['pipe', fd, fd],
      })
    } finally { closeSync(fd) }
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
    child.unref()

    // A spawn that fails emits `error` and may never emit `exit`; either one
    // ends the run, once.
    let ended = false
    const finish = async (code: number | null, signal: string | null) => {
      if (ended) return
      ended = true
      const still = getPin(p.id)
      if (!still) return
      appendLine(p.id, { type: 'exit', code, signal, stopped: stopping.delete(p.id), at: new Date().toISOString() })
      // The session id is read off the log rather than caught off the stream,
      // so a run that outlived an API restart still leaves its id behind.
      const f = await fold(p.id)
      updatePin(p.id, { pid: null, session: f.session ?? still.session })
      const next = queues.get(p.id)?.shift()
      if (next !== undefined) await start(getPin(p.id)!, next)
    }
    child.on('error', e => {
      const code = (e as NodeJS.ErrnoException).code
      // A plain line: the fold reads anything not JSON as an error to show.
      appendFileSync(logFile(p.id), `${code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message}\n`)
      finish(null, null)
    })
    child.on('exit', (code, signal) => { finish(code, signal) })
    updatePin(p.id, { pid: child.pid ?? null })
  }

  const stopping = new Set<string>()

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

  /** Stop the run and drop the queue. Signals the GROUP — a run's own
   *  children (a test runner, a dev server) go with it. */
  function stop(id: string): boolean {
    queues.delete(id)
    const p = getPin(id)
    if (!p || !alive(p.pid)) return false
    stopping.add(id)
    try { process.kill(-p.pid!, 'SIGTERM') } catch { try { process.kill(p.pid!, 'SIGTERM') } catch {} }
    return true
  }

  /** A new chat: the next message starts a session instead of resuming one. */
  function fresh(id: string) {
    const p = getPin(id)
    if (!p) return null
    if (alive(p.pid)) return { refused: 'stop the run before starting a new chat' }
    appendLine(id, { type: 'new' })
    return updatePin(id, { session: null })
  }

  function seen(id: string) {
    return updatePin(id, { seenAt: new Date().toISOString() })
  }

  return { dir: root, readPins, getPin, pin, unpin, configure, statuses, status, transcript, send, stop, fresh, seen }
}
