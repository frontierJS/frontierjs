// ─── tldr.js — a question answered as a tldr page, for `fli tldr` ─────────────
//
// The prompt and the renderer; the session is `runAsk` in `ask-claude.js`, so
// the read-only argv, hooks off and the budget are that file's and not
// restated here. Claude answers in tldr-pages markdown — a title, a `>`
// summary, then `- what:` / `` `how` `` pairs — because a fixed shape is what
// lets the terminal draw it, and a reply that strays from it still prints as
// plain lines rather than vanishing.
//
// The workspace's VOCABULARY.md rides along both ways: the prompt names its
// words so the answer is written in them, and the page colors each one and
// defines it underneath, so a reply teaches the word it used. Read through
// `authoredVocabulary` in `terms.js`, the one reader of that file; a project
// with no VOCABULARY.md gets the plain page.

import { authoredVocabulary } from './terms.js'

export const TLDR_RULES = [
  'Answer the question below as a tldr page: the few commands or snippets that get it done, not an explanation.',
  'Find the answer in this project before answering from memory: README.md, CLAUDE.md and docs/ files, package.json scripts, and fli commands — a fli command is a markdown file under packages/cli/commands/<namespace>/ (or an app\'s own commands/) whose frontmatter lists its flags and examples, run as `fli <namespace>:<name>` or its alias. You are read-only: Read, Grep, Glob, and rg, ls and git in Bash. Read only what you need and stop as soon as you can answer.',
  'Never invent a command, flag or API. Every example is one you saw in the tree or know exists outside it.',
  [
    'Reply with the page and nothing before or after it, in exactly this shape:',
    '',
    '# <topic in one to four words>',
    '',
    '> <one short sentence: what this does, or when to reach for it>',
    '> <optional, one short sentence: the caveat that bites>',
    '> More: <the file:line or command that says more>',
    '',
    '- <what the example does>:',
    '',
    '`<one line: a command or a code snippet>`',
    '',
    'Two to six examples, the most common first. A value the reader fills in is written {{like_this}}. Keep every line under 100 characters.',
  ].join('\n'),
].join('\n\n')

// A glossary longer than the page it explains is the page.
export const GLOSSARY_MAX = 4

/**
 * The words a page may use and must not — blessed and alias rows, and refused
 * ones, from VOCABULARY.md at `root`. `null` when the file names none.
 */
