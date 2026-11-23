// src/session.ts — one long-lived `claude` held open over stream-json: a
// message in, its events out, its permission prompts answered by the host
// (docs/control-protocol.md). The argv is `sessionArgv`, the control channel
// `protocol.ts`, the reading `readAskEvent`; a host keeps one Session per
// chat, and anything about its own page (a diff on a card, where a chat is
// stored) through `card` and the `on*` callbacks.

import { spawn, type ChildProcess } from 'node:child_process'
import { sessionArgv } from './argv.ts'
import { type Command, commandsOf, type Init, initOf, MODES, mergeCommands, type ModelChoice, modelsOf, type Usage, usageOf } from './catalog.ts'
import { agentCall, agentEventOf, type AskEvent, readAskEvent } from './events.ts'
import { askCard, askSummary, BadAnswer, type Card, decide, type Extra } from './permission.ts'
import { type Ask, ControlError, type Decision, type Frame, LineReader, Protocol } from './protocol.ts'

/**
 * What a session tells its host. The stream's events (`AskEvent`), each a
 * subagent's tagged `agent` with its Agent call's id; then the control side:
 * a permission prompt and its answer (`withdrawn` when the CLI dropped it or
 * the process went), a message sent mid-turn being consumed into it, a
 * project hook's output, and the end of a turn.
 */
export type SessionEvent =
  | AskEvent
  | (AskEvent & { agent: string })
  | { type: 'permission', request: string, tool: string, text: string, toolUse: string | null, card: Card & Record<string, unknown> }
  | { type: 'answered', request: string, behavior: 'allow' | 'deny' | 'withdrawn', always?: true }
  | { type: 'joined' }
  | { type: 'hook', name: string, outcome: string | null, code: number | null, text: string }
  | { type: 'end', code: number | null, stopped: boolean }

export type SessionOptions = {
  /** The folder the process runs in. */
  cwd:             string
  /** A stored session to resume; one that is not a Claude session id is dropped by `sessionArgv`. */
  session?:        string | null
  model?:          string | null
  effort?:         string | null
  permissionMode?: string | null
  allowBypass?:    boolean
  /** The program, `claude` on PATH unless a host names another. */
  command?:        string
  /** The child's environment, the host's own unless it passes a narrower one. */
  env?:            Record<string, string | undefined>
  /** Names this side in its request ids, the refusal of a request it does not serve, and a deny's note. */
  host?:           string
  onEvent:         (e: SessionEvent) => void
  /** The CLI reported a permission mode other than the last one: what it says wins over what was asked. */
  onMode?:         (mode: string) => void
  /** A `system/init` that differs from the last one (init comes every turn). */
  onInit?:         (i: Init) => void
  /** The `/` list changed: the `initialize` answer's commands with the names `system/init` adds. */
  onCommands?:     (c: Command[]) => void
  /** The `initialize` answer's models, heard once per process when it listed any. */
  onModels?:       (m: ModelChoice[]) => void
  /** How full the context is, read after each turn's result. */
  onUsage?:        (u: Usage) => void
  /** What the host adds to a prompt's card, asked when the prompt arrives and each time `cards()` is read. */
  card?:           (a: Ask) => Record<string, unknown>
  /** The process ended, on purpose or not; called before the events that report it. */
  onExit?:         () => void
}

/** How long a `get_context_usage` gets before the reading is skipped: the meter keeps the last one. */
const USAGE_MS = 5000

/** How long a process ended on purpose gets after stdin closes before its group is signalled. */
const GRACE_MS = 1000

export class Session {
  readonly cwd: string
  private child: ChildProcess
  private proto: Protocol
  private host: string
  /** True from a send until the `result` that ends the turn every written message joined. */
  private turn = false
  private stopped = false
  /** Oldest first: the CLI echoes each message (`isReplay`) as it consumes it, in the order written. */
  private written: { queued: boolean }[] = []
  /** Set when the host ends the process on purpose, so its exit is not reported as a death. */
  private closing = false
  private ended = false
  private mode: string | null
  private init: string | null = null
  private listed: Command[] = []
  private seen: Init | null = null
  private commands: string | null = null
  /** The tool_use ids of this process's Agent calls: the `task_*` frames of anything else (a background command) are not an agent's. */
  private agents = new Set<string>()

  private o: SessionOptions

