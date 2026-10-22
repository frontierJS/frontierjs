// src/lib/study/tabs.js — the study's tabs (`IDEAS/study.md` 2.1), pure: what
// a line typed in the study asks for, the keys it answers, and the bar that
// names each tab.
//
// `WORDS` are the study's own words of the line — the workbench's Go and Next
// among them (`plan.js`) — and every other line goes to Claude whole, its own
// slash commands included, since a `-p` session runs the owner's skills. A
// tab is closed by a typed word and never by a key: closing ends the
// process, and Ctrl+W deletes a word in the field the study is typed into.
//
// The keys are toolbelt `/keys` tables (`IDEAS/keys.md`), which `Study.mesa`
// runs through mesa's `keys()` on its input. The same tables are what `?`
// lists (`helpOf`) and what the shell's own `?` lists, so a key is written
// once. An action's name is its line in the help.
import { bindings, keymap } from '@frontierjs/toolbelt/keys'

/** What `/fold` steps through, in order (`rows.js` draws each); `none` is unfolded. */
export const FOLDS = ['none', 'mine', 'claude', 'both']

/** The study's words, in the order the help lists them. */
export const WORDS = [
  { word: 'new',   args: '[model]', help: 'open a tab, on that model' },
  { word: 'close', args: '',        help: 'end this tab' },
  { word: 'fold',  args: '[mode]',  help: `fold a side: ${FOLDS.join(', ')}; bare, the next` },
  { word: 'go',    args: '[plan]',  help: "send the plan's next open step here" },
  { word: 'next',  args: '[plan]',  help: 'that step in a new tab, the last reply handed over' },
]

/** Always: the tabs, the clipboard, reading back. */
export const KEYS = keymap({
  '<C-j>':      'next tab',
  '<C-k>':      'last tab',
  '<C-n>':      'new tab on the default model',
  '<C-v>':      'paste an image from the clipboard',
  '<C-y>':      'copy the last reply',
  '<A-Up>':     'jump to your line before',
  '<C-Up>':     'jump to your line before',
  '<A-Down>':   'jump to your line after',
  '<C-Down>':   'jump to your line after',
  '<PageUp>':   'read back',
  '<PageDown>': 'read forward',
})

/** On an empty line while a call waits on the owner — Claude Code's own digits. */
export const ASKED = keymap({
  1: 'allow the waiting call',
  2: 'allow it, and what the CLI suggested',
  3: 'deny it',
})

/** On an empty line, since a line may begin with `?`. */
export const HELP = keymap({ '?': 'keys and words' })
/** While the help shows. */
export const HELPING = keymap({ '?': 'keys and words', '<Esc>': 'keys and words' })

/**
 * What `?` shows: each table's bindings, the keys of one action on one line,
 * and the words. `[{ title, rows: [[left, right]] }]`.
 */
export function helpOf() {
  const keyed = (km) => {
    const by = new Map()
    for (const b of bindings({ active: [km], mac: false, text: false })) by.set(b.action, [...(by.get(b.action) ?? []), b.keys])
    return [...by].map(([action, keys]) => [keys.join(' '), action])
  }
  return [
    { title: 'Keys', rows: [['Enter', 'send the line'], ...keyed(KEYS)] },
    { title: 'On an empty line', rows: keyed(HELP) },
    { title: 'A permission prompt, on an empty line', rows: keyed(ASKED) },
    { title: 'Words', rows: WORDS.map((w) => [`/${w.word}${w.args ? ` ${w.args}` : ''}`, w.help]) },
  ]
}

/**
 * A line as the study reads it: `{ new: model | null }`, `{ close: true }`,
 * `{ fold: mode | null }` (null steps to the next), `{ go: plan | null }`,
 * `{ next: plan | null }` (null is the tab's own), or `{ line }` for Claude.
 * A word the study does not take after its own goes to Claude whole.
 */
export function studyLine(text) {
  const m = new RegExp(`^/(${WORDS.map((w) => w.word).join('|')})(?:\\s+(.*))?$`).exec(text.trim())
  if (!m) return { line: text }
  const arg = m[2]?.trim() || null
  if (m[1] === 'close') return arg ? { line: text } : { close: true }
  if (!/^\S*$/.test(arg ?? '')) return { line: text }
  if (m[1] === 'fold') return !arg || FOLDS.includes(arg) ? { fold: arg } : { line: text }
  return { [m[1]]: arg }
}

/** The step from tab `at` of `n`, around the end: Ctrl+J is +1 and Ctrl+K -1. */
export const cycled = (at, n, step) => (at + step + n) % n

/** The model a tab names: the one asked for, else the one the CLI said it runs, without its `claude-`. */
export const modelOf = (tab, state) => tab.model ?? state?.model?.replace(/^claude-/, '') ?? 'claude'

/**
 * The bar: each tab its number and model, a read-along `read <id>` instead,
 * the one shown in brackets, a tab
 * waiting on a permission prompt marked `?`, one working `…`, one whose
 * process ended `✗`, and one that finished while not shown `•`. Read off each session's state, never stored.
 */
export function tabBar(tabs, at) {
  return tabs.map((tab, i) => {
    const s = tab.session?.state
    const mark = s?.status === 'needs-permission' ? '?' : s?.status === 'working' ? '…' : s?.exit ? '✗' : tab.unread && i !== at ? '•' : ''
    // A read-along by the id the kitchen's ticket showed.
    const name = `${i + 1} ${tab.reads ? `read ${tab.reads.slice(0, 4)}` : modelOf(tab, s)}${mark}`
    return i === at ? `[${name}]` : ` ${name} `
  }).join('')
}
