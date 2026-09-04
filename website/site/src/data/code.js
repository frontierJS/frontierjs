// site/src/data/code.js — every code sample on the site, highlighted.
//
// This used to be a regex of the site's own, with four copies of a keyword
// list across four pages. It is now `@frontierjs/toolbelt/glow`, which is the
// framework's own highlighter and is what `@frontierjs/css` themes: glow marks
// each token with the ELEMENT that means it — <strong> keyword, <em> value,
// <sup> comment — so a sample carries no class and `code.css` styles it. That
// is why no page here has a code palette any more.
//
// It runs at BUILD time — a companion calls it and the page ships the marked-up
// HTML — so no page loads a highlighter.
//
// `prefix: false` everywhere. With prefixes on, a line starting `+`, `-` or `>`
// is a diff marker and the character is eaten: three of these pages show SQL
// comments (`-- from @@index(...)`) and CSS combinators, and the marker would
// take one character off each.

import { glow } from '@frontierjs/toolbelt/glow'

/*
 * A whole sample: `<code language="…">` inside whatever the page wraps it in.
 *
 * `prefix` is glow's line-marker pass — a line opening `+`, `-` or `>` becomes
 * an inserted, removed or noted line, which @frontierjs/css draws as a stripe.
 * It is OFF unless a sample asks, because the marker character is REMOVED and
 * several samples here are SQL comments (`-- from @@index(…)`) and shell
 * prompts; a page showing an actual diff passes `{ diff: true }`.
 */
export const block = (src, language, { diff = false } = {}) =>
  glow(src, { language, prefix: diff })

/*
 * One line, for the three pages that render a node per line so they can light
 * individual ones — the seed with the lines a derived thing came from, the
 * walkthrough's new lines, the ripple's diff.
 *
 * It is `block()` of one line rather than glow's `renderRow`, and the wrapper
 * is the reason: @frontierjs/css themes `code[language] em`, so a token with
 * no `<code language>` above it is styled by nothing. A page that emitted bare
 * tokens into its own <span> would have to carry a palette again, which is the
 * whole thing this change removes. One <code> per line is a block element per
 * line, which is what these pages lay out anyway.
 *
 * `&nbsp;` keeps a blank line's height; glow answers '' for an empty line and
 * an empty node collapses.
 */
export const line = (src, language) => block(src, language) || '&nbsp;'

/** Plain text that is about to be handed to `{@html}` beside marked-up code. */
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/*
 * A sample's language, from the name of the file it is. The walkthrough and
 * the package pages both show "here is `db/schema.lite`", so the extension is
 * already on screen and deriving from it means the two cannot disagree.
 *
 * `.mesa` is glow's `mesa` — markup with an expression language in it, the
 * shape it already handles for svelte and vue.
 */
const BY_EXT = {
  lite: 'lite', mesa: 'mesa', ts: 'ts', js: 'js', mjs: 'js',
  json: 'json', sql: 'sql', css: 'css', html: 'html', sh: 'sh', md: 'md',
}

export const langFor = (file, fallback = 'js') =>
  BY_EXT[String(file ?? '').split('.').pop().toLowerCase()] ?? fallback

/*
 * What a sample is written in, read off the sample.
 *
 * Most of the code on this site is a TRANSCRIPT rather than a file — a
 * command and its output, a schema beside the SQL it compiled to, a request
 * beside the response — so there is often no filename to derive from and more
 * than one language in the block. That is what glow's language LIST is for,
 * and this answers one.
 *
 * Declared beats derived, as everywhere else here: a sample carrying `lang`
 * is taken at its word and this is only asked when none is stated. That is
 * the case for everything in `website/packages.js`, which is the one place a
 * feature is written down and is read by the hand-written pages too — a tag
 * they ignore is a second thing to keep in step for no gain. Measured against
 * the seventeen samples that DO state one, it agrees on nine and answers a
 * superset on five, which is the shape a guess should have: it only chooses
 * which rules to add, so being wrong mis-colors a line rather than changing
 * a character.
 */
const SNIFF = [
  ['sh',   /^\s*[$>] |^\s*(?:npm|npx|bun|bunx|fli|git|cd|node|pnpm|yarn|curl) /m],
  ['sql',  /\b(?:SELECT|INSERT INTO|CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE|DROP TABLE)\b/],
  ['lite', /^\s*(?:model|enum|valueset|tenancy|extend) \w|@@\w|^\s*\w+\s+(?:Int|String|Float|Boolean|DateTime|Json|Bytes)\??\s/m],
  ['json', /^\s*\{\s*$\n\s*"/m],
  ['html', /^\s*<[a-zA-Z]/m],
  ['js',   /\b(?:const|let|await|import|export|function|=>)\b/],
]

/** The stated language, or what the sample looks like. */
export const langOf = (lang, src) => lang ?? sniff(src)

export function sniff(src) {
  const found = SNIFF.filter(([, re]) => re.test(String(src))).map(([lang]) => lang)
  // `js` is the fallback rather than a guess — most of this site is JavaScript,
  // and glow's generic pass is the JS-ish one anyway.
  return found.length ? found : ['js']
}
