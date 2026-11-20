// Markdown. Per-line, so only what a line shows by itself is
// typed: a heading is its whole line, a fence opens a region.
//
// A fenced block whose info string names a grammar the editor has is that
// grammar inside; any other fence is `code`. A fence closes on any fence line,
// not one of the same length, so a four-backtick fence holding three-backtick
// lines closes early. An unclosed comment or template literal inside a
// highlighted fence stays open in that grammar and hides the closing fence.
//
// Front matter is YAML between a `---` on the first line and the next `---` or
// `...`; a `---` pair further down is two thematic breaks. Setext headings,
// indented code, tables and reference-style definitions' titles are plain;
// emphasis and inline code are read within one line.
import { css } from './css.js'
import { html } from './html.js'
import { js, ts } from './js.js'
import { json } from './json.js'
import { lite } from './lite.js'
import { mesa } from './mesa.js'
import { yaml } from './yaml.js'

const FENCE = '[ \\t]*(?:`{3,}|~{3,})'
const FENCE_END = new RegExp(`^${FENCE}[ \\t]*$`)
const LANGUAGES = [
  ['js|javascript|jsx|mjs|cjs', js],
  ['ts|typescript|tsx', ts],
  ['json|jsonc', json],
  ['css', css],
  ['html|htm', html],
  ['lite', lite],
  ['mesa', mesa],
  ['yaml|yml', yaml],
]

const fences = [
  ...LANGUAGES.map(([names, syntax]) => ({
    begin: new RegExp(`^${FENCE}[ \\t]*(?:${names})(?![\\w-]).*`),
    end: FENCE_END,
    type: 'code',
    syntax,
  })),
  { begin: new RegExp(`^${FENCE}.*`), end: FENCE_END, type: 'code' },
]

export const markdown = {
  name: 'markdown',
  first: [{ begin: /^---[ \t]*$/, end: /^(?:---|\.\.\.)[ \t]*$/, type: 'punctuation', syntax: yaml }],
  rules: [
    { match: /\\[\\`*_{}[\]()#+\-.!>|~]/, type: 'escape' },
    { begin: /<!--/, end: /-->/, type: 'comment' },
    ...fences,
    { match: /^ {0,3}#{1,6}(?:[ \t].*)?$/, type: 'heading' },
    { match: /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/, type: 'punctuation' },
    { match: /^[ \t]*(?:>[ \t]?)+/, type: 'punctuation' },
    { match: /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t])/, type: 'punctuation' },
    { match: /``(?:[^`]|`(?!`))+``|`[^`]+`/, type: 'code' },
    { match: /!?\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\[[^\]]*\]|<https?:\/\/[^>\s]+>/, type: 'link' },
    { match: /^[ \t]*\[[^\]]+\]:.*/, type: 'link' },
    { match: /https?:\/\/[^\s)>\]]+/, type: 'link' },
    { match: /\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)/, type: 'strong' },
    { match: /\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w)/, type: 'emphasis' },
  ],
}
