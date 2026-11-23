// src/door.ts — `claudeDoor`: the local `claude` program as a one-answer door.
//
// A door is `@frontierjs/toolbelt/ask`'s contract: one question in, one `Reply`
// out, never a throw, never a retry, a reason from the closed set when nothing
// answered. `forbidden` and `refused` are never produced here: this door has no
// account check and sends no request of its own to be malformed, so the program
// reports either as an ordinary error, which reads as `model_error`.
//
// The posture is a completion, not a session: no tools unless the caller allows
// them, no hooks (a Stop hook that blocks would spend the answer's turns), no
// settings files and so no project CLAUDE.md steering it, no MCP server but the
// one the caller names, no session kept, and `dontAsk` so a call outside the
// allow list is denied rather than waiting on a prompt nobody will see.
//
// The prompt goes in on stdin, never argv: a document is longer than one argv
// string may be and may start with a dash. An MCP server's headers go in a 0600
// file in a throwaway directory, never argv, where `ps` would show them.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unanswered } from '@frontierjs/toolbelt/ask'
import type { AskOptions, Door, Failure, Question, Reason, Reply } from '@frontierjs/toolbelt/ask'
import { mcpConfigOf, type Agent, type Answer } from './argv.ts'
import type { AskEvent } from './events.ts'
import { runAsk } from './run.ts'

export type ClaudeDoorOptions = {
  /** The door's model; absent, the account's default. A question's own `model` wins. */
  model?:     string
  /** `null` or absent leaves the effort to the account. */
  effort?:    string | null
  /** `--allowedTools` rules, e.g. `Read`, `Bash(rg:*)`. Absent, the model has no tool. */
  allow?:     readonly string[]
  /** One MCP server; its headers stay out of argv. */
  agent?:     Agent
  addDirs?:   readonly string[]
  /** Defaults to the question's throwaway directory. */
  cwd?:       string
  budget?:    number
  /** Wall clock; default 300 000. */
  timeoutMs?: number
  /** Keep the session, and report its id in `run.session`. */
  persist?:   boolean
  /** Continue this session; implies `persist`. */
  resume?:    string
  /** Every drawn event, so a host can show tool calls as progress. */
  onEvent?:   (event: AskEvent) => void
  bin?:       string
  env?:       Record<string, string | undefined>
}

/** What only this door knows about a run. */
export type Run = { session: string | null, turns: number | null, denials: string[] }
export type ClaudeReply = Reply & { run: Run }

const TIMEOUT_MS = 300_000
const KILL_GRACE_MS = 2_000
const REDACTED = '[redacted]'

const SIGNED_OUT = /not logged in|\/login|authenticat/i
const RATE_LIMITED = /usage limit|rate limit|overloaded|too many requests/i
const MODEL_GONE = /unknown model|invalid model|model.{0,40}(not found|does not exist|may not exist|not available)|issue with the selected model/i
const TOO_LONG = /prompt is too long|too long|context (length|window)/i

type Result = {
  subtype?: string, is_error?: boolean, result?: unknown, structured_output?: unknown
  total_cost_usd?: number, num_turns?: number, session_id?: string
  usage?: Record<string, number> | null
  permission_denials?: Array<{ tool_name?: string, tool_input?: Record<string, unknown> }>
}

const WORDS: Partial<Record<Reason, string>> = {
  not_set_up: 'The claude command is not installed or not on PATH.',
  signed_out: 'claude is not signed in on this machine. Run `claude` and sign in with /login.',
  cut_off:    'The run hit its budget or turn limit before it answered.',
}

