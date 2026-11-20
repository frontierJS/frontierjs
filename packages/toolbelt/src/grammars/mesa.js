// Mesa components, .mesa: HTML-like markup with `{expression}`
// interpolations, block tags and the <script> / <style> sections.
//
// Everything of HTML comes from markupRules(); Mesa adds what opens with `{`:
// a block tag (`{#if x}`, `{:else}`, `{/each}`, `{@html x}`) types its leading
// word as a keyword and the rest as JavaScript, and a plain `{x}` is
// JavaScript. The same two work inside an open tag and a quoted value.
//
// Traps: the JavaScript inside braces ends at the first `}`, so an object
// literal or a `{#each xs as {a, b}}` pattern closes early; and a stray `{` in
// text opens an expression that runs to the next `}`, as the compiler reads it
// too. `---` front matter is taken wherever a line is only `---`, because a
// line is tokenized without knowing it is the first; Mesa has no other use of
// such a line.
import { markupRules } from './html.js'
import { js } from './js.js'

const blockTag = {
  begin: /\{(?=[#:/@])/,
  end: /\}/,
  type: 'punctuation',
  rules: [
    { match: /(?<=\{)[#:/@][A-Za-z]+(?: (?:if|each))?/, type: 'keyword' },
    { match: /\b(?:as|then)\b/, type: 'keyword' },
    ...js.rules,
  ],
}
const expression = { begin: /\{/, end: /\}/, type: 'punctuation', syntax: js }

export const mesa = {
  name: 'mesa',
  rules: [{ begin: /^---[ \t]*$/, end: /^---[ \t]*$/, type: 'comment' }, ...markupRules([blockTag, expression])],
}
