// src/lib/study/session.js — one Claude session, a tab of the study
// (`IDEAS/study.md` 1.2): `claude -p` held open over stream-json, a line in,
// its events folded into the messages the pane draws.
//
// A tab is one long-lived child (study.md 0.2): every line goes to the same
// stdin and is answered under the same session id, and closing stdin ends it
// with 0. Without `--verbose` the CLI refuses stream-json output.
//
// Until the permission panel (2.3) a session runs under `--permission-mode
// auto` with no prompt tool, so a call auto refuses is denied, never asked.
//
// Terminal only, and no `#` seam: the study mounts only from a checkout, so no
// browser build reaches this file.
import { spawn } from 'node:child_process'

/** The env naming another binary, for the study and `agents/agents.js` alike — a test's stub answers for nothing. */
export const CLAUDE_ENV = 'HAVEN_AGENTS_CLAUDE'

/** The argv of a session; `resume` reopens one by its id. */
export function studyArgv({ resume, model, permissionMode = 'auto' } = {}) {
  const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permissionMode]
  if (model) argv.push('--model', model)
  if (resume) argv.push('--resume', resume)
  return argv
}

// ─── the fold ─────────────────────────────────────────────────────────────────
//
// A message is one of
//   { kind: 'you', text }                         a line sent
//   { kind: 'said', text } / { kind: 'thought', text }
//   { kind: 'tool', id, name, line, done, failed } a call, marked by its result
//   { kind: 'turn', ms, cost, error }             a turn's end
//   { kind: 'error', text }                       the process, not the model
// A subagent's events carry `parent_tool_use_id` and are left out, since its
// calls would bury the session's own.

/** A session before anything was heard. */
export const fresh = () => ({ sessionId: null, model: null, status: 'idle', pending: 0, cost: 0, messages: [], exit: null })

/** The input field that says what a call does, cut to one line. */
export function toolLine(name, input = {}) {
  const said = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? ''
  return `${name}${said ? ` ${String(said).split('\n')[0]}` : ''}`
}

const add = (s, ...m) => ({ ...s, messages: [...s.messages, ...m] })

/** `state` after one event of the stream, `state` itself when it changes nothing. */
export function fold(state, ev) {
  if (!ev || typeof ev !== 'object' || ev.parent_tool_use_id) return state
  if (ev.type === 'system' && ev.subtype === 'init')
    return { ...state, sessionId: ev.session_id ?? state.sessionId, model: ev.model ?? state.model }
  if (ev.type === 'assistant') {
    const out = []
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'said', text: b.text })
      else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ kind: 'thought', text: b.thinking })
      else if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id, name: b.name, line: toolLine(b.name, b.input), done: false, failed: false })
    }
    return out.length ? add(state, ...out) : state
  }
  if (ev.type === 'user') {
    const results = (Array.isArray(ev.message?.content) ? ev.message.content : []).filter((b) => b.type === 'tool_result')
    if (!results.length) return state
    const by = new Map(results.map((r) => [r.tool_use_id, r]))
    return { ...state, messages: state.messages.map((m) => m.kind === 'tool' && by.has(m.id) ? { ...m, done: true, failed: !!by.get(m.id).is_error } : m) }
  }
  if (ev.type === 'result') {
    const pending = Math.max(0, state.pending - 1)
    // The process's running total, not the turn's: summed, every turn counts the ones before it again.
    const total = Number(ev.total_cost_usd) || state.cost
    const error = ev.is_error ? String(ev.result || ev.subtype || 'error').replaceAll('_', ' ') : null
    return add({ ...state, sessionId: ev.session_id ?? state.sessionId, pending, status: pending ? 'working' : 'idle', cost: total },
      { kind: 'turn', ms: Number(ev.duration_ms) || 0, cost: total - state.cost, error })
  }
  return state
}

/** `state` after a line is sent. */
export const sent = (state, text) => add({ ...state, pending: state.pending + 1, status: 'working' }, { kind: 'you', text })

// ─── the process ──────────────────────────────────────────────────────────────

/**
 * Start a session in `cwd`. `send(text)` is a line; `end()` closes stdin and
 * the child exits on its own; `kill()` does not wait. The child is killed with
 * the process, so a tab never outlives Haven. `subscribe(fn)` hears every
 * state, `fn(state)`, and returns its removal.
 *
 * @param {{ cwd?: string, resume?: string, model?: string, bin?: string, permissionMode?: string }} [opts]
 */
export function startSession({ cwd = process.cwd(), resume, model, bin = process.env[CLAUDE_ENV] || 'claude', permissionMode } = {}) {
  let state = fresh()
  const listeners = new Set()
  const set = (next) => {
    if (next === state) return
    state = next
    for (const fn of listeners) fn(state)
  }

  let child
  try {
    child = spawn(bin, studyArgv({ resume, model, permissionMode }), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    state = add(state, { kind: 'error', text: `${bin}: ${e.message}` })
    state = { ...state, exit: { code: null } }
  }
  const kill = () => child?.kill('SIGTERM')

  if (child) {
    process.once('exit', kill)
    let buf = '', err = ''
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        set(fold(state, ev))
      }
    })
    child.stderr.setEncoding('utf8').on('data', (c) => { err += c })
    child.stdin.on('error', () => {})
    child.on('error', (e) => {
      set(add(state, { kind: 'error', text: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH (${CLAUDE_ENV} names another)` : e.message }))
    })
    child.on('close', (code, signal) => {
      process.off('exit', kill)
      const why = code && err.trim() ? [{ kind: 'error', text: `${bin} exited ${code}: ${err.trim().split('\n').at(-1)}` }] : []
      set(add({ ...state, status: 'idle', pending: 0, exit: { code, signal } }, ...why))
    })
  }

  return {
    get state() { return state },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    send(text) {
      if (!child || state.exit || !child.stdin.writable) return false
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      set(sent(state, text))
      return true
    },
    end() { child?.stdin.end() },
    kill,
  }
}
