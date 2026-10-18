// src/lib/study/transcript.js — a study tab that READS ALONG a session another
// host runs (`IDEAS/study.md` 3.3): the transcript Claude Code writes it to,
// tailed, and folded into the messages a tab draws.
//
// It is never driven from here. Its own terminal holds the session, and a
// `--resume` from the study would put two processes on one session in one
// tree, so a read-along sends nothing and answers nothing: what it asks is
// shown, and answered where it runs.
//
// A transcript is Claude Code's file, and holds entry kinds the stream does not
// (`attachment`, `queue-operation`, `file-history-snapshot`, meta lines, a
// subagent's sidechain). Only a main-line `user` or `assistant` entry is read,
// and it is the stream's own event inside, so `fold` takes it from there.
//
// Terminal only, like `session.js`.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { fold, fresh } from './session.js'

/** The most messages a read-along keeps, the newest: a day's transcript is thousands. */
export const KEEP = 500

/** How often the transcript and the worker are read again. */
export const POLL_MS = 1000

// A prompt's text without what the harness wrapped round it (`<system-reminder>`, an IDE's tags).
const plain = (text) => String(text ?? '').replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '').trim()

/** `state` after one transcript entry; `state` itself for one the tab does not draw. */
export function foldEntry(state, entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain || entry.isMeta) return state
  if (entry.type === 'assistant') {
    const next = fold(state, { type: 'assistant', message: entry.message })
    return entry.message?.model && next.model !== entry.message.model ? { ...next, model: entry.message.model } : next
  }
  if (entry.type !== 'user') return state
  const content = entry.message?.content
  const text = typeof content === 'string' ? plain(content)
    : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => plain(b.text)).filter(Boolean).join('\n') : ''
  const images = Array.isArray(content) ? content.filter((b) => b.type === 'image').length : 0
  const next = fold(state, { type: 'user', message: entry.message })
  return text || images ? { ...next, messages: [...next.messages, { kind: 'you', text, ...(images ? { images } : {}) }] } : next
}

/**
 * Read along session `session` from its transcript at `path`. `worker()` is
 * the session's `#workers` row now, or null once it has gone: what it asks
 * and whether it is working are read off that, since a transcript has no
 * `result` to end a turn. Shaped as `startSession`'s answer, so a tab holds
 * either, but `send` and `answer` refuse.
 *
 * @param {{ session: string, path: string, worker?: () => any, every?: number }} o
 */
export function readAlong({ session, path, worker = () => null, every = POLL_MS }) {
  let state = { ...fresh(), sessionId: session, readOnly: true, waiting: null }
  const listeners = new Set()
  const set = (next) => {
    if (next === state) return
    state = next
    for (const fn of listeners) fn(state)
  }

  let offset = 0
  let rest = ''
  function read() {
    let next = state
    try {
      // A session whose hook ran before `#workers` kept the path.
      if (!path) throw Object.assign(new Error('the hook named no transcript for it yet'), { code: 'NONE' })
      const size = statSync(path).size
      // Rewritten under us: read it again from the top.
      if (size < offset) { offset = 0; rest = ''; next = { ...next, messages: [] } }
      if (size > offset) {
        const fd = openSync(path, 'r')
        const buf = Buffer.alloc(size - offset)
        try { readSync(fd, buf, 0, buf.length, offset) } finally { closeSync(fd) }
        offset = size
        const lines = (rest + buf.toString('utf8')).split('\n')
        rest = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          let entry
          try { entry = JSON.parse(line) } catch { continue }
          next = foldEntry(next, entry)
        }
        if (next.messages.length > KEEP) next = { ...next, messages: next.messages.slice(-KEEP) }
      }
    } catch (e) {
      if (!next.exit) next = { ...next, exit: { code: null }, messages: [...next.messages, { kind: 'error', text: e.code === 'NONE' ? `${session.slice(0, 8)}: ${e.message}` : `${path}: ${e.code === 'ENOENT' ? 'no transcript there' : e.message}` }] }
    }
    const w = worker()
    const waiting = w?.asking?.why ?? null
    const status = waiting ? 'needs-permission' : w && !w.said ? 'working' : 'idle'
    if (waiting !== next.waiting || status !== next.status || next.busy) next = { ...next, waiting, status, busy: false }
    set(next)
  }

  read()
  const tick = setInterval(read, every)
  tick.unref?.()

  return {
    get state() { return state },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    send() { return false },
    answer() { return false },
    end() { clearInterval(tick) },
    kill() { clearInterval(tick) },
  }
}