  constructor(o: SessionOptions) {
    this.o = o
    this.cwd = o.cwd
    this.host = o.host ?? 'host'
    this.mode = o.permissionMode ?? null
    const command = o.command ?? 'claude'
    const argv = sessionArgv({ session: o.session, permissionMode: o.permissionMode, model: o.model, effort: o.effort, allowBypass: o.allowBypass })
    const env: Record<string, string | undefined> = { ...(o.env ?? process.env) }
    // Inherited from a Claude Code session that started the host, these mislabel the child as that session.
    env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    delete env.CLAUDECODE
    const child = spawn(command, argv, { cwd: o.cwd, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.proto = new Protocol((line) => {
      if (child.stdin?.writable) child.stdin.write(line)
    }, this.host)

    const reader = new LineReader()
    const take = (r: { frames: Frame[], junk: string[] }) => {
      for (const f of r.frames) this.frame(f)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => take(reader.push(chunk)))
    // stderr is where `claude` says it is not logged in; shown as said when the process dies.
    let err = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { err = (err + chunk).slice(-8000) })

    let spawnError: string | null = null
    const died = (code: number | null) => {
      if (this.ended) return
      this.ended = true
      take(reader.flush())
      o.onExit?.()
      if (this.closing) return
      for (const request of this.proto.close('Claude Code exited')) o.onEvent({ type: 'answered', request, behavior: 'withdrawn' })
      const tail = err.trim().split('\n').slice(-5).join('\n')
      if (spawnError) o.onEvent({ type: 'error', text: spawnError })
      else if (this.turn) o.onEvent({ type: 'error', text: `Claude Code exited mid-turn (code ${code ?? 'none'})${tail ? `: ${tail}` : ''}. The next message resumes the session.` })
      else if (code) o.onEvent({ type: 'error', text: `Claude Code exited (code ${code})${tail ? `: ${tail}` : ''}` })
      if (this.turn || spawnError) o.onEvent({ type: 'end', code, stopped: this.stopped })
      this.turn = false
      // The rest of the group goes with it.
      if (child.pid !== undefined) try { process.kill(-child.pid, 'SIGTERM') } catch {}
    }
    child.on('error', (e) => {
      spawnError = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${command} is not installed or not on PATH` : e.message
      died(null)
    })
    // A closed stdin means no further message can reach it: the process is as good as gone.
    child.stdin?.on('error', () => { if (!this.closing) try { child.kill('SIGTERM') } catch {} })
    // `close`, not `exit`: the last stdout lines, the result among them, arrive after exit.
    child.on('close', (code) => died(code))

    // The answer holds the commands with their descriptions, ahead of the first turn's system/init.
    this.proto.initialize()
      .then((r) => {
        this.listed = commandsOf(r)
        this.listCommands()
        const models = modelsOf(r)
        if (models.length && !this.closing) o.onModels?.(models)
      })
      .catch(() => {})
  }

  /** Whether a turn is running. */
  get running(): boolean {
    return this.turn
  }

  /** Whether the process waits on a permission answer. */
  get asking(): boolean {
    return this.proto.asks.size > 0
  }

  /** Whether `request` is a prompt this process waits on. */
  waits(request: string): boolean {
    return this.proto.asks.has(request)
  }

  /** The prompts the process waits on, with what each card needs. */
  cards(): ({ request: string, tool: string } & Card & Record<string, unknown>)[] {
    return [...this.proto.asks.values()].map((a) => ({ request: a.request, tool: a.tool, ...this.cardOf(a) }))
  }

  /** Writes one user message. Sent while a turn runs, it joins that turn. */
  send(content: string | unknown[]): { queued: boolean } {
    const queued = this.turn
    if (!queued) this.stopped = false
    this.turn = true
    this.written.push({ queued })
    this.proto.user(content)
    return { queued }
  }

  /** Interrupts the running turn and keeps the process. False with no turn running. */
  stop(): boolean {
    if (!this.turn) return false
    this.stopped = true
    // A failed interrupt is the process dying, which its close reports.
    this.proto.interrupt().catch(() => {})
    return true
  }

  /** Answers a waiting prompt with a person's allow or deny. Throws `BadAnswer` for a choice the request cannot carry. */
  answer(request: string, behavior: unknown, message?: unknown, extra: Extra = {}): Decision {
    const ask = this.proto.asks.get(request)
    if (!ask) throw new BadAnswer(`Claude is not waiting on request ${request.slice(0, 80)}`)
    const decision = decide(ask, behavior, message, extra, this.host)
    if (!decision) throw new BadAnswer('behavior is allow or deny')
    this.proto.answer(request, decision)
    this.o.onEvent({ type: 'answered', request, behavior: decision.behavior, ...(extra.always === true && decision.behavior === 'allow' ? { always: true as const } : {}) })
    return decision
  }

  /** `set_permission_mode`: the mode the CLI reports. */
  async setMode(mode: string): Promise<string> {
    const r = (await this.proto.request('set_permission_mode', { mode })) as { mode?: unknown } | null
    return typeof r?.mode === 'string' ? r.mode : mode
  }

  /** `set_model`: the model the CLI resolved the alias to. */
  async setModel(model: string): Promise<string> {
    const r = (await this.proto.request('set_model', { model })) as { model?: unknown } | null
    return typeof r?.model === 'string' ? r.model : model
  }

  /** There is no `set_effort`, so it is `apply_flag_settings`. */
  async setEffort(level: string): Promise<void> {
    await this.proto.request('apply_flag_settings', { settings: { effortLevel: level } })
  }

  /** Ends the process: stdin closed, then its group signalled. A running turn ends stopped. */
  end(reason = 'the session was ended'): void {
    if (this.closing) return
    this.closing = true
    for (const request of this.proto.close(reason)) this.o.onEvent({ type: 'answered', request, behavior: 'withdrawn' })
    if (this.turn) this.o.onEvent({ type: 'end', code: null, stopped: true })
    this.turn = false
    try { this.child.stdin?.end() } catch {}
    const pid = this.child.pid
    if (pid !== undefined) {
      // A `rg` or a dev server Claude started is in the group and outlives a closed stdin.
      const term = setTimeout(() => { try { process.kill(-pid, 'SIGTERM') } catch {} }, GRACE_MS)
      const kill = setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch {} }, GRACE_MS + 3000)
      term.unref()
      kill.unref()
    }
  }

  private cardOf(a: Ask): Card & Record<string, unknown> {
    return { ...askCard(a), ...(this.o.card?.(a) ?? {}) }
  }

  /** Tells the host the `/` list when it differs from the last one this process gave. */
  private listCommands() {
    if (this.closing || (!this.listed.length && !this.seen)) return
    const merged = mergeCommands(this.listed, this.seen)
    const key = JSON.stringify(merged)
    if (key === this.commands) return
    this.commands = key
    this.o.onCommands?.(merged)
  }

  /** Asks how full the context is. A refused or unanswered request leaves the last reading, and the turn never waits on it. */
  private readUsage() {
    if (!this.o.onUsage) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ControlError('get_context_usage went unanswered')), USAGE_MS)
      timer.unref?.()
    })
    Promise.race([this.proto.request('get_context_usage'), late])
      .then((r) => {
        const u = usageOf(r)
        if (u && !this.closing) this.o.onUsage?.(u)
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer))
  }

  /**
   * A frame's events. Whatever a subagent does carries `parent_tool_use_id`, the
   * Agent call's id, and every event it makes is tagged `agent` with it, so none
   * reaches the main chat as the main Claude's own. An Agent call itself is an
   * `agent` event in the place its tool line would have been, and the `task_*`
   * frames are that agent's start, progress and end.
   */
  private read(f: Frame) {
    const emit = this.o.onEvent
    const parent = typeof f.parent_tool_use_id === 'string' && f.parent_tool_use_id ? f.parent_tool_use_id : null
    if (parent) {
      for (const e of readAskEvent(f)) emit({ ...e, agent: parent })
      return
    }
    if (f.type === 'system') {
      const e = agentEventOf(f, this.agents)
      if (e) emit(e)
      else for (const x of readAskEvent(f)) emit(x)
      return
    }
    const parts = (f.message as { content?: unknown } | undefined)?.content
    if (f.type !== 'assistant' || !Array.isArray(parts)) {
      for (const e of readAskEvent(f)) emit(e)
      return
    }
    // In order, so an Agent call stays between the text and the calls around it.
    for (const part of parts as Record<string, unknown>[]) {
      const agent = agentCall(part)
      if (agent) {
        this.agents.add(agent.id)
        emit(agent)
        continue
      }
      for (const e of readAskEvent({ ...f, message: { ...(f.message as object), content: [part] } })) emit(e)
    }
  }

  private frame(f: Frame) {
    const o = this.o
    const got = this.proto.receive(f)
    if (got.kind === 'ask') {
      o.onEvent({ type: 'permission', request: got.ask.request, tool: got.ask.tool, text: askSummary(got.ask), toolUse: got.ask.toolUseId, card: this.cardOf(got.ask) })
      return
    }
    if (got.kind === 'withdrawn') {
      o.onEvent({ type: 'answered', request: got.request, behavior: 'withdrawn' })
      return
    }
    if (got.kind === 'replay') {
      const w = this.written.shift()
      if (w?.queued) o.onEvent({ type: 'joined' })
      return
    }
    if (got.kind !== 'frame') return
    if (f.type === 'system' && (f.subtype === 'init' || f.subtype === 'status') && typeof f.permissionMode === 'string' && (MODES as readonly string[]).includes(f.permissionMode) && f.permissionMode !== this.mode) {
      this.mode = f.permissionMode
      o.onMode?.(f.permissionMode)
    }
    const init = initOf(f)
    if (init) {
      const key = JSON.stringify(init)
      if (key !== this.init) {
        this.init = key
        o.onInit?.(init)
        this.seen = init
        this.listCommands()
      }
    }
    if (f.type === 'system' && f.subtype === 'hook_response') {
      const out = [f.stdout, f.stderr].filter((x) => typeof x === 'string' && x.trim()).join('\n').trim()
      o.onEvent({ type: 'hook', name: String(f.hook_name ?? f.hook_event ?? 'hook'), outcome: typeof f.outcome === 'string' ? f.outcome : null, code: typeof f.exit_code === 'number' ? f.exit_code : null, text: out.slice(0, 2000) })
      return
    }
    this.read(f)
    if (f.type !== 'result') return
    this.readUsage()
    // A message the CLI has not consumed yet starts the next turn by itself, so the turn goes on.
    this.written = this.written.filter((w) => w.queued)
    if (this.written.length) return
    this.turn = false
    o.onEvent({ type: 'end', code: null, stopped: this.stopped })
    this.stopped = false
  }
}
