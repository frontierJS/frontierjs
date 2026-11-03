// src/lib/claude-edit.js — how the Claude Code tab's forms turn lines of text
// into what the `claude` service's writes take, and back.

/** One entry per non-blank line, trimmed. */
export const lines = (text) => String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)

/**
 * `KEY=VALUE` or `Name: value` lines as an object, split at the FIRST separator
 * so a value may contain it. A line with no separator is refused by name rather
 * than dropped, since a dropped credential line starts a server that cannot sign in.
 */
export function pairs(text, sep, what) {
  const out = {}
  for (const line of lines(text)) {
    const i = line.indexOf(sep)
    if (i < 1) throw new Error(`${what}: "${line}" needs ${sep === '=' ? 'KEY=VALUE' : 'Name: value'}`)
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** A DOM id fragment from a name that may hold `@`, `/` and spaces. */
export const slug = (s) => String(s ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
