// src/run.ts — start one question as a detached `claude -p` and read its stream.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { askArgv, SESSION_ID, type AskProfile } from './argv.ts'
import { readAskEvent, type AskEvent } from './events.ts'
import { askInput, type Image } from './images.ts'
import { ASK_EFFORT, EFFORTS, isEffort } from './limits.ts'

export type RunAskOptions = AskProfile & {
  root:     string
  prompt:   string
  images?:  readonly Image[]
  /** `null` leaves the effort to the account. */
  effort?:  string | null
  model?:   string | null
  fork?:    boolean
  partial?: boolean
  appendSystem?: string | null
  bin?:     string
  env?:     Record<string, string | undefined>
  onEvent?: (event: AskEvent) => void
  /** Every parsed stdout line, before it is read into events; a loop that folds the raw frames takes this. */
  onFrame?: (frame: any) => void
  /**
   * Append stdout and stderr to this file instead of piping them: the child
   * holds its own descriptor, so it keeps writing, and its lines stay whole,
   * after this process is gone. Nothing is read, so no `onEvent` but a spawn
   * failure's `error`; the reader of the file is the caller's.
   */
  log?:     string
  /** Once, when the child exits (or never starts: `null, null`), with the signal that ended it. */
  onExit?:  (code: number | null, signal: string | null) => void
}

/** A started run; `done` resolves to the exit code, or null when it never started. */
export type AskRun = { child: ChildProcess, done: Promise<number | null> }

/**
 * Start one question. Returns `{ error }` for a session id or effort that is not
 * one, or an agent with no server, or the run. Detached, so a stop signals the
 * group and takes a running `rg` with it.
 */
export function runAsk({ root, prompt, session = null, edit = null, reads = [], work = null, agent = null, draw = null, answer = null, bash, budget, images = [], effort = ASK_EFFORT, model = null, fork = false, partial = false, appendSystem = null, bin = 'claude', env = process.env, onEvent, onFrame, log, onExit }: RunAskOptions): AskRun | { error: string } {
  if (session && !SESSION_ID.test(String(session)))
    return { error: `not a session id: ${JSON.stringify(String(session).slice(0, 40))}` }
  if ((agent && !agent.server) || (answer?.agent && !answer.agent.server))
    return { error: 'an agent names its MCP server' }
  if (effort !== null && !isEffort(effort))
    return { error: `no such effort: ${JSON.stringify(String(effort).slice(0, 40))} — one of ${EFFORTS.join(', ')}` }

  const argv = askArgv({ session, edit, reads, work, agent, draw, answer, bash, budget, effort, model, fork, partial, appendSystem, images: images.length > 0 })
  let child: ChildProcess
  if (log) {
    const fd = openSync(log, 'a')
    try { child = spawn(bin, argv, { cwd: root, detached: true, env, stdio: ['pipe', fd, fd] }) } finally { closeSync(fd) }
    child.unref()
  } else {
    child = spawn(bin, argv, { cwd: root, detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  child.stdin!.on('error', () => {})
  child.stdin!.end(askInput(prompt, images))

  let exited = false
  const exit = (code: number | null, signal: string | null) => {
    if (exited) return
    exited = true
    onExit?.(code, signal)
  }
  if (log) {
    const done = new Promise<number | null>(ok => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        onEvent?.({ type: 'error', text: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message })
        exit(null, null)
        ok(null)
      })
      child.on('exit', (code, signal) => { exit(code, signal); ok(code) })
    })
    return { child, done }
  }

  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      let event: unknown
      try { event = JSON.parse(line) } catch { continue }
      onFrame?.(event)
      for (const e of readAskEvent(event)) onEvent?.(e)
    }
  })

  // stderr is where `claude` says it is not logged in or not installed; the
  // page shows it as said rather than as a silent empty answer.
  let err = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => { err += chunk })

  const done = new Promise<number | null>(ok => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      onEvent?.({ type: 'error', text: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message })
      exit(null, null)
      ok(null)
    })
    child.on('close', (code, signal) => {
      if (code && err.trim()) onEvent?.({ type: 'error', text: err.trim().split('\n').slice(-5).join('\n') })
      exit(code, signal)
      ok(code)
    })
  })
  return { child, done }
}
