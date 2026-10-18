// src/lib/study/tabs.js — the study's tabs (`IDEAS/study.md` 2.1), pure: what
// a line typed in the study asks for, and the bar that names each tab.
//
// Two words of the line are the study's, `/new [model]` and `/close`; every
// other line goes to Claude whole, its own slash commands included, since a
// `-p` session runs the owner's skills. A tab is closed by a typed word and
// never by a key: closing ends the process, and Ctrl+W deletes a word in the
// field the study is typed into.

/** A line as the study reads it: `{ new: model | null }`, `{ close: true }`, or `{ line }` for Claude. */
export function studyLine(text) {
  const m = /^\/(new|close)(?:\s+(.*))?$/.exec(text.trim())
  if (!m) return { line: text }
  if (m[1] === 'close') return m[2] ? { line: text } : { close: true }
  const model = m[2]?.trim()
  return /^\S*$/.test(model ?? '') ? { new: model || null } : { line: text }
}

/** The step from tab `at` of `n`, around the end: Ctrl+J is +1 and Ctrl+K -1. */
export const cycled = (at, n, step) => (at + step + n) % n

/** The model a tab names: the one asked for, else the one the CLI said it runs, without its `claude-`. */
export const modelOf = (tab, state) => tab.model ?? state?.model?.replace(/^claude-/, '') ?? 'claude'

/**
 * The bar: each tab its number and model, the one shown in brackets, a tab
 * working marked `…` and one whose process ended `✗`. Read off each
 * session's state, never stored.
 */
export function tabBar(tabs, at) {
  return tabs.map((tab, i) => {
    const s = tab.session?.state
    const mark = s?.status === 'working' ? '…' : s?.exit ? '✗' : ''
    const name = `${i + 1} ${modelOf(tab, s)}${mark}`
    return i === at ? `[${name}]` : ` ${name} `
  }).join('')
}