export function readVocabulary(root) {
  const rows = [...authoredVocabulary(root).values()].filter(r => r.status !== 'open' && r.term)
  if (!rows.length) return null
  const terms = new Map(rows.map(r => [r.term.toLowerCase(), r]))
  // Longest first, so a two-word term wins over the one word inside it. Case
  // matters: Run, Call, Page and Move are terms here and ordinary English
  // everywhere, and the capital is what says which one a sentence meant.
  const words = rows.map(r => r.term).sort((a, b) => b.length - a.length).map(escape)
  return { terms, pattern: new RegExp(`\\b(${words.join('|')})(s|es)?\\b`, 'g') }
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The whole prompt for one question. */
export function tldrPrompt(question, vocab = null) {
  return [TLDR_RULES, vocab && vocabularyRules(vocab), `The question:\n\n${String(question).trim()}`]
    .filter(Boolean).join('\n\n')
}

function vocabularyRules({ terms }) {
  const rows    = [...terms.values()]
  const blessed = rows.filter(r => r.status === 'blessed').map(r => r.term)
  const aliases = rows.filter(r => r.status === 'alias').map(r => `${r.term} (say ${r.means})`)
  const refused = rows.filter(r => r.status === 'refused').map(r => `${r.term} (${r.means})`)
  return [
    `This framework names its concepts in VOCABULARY.md. Write in its words where one fits, Capitalized when you mean the framework's concept (a Resource, the Gate) and lowercase when you mean the ordinary word: ${blessed.join(', ')}.`,
    aliases.length && `Prefer the main word over its alias: ${aliases.join('; ')}.`,
    refused.length && `Never use these words: ${refused.join('; ')}.`,
  ].filter(Boolean).join(' ')
}

// A model sometimes fences the page it was told to print bare.
const FENCE = /^\s*```\w*\s*$/

/**
 * The page as terminal lines, then a glossary of the vocabulary it used.
 * `chalk` is handed in so the test reads plain text; a line matching no tldr
 * shape is kept as it came.
 */
export function renderTldr(text, chalk, vocab = null) {
  const seen = new Map()
  const prose = (s, style) => inline(s.replace(/\*\*/g, ''), style, chalk, vocab, seen)
  const out = []
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd()
    if (FENCE.test(line)) continue
    if (/^#\s/.test(line))        out.push('', `  ${chalk.bold(line.replace(/^#\s+/, ''))}`)
    else if (/^>\s?/.test(line))  out.push(`  ${prose(line.replace(/^>\s?/, ''), chalk.dim)}`)
    else if (/^-\s/.test(line))   out.push(`  ${prose(line.replace(/^-\s+/, ''), chalk.green)}`)
    else if (/^`.*`$/.test(line)) out.push(`      ${example(line.slice(1, -1), chalk)}`)
    else                          out.push(line ? `  ${prose(line, s => s)}` : '')
  }
  out.push('', ...glossary(seen, chalk))
  // The blank lines the page separates its parts with, collapsed to one.
  return out.filter((l, i) => l || (i > 0 && out[i - 1])).join('\n').replace(/^\n+|\n+$/g, '') + '\n'
}

// A refused word is always listed, since it is the one the reader must not
// copy; a blessed one only where the file defines it.
function glossary(seen, chalk) {
  const rows = [...seen.values()]
  const refused = rows.filter(r => r.status === 'refused')
  const defined = rows.filter(r => r.status !== 'refused' && r.means).slice(0, Math.max(0, GLOSSARY_MAX - refused.length))
  return [
    ...refused.map(r => `  ${chalk.yellow(r.term)} ${inline(`is not a word here — ${r.means}`, chalk.dim, chalk)}`),
    ...defined.map(r => `  ${chalk.magenta(r.term)} ${inline(r.status === 'alias' ? `is ${r.means}` : r.means, chalk.dim, chalk)}`),
  ]
}

// Code inside a prose line, drawn as an example is, without its backticks;
// a vocabulary word in the prose drawn in its own color and recorded.
function inline(text, style, chalk, vocab, seen) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    /^`.+`$/.test(part) ? chalk.cyan(part.slice(1, -1)) : terms(part, i === 0, style, chalk, vocab, seen)
  ).filter(Boolean).join('')
}

// A capital at the start of a sentence says nothing — "Run one suite" is a
// verb — so a match there is left plain.
function terms(text, first, style, chalk, vocab, seen) {
  if (!vocab || !text) return text && style(text)
  const out = []
  let at = 0
  for (const m of text.matchAll(vocab.pattern)) {
    const before = text.slice(0, m.index)
    if (first && /^\W*$/.test(before) || /[.!?:]\s+$/.test(before)) continue
    const row = vocab.terms.get(m[1].toLowerCase())
    if (m.index > at) out.push(style(text.slice(at, m.index)))
    out.push(row.status === 'refused' ? chalk.yellow(m[0]) : chalk.magenta(m[0]))
    if (!seen.has(row.term)) seen.set(row.term, row)
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(style(text.slice(at)))
  return out.join('')
}

// {{placeholder}} is tldr's mark for what the reader types; drawn underlined
// with the braces dropped, the way the tldr clients draw it.
function example(code, chalk) {
  return code.split(/(\{\{.*?\}\})/).map(part =>
    /^\{\{.*\}\}$/.test(part) ? chalk.underline(chalk.cyan(part.slice(2, -2))) : chalk.cyan(part)
  ).join('')
}
