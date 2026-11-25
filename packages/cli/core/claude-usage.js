// ─── claude-usage — Claude Code sessions and tokens per day, beside the commits ─
//
// Pure: one session transcript's text in, its per-day usage out. The command
// finds the `.jsonl` files under `~/.claude/projects/` and merges; no fs here,
// so it is testable with fixtures.
//
// A streamed reply writes the SAME message id on several lines, each carrying
// the full usage, so counting lines counts a reply two or three times. `seen`
// is shared across files because a resumed session repeats earlier replies.

import { readMessages } from '@frontierjs/claude'

export const CLAUDE_ZERO = { sessions: 0, headless: 0, output: 0, total: 0 }

// The LOCAL calendar day, the reading git's `--date=short-local` gives, so a
// reply and a commit made in the same evening land in the same column.
const localDay = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// `cwd` is the directory the session ran in, read from the transcript rather
// than the folder name, because the folder slug flattens `/` and `.` alike.
// `headless` is a `claude -p` run — a fix loop, not a person at a prompt.
export const tallySession = (text, { seen = new Set(), day = localDay } = {}) => {
  const { file, messages } = readMessages(text, { final: true })
  const days = new Map()
  let first = null
  for (const m of messages) {
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id) }
    const key = day(m.at)
    first ??= key
    const d = days.get(key) ?? { ...CLAUDE_ZERO }
    d.output += m.output
    d.total += m.input + m.cacheWrite + m.cacheRead + m.output
    days.set(key, d)
  }
  return { cwd: file.cwd, headless: file.headless, first, days }
}

// Folds one session into the running map. A subagent's tokens count, but it is
// not a session of its own — its parent already is.
export const mergeSession = (into, { headless, first, days }, { subagent = false } = {}) => {
  for (const [key, d] of days) {
    const t = into.get(key) ?? { ...CLAUDE_ZERO }
    t.output += d.output
    t.total += d.total
    into.set(key, t)
  }
  if (first && !subagent) {
    const t = into.get(first)
    t.sessions++
    if (headless) t.headless++
  }
  return into
}

// 4200000 → '4.2M', so a token axis fits the column the commit axis uses.
export const compact = (v) => {
  const a = Math.abs(v)
  const [n, s] = a >= 1e9 ? [v / 1e9, 'B'] : a >= 1e6 ? [v / 1e6, 'M'] : a >= 1e3 ? [v / 1e3, 'k'] : [v, '']
  return (Math.abs(n) >= 10 || !s ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '')) + s
}
