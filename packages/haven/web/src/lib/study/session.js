// src/lib/study/session.js — one Claude session, a tab of the study
// (`IDEAS/study.md` 1.2): a `Session` of `@frontierjs/claude` held open, a line
// in, its events folded into the messages the pane draws.
//
// A tab is one long-lived child (study.md 0.2): every line goes to the same
// process and is answered under the same session id. The argv, the control
// protocol and the process are the package's (`docs/control-protocol.md`);
// what is Haven's is the fold, the cost and the deny's words.
//
// A session runs under `--permission-mode auto`, the owner's default: the
// CLI's own classifier decides and the host is asked nothing, not even for
// `curl | sudo bash` (study.md 2.3), so the panel stays dark. Passing
// `permissionMode: 'default'` brings it back: a call the owner's settings do
// not allow arrives as a prompt the pane answers.
//
// Terminal only, and no `#` seam: the study mounts only from a checkout, so no
// browser build reaches this file.
import { BadAnswer, Session } from '@frontierjs/claude'

/** The env naming another binary, for the study and `agents/agents.js` alike — a test's stub answers for nothing. */
export const CLAUDE_ENV = 'HAVEN_AGENTS_CLAUDE'

// ─── the fold ─────────────────────────────────────────────────────────────────
//
// A message is one of
//   { kind: 'you', text, images, at }             a line sent, `images` how many it carried, `at` when
//   { kind: 'said', text } / { kind: 'thought', text }
//   { kind: 'tool', id, line, done, failed }      a call, marked by its result
//   { kind: 'turn', ms, cost, error }             a turn's end
//   { kind: 'error', text }                       the process, not the model
// The events are the package's `SessionEvent`s, with Haven's own `init`
// (`{ model }`) and `exit` (`{ code, signal }`). A subagent's events carry
// `agent` and are left out, since its calls would bury the session's own. Its
// permission prompts are not: a prompt names no agent, and a subagent waits on
// one like any call.
//
// `asking` is the prompts not yet answered, oldest first:
//   { id, tool, input, description, suggestions }
// and `status` is read off it and `busy`: `needs-permission`, `working`, `idle`.
// `busy` is a flag and never a count of lines sent: a line sent mid-turn (a
// reason typed at a prompt) is folded into that turn, which ends in one
// `result`, so a count would stay `working` for good. A `result` ends the work, and
// an event after it is a queued line's own turn starting.

/** A session before anything was heard. */
export const fresh = () => ({ sessionId: null, model: null, status: 'idle', busy: false, cost: 0, messages: [], asking: [], exit: null })

const statused = (s) => ({ ...s, status: s.asking.length ? 'needs-permission' : s.busy ? 'working' : 'idle' })

/** The input field that says what a call does, cut to one line. */
export function toolLine(name, input = {}) {
  const said = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? ''
  return `${name}${said ? ` ${String(said).split('\n')[0]}` : ''}`
}

const add = (s, ...m) => ({ ...s, messages: [...s.messages, ...m] })

// What an event of the model's own adds to the pane, or null.
function said(ev) {
  if (ev.type === 'text') return { kind: 'said', text: ev.text }
  if (ev.type === 'thinking') return { kind: 'thought', text: ev.text }
  if (ev.type === 'tool') return { kind: 'tool', id: ev.id, line: ev.text, done: false, failed: false }
  if (ev.type === 'agent') return { kind: 'tool', id: ev.id, line: `Agent ${ev.title}`, done: false, failed: false }
  return null
}

/** `state` after one event, `state` itself when it changes nothing. */
export function fold(state, ev) {
  if (!ev || typeof ev !== 'object' || ev.agent) return state
  const m = said(ev)
  if (m) return add(state.busy ? state : statused({ ...state, busy: true }), m)
  if (ev.type === 'session') return ev.id && ev.id !== state.sessionId ? { ...state, sessionId: ev.id } : state
  if (ev.type === 'init') return ev.model && ev.model !== state.model ? { ...state, model: ev.model } : state
  if (ev.type === 'landed' || ev.type === 'refused') {
    if (!state.messages.some((x) => x.kind === 'tool' && x.id === ev.id)) return state
    return { ...state, messages: state.messages.map((x) => x.kind === 'tool' && x.id === ev.id ? { ...x, done: true, failed: ev.type === 'refused' } : x) }
  }
  if (ev.type === 'result') {
    // The process's running total, not the turn's: summed, every turn counts the ones before it again.
    const total = Number(ev.cost) || state.cost
    const error = ev.ok ? null : String(ev.stop && ev.stop !== 'success' ? ev.stop : 'error').replaceAll('_', ' ')
    return add(statused({ ...state, busy: false, cost: total }), { kind: 'turn', ms: Number(ev.ms) || 0, cost: total - state.cost, error })
  }
  if (ev.type === 'end') return state.busy ? statused({ ...state, busy: false }) : state
  if (ev.type === 'permission') {
    const c = ev.card ?? {}
    return statused({ ...state, asking: [...state.asking, { id: ev.request, tool: ev.tool, input: c.input ?? {}, description: c.description ?? '', suggestions: c.suggestions ?? [] }] })
  }
  if (ev.type === 'answered') return answered(state, ev.request)
  if (ev.type === 'error') return add(state, { kind: 'error', text: ev.text })
  if (ev.type === 'exit') return { ...state, status: 'idle', busy: false, asking: [], exit: { code: ev.code, signal: ev.signal } }
  return state
}