export function claudeDoor(options: ClaudeDoorOptions = {}): Door {
  const door = async (question: Question, opts: AskOptions = {}): Promise<ClaudeReply> => {
    const t0 = Date.now()
    const keep = !!(options.persist || options.resume)
    const run: Run = { session: null, turns: null, denials: [] }
    let requested = opts.model || options.model || ''
    const secrets = Object.values(options.agent?.headers ?? {}).filter(v => typeof v === 'string' && v).sort((a, b) => b.length - a.length)
    const clean = (text: unknown) => secrets.reduce((t, v) => t.split(v).join(REDACTED), String(text ?? ''))
    const fail = (reason: Reason, detail?: unknown, model = ''): ClaudeReply => ({
      ok: false, door: 'claude', model: model || requested || 'default', ms: Date.now() - t0, run,
      failure: unanswered(reason, WORDS[reason], detail == null ? undefined : clean(detail)) as Failure,
    })

    let dir: string | null = null
    try {
      if (opts.signal?.aborted) return fail('aborted', undefined, '')
      dir = await mkdtemp(join(tmpdir(), 'frontierjs-door-'))
      let mcpConfig: string | null = null
      if (options.agent) {
        mcpConfig = join(dir, 'mcp.json')
        await writeFile(mcpConfig, JSON.stringify(mcpConfigOf(options.agent)), { mode: 0o600 })
      }
      const answer: Answer = {
        schema: question.schema ?? null, system: question.system ?? null, allow: options.allow,
        agent: options.agent ?? null, mcpConfig, addDirs: options.addDirs, budget: options.budget, persist: keep,
      }

      let init: { model?: string, session_id?: string } | null = null
      let result: Result | null = null
      let spawnError: NodeJS.ErrnoException | null = null
      let stderr = ''
      const started = runAsk({
        root: options.cwd ?? dir, prompt: question.prompt, answer,
        session: options.resume ?? null, model: opts.model || options.model || null,
        effort: options.effort ?? null, bin: options.bin, env: options.env,
        onFrame: (f: any) => {
          if (f?.type === 'system' && f.subtype === 'init') init = f
          else if (f?.type === 'result') result = f
        },
        // runAsk's own `error` events are the stderr tail and the spawn failure; nothing else is one.
        onEvent: (e) => {
          if (e.type === 'error') stderr += `${e.text}\n`
          try { options.onEvent?.(e) } catch { /* a host's progress handler cannot lose the answer */ }
        },
      })
      if ('error' in started) return fail('not_set_up', started.error, '')
      const { child, done } = started
      child.on('error', (e: NodeJS.ErrnoException) => { spawnError = e })

      // Which came first is the reason: a killed run's late frames must not rename it.
      let stopped: 'aborted' | 'timeout' | null = null
      let grace: ReturnType<typeof setTimeout> | undefined
      const stop = (why: 'aborted' | 'timeout') => {
        if (stopped) return
        stopped = why
        signalGroup('SIGTERM')
        grace = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
      }
      const signalGroup = (sig: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig) } catch { /* already gone */ }
      }
      const onAbort = () => stop('aborted')
      opts.signal?.addEventListener('abort', onAbort)
      const clock = setTimeout(() => stop('timeout'), options.timeoutMs ?? TIMEOUT_MS)
      try { await done } finally {
        clearTimeout(clock)
        clearTimeout(grace)
        opts.signal?.removeEventListener('abort', onAbort)
      }

      const frame = init as { model?: string, session_id?: string } | null
      const res = result as Result | null
      const model = frame?.model || requested || 'default'
      requested = model
      if (keep) run.session = res?.session_id ?? frame?.session_id ?? null
      run.turns = typeof res?.num_turns === 'number' ? res.num_turns : null
      run.denials = (res?.permission_denials ?? []).map(d =>
        clean(`${d.tool_name}: ${d.tool_input?.command ?? d.tool_input?.file_path ?? ''}`).slice(0, 200))

      if (!res) {
        const err = spawnError as NodeJS.ErrnoException | null
        if (err?.code === 'ENOENT') return fail('not_set_up', err.message, model)
        if (stopped) return fail(stopped, stderr.trim(), model)
        if (SIGNED_OUT.test(stderr)) return fail('signed_out', stderr.trim(), model)
        return fail('lost', (err?.message ?? stderr.trim()) || 'claude exited with no result', model)
      }

      const text = typeof res.result === 'string' ? res.result : ''
      if (res.is_error || (res.subtype && res.subtype !== 'success')) {
        const detail = text || res.subtype
        if (res.subtype === 'error_max_budget_usd' || res.subtype === 'error_max_turns') return fail('cut_off', detail, model)
        if (res.subtype === 'error_max_structured_output_retries') return fail('no_answer', detail, model)
        if (res.subtype === 'error_during_execution') return fail('model_error', detail, model)
        if (res.is_error) {
          if (SIGNED_OUT.test(text)) return fail('signed_out', detail, model)
          if (RATE_LIMITED.test(text)) return fail('rate_limited', detail, model)
          if (MODEL_GONE.test(text)) return fail('model_gone', detail, model)
          if (TOO_LONG.test(text)) return fail('too_long', detail, model)
        }
        return fail('model_error', detail, model)
      }

      const structured = res.structured_output
      if (question.schema && (structured === null || typeof structured !== 'object' || Array.isArray(structured))) return fail('no_answer', text, model)
      const u = res.usage
      return {
        ok: true, door: 'claude', model, ms: Date.now() - t0, run,
        answer: question.schema ? structured as Record<string, unknown> : text,
        usage: u ? {
          inputTokens:  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
        } : null,
        costUsd: typeof res.total_cost_usd === 'number' ? res.total_cost_usd : null,
      }
    } catch (e) {
      return fail('lost', e instanceof Error ? e.message : String(e))
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  return door as Door
}
