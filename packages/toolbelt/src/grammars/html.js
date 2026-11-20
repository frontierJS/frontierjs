// HTML, and the markup rules Mesa reuses with `{...}` added.
//
// What spans lines is a comment, an open tag whose attributes wrap, a quoted
// attribute value, and a <script> or <style> body, which is its own grammar.
// An open tag is a region from `<name` to `>` rather than one match so the
// attributes inside it can be typed.
//
// Traps: a <script> or <style> opens only when its `>` is on the same line as
// `<script`; with the attributes wrapped it is read as an ordinary tag and the
// body is plain. A body ends at the first `</script>` the way a browser reads
// it, but an unclosed comment or template literal inside the body is still open
// in its own grammar and hides that close. Void tags and unclosed tags are not
// tracked: no element nesting is in the state.
import { css } from './css.js'
import { js, ts } from './js.js'
import { json } from './json.js'

// `syntax` is the grammar object. No cycle runs through these imports: html
// reads css, js and json, and none of them reads html back.
const embedded = (open, close, syntax) => ({ begin: open, end: close, type: 'tag', syntax })

/**
 * The rules of markup. `interp` is a list of rules that open inside text, inside
 * an open tag and inside a quoted value: Mesa's `{...}`.
 * @param {import('./tokenize.js').Rule[]} [interp]
 */
export function markupRules(interp = []) {
  const quoted = (q) => ({ begin: q, end: q, type: 'string', inside: 'string', rules: interp })
  const attributes = [
    ...interp,
    quoted(/"/),
    quoted(/'/),
    { match: /(?<==[ \t]{0,4})[^\s"'=<>`{}]+/, type: 'string' },
    { match: /[^\s"'<>/={}]+/, type: 'attribute' },
  ]
  return [
    ...interp,
    { begin: /<!--/, end: /-->/, type: 'comment' },
    embedded(/<script\b[^>]*\btype=["']application\/(?:ld\+)?json["'][^>]*>/, /<\/script\s*>/, json),
    embedded(/<script\b[^>]*\blang=["']ts["'][^>]*>/, /<\/script\s*>/, ts),
    embedded(/<script\b[^>]*>/, /<\/script\s*>/, js),
    embedded(/<style\b[^>]*>/, /<\/style\s*>/, css),
    { match: /<![A-Za-z][^>]*>?/, type: 'keyword' },
    { match: /<\/[A-Za-z][\w:.-]*[ \t]*>?/, type: 'tag' },
    { begin: /<[A-Za-z][\w:.-]*/, end: /\/?>/, type: 'tag', rules: attributes },
    { match: /&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/, type: 'escape' },
  ]
}

export const html = { name: 'html', rules: markupRules() }