/** `state` after a line is sent at `at`, carrying `images` pictures. */
export const sent = (state, text, images = 0, at = null) => add(statused({ ...state, busy: true }), { kind: 'you', text, ...(images ? { images } : {}), ...(at ? { at } : {}) })

/** `state` once prompt `id` is answered or withdrawn. */
export const answered = (state, id) => state.asking.some((a) => a.id === id) ? statused({ ...state, asking: state.asking.filter((a) => a.id !== id) }) : state

// ─── the process ──────────────────────────────────────────────────────────────

/**
 * Start a session in `cwd`. `send(text, images, shown)` is a line, `images`
 * the image blocks it carries (`images.js`) and `shown` what the pane draws
 * for it where that is not the line itself (`/go`'s prompt); `answer(choice)`
 * answers the oldest permission prompt, false for one it cannot carry
 * (`always` on a prompt that suggested no rule); `end()` and `kill()` both
 * close stdin, stop a running turn and signal the process group after a grace.
 * A tab never outlives Haven. `subscribe(fn)` hears every state, `fn(state)`,
 * and returns its removal.
 *
 * @param {{ cwd?: string, resume?: string, model?: string, bin?: string, permissionMode?: string }} [opts]
 */
export function startSession({ cwd = process.cwd(), resume, model, bin = process.env[CLAUDE_ENV] || 'claude', permissionMode = 'auto' } = {}) {
  let state = fresh()
  const listeners = new Set()
  const set = (next) => {
    if (next === state) return
    state = next
    for (const fn of listeners) fn(state)
  }
  // The CLI's `duration_ms` is not on the package's result, so a turn is timed here, from its first line.
  let began = 0
  let closed = false
  const end = () => { closed = true; session.end() }

  const session = new Session({
    cwd, session: resume ?? null, model: model ?? null, permissionMode, command: bin, host: 'Haven',
    // A deny carries no reason: Claude reads a tool result as data, and told
    // "touch t3 instead" there, Haiku declined to, since the words were not
    // the owner's. A reason is the owner's next line.
    deny: 'The owner declined this call. Stop and wait for their next line.',
    card: (a) => ({ input: a.input ?? {}, description: a.description ?? '', suggestions: a.suggestions }),
    onEvent: (e) => {
      if (e.type === 'result') { e = { ...e, ms: began ? Date.now() - began : 0 }; began = Date.now() }
      if (e.type === 'error' && e.text.endsWith('not on PATH')) e = { ...e, text: `${e.text} (${CLAUDE_ENV} names another)` }
      set(fold(state, e))
    },
    onInit: (i) => set(fold(state, { type: 'init', model: i.model })),
    onExit: (code, signal) => {
      process.off('exit', end)
      set(fold(state, { type: 'exit', code, signal }))
    },
  })
  process.once('exit', end)

  return {
    get state() { return state },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    send(text, images = [], shown = text) {
      if (closed || state.exit) return false
      if (!state.busy) began = Date.now()
      session.send(images.length ? [...images, { type: 'text', text }] : text)
      set(sent(state, shown, images.length, Date.now()))
      return true
    },
    /** Answer the oldest prompt: `allow`, `always` or `deny`. */
    answer(choice) {
      const ask = state.asking[0]
      if (!ask || closed || state.exit) return false
      try {
        session.answer(ask.id, choice === 'always' ? 'allow' : choice, undefined, choice === 'always' ? { always: true } : {})
      } catch (e) {
        if (e instanceof BadAnswer) return false
        throw e
      }
      return true
    },
    end,
    kill: end,
  }
}
