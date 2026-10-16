/**
 * What a phone's stylesheet cannot paint (`IDEAS/mesa-ir.md` §§ 9, 11), as a
 * judge over one rule's prelude: the selectors and at-rules the engine's
 * encoder drops or never matches. Each is dropped in silence on the device,
 * so the compiler refuses the rule by file and line instead (`FJS-D1074`).
 * Pure data, no engine names.
 *
 * - A type selector never matches: every element is the engine's `view` or
 *   `text`, whatever tag the component wrote.
 * - An attribute selector paints nothing, against an attribute set by the
 *   engine's own call.
 * - `@media`, `@supports`, `@layer` and `@container` drop their whole block.
 * - `:where`, `:has`, `:lang`, `:focus-visible`, `:host` and `::backdrop`
 *   are dropped by the encoder, and the structural pseudo-classes paint nothing:
 *   `:nth-child` and `:first-child` were measured, the rest of the family is
 *   assumed to share their path.
 *
 * What is not here was measured to paint, or has not been measured: class,
 * id, the descendant, child and `+` combinators, nesting, plain `:is` and
 * `:not`, `*`, and the dynamic pseudo-classes.
 */

const AT_RULES = new Set(['media', 'supports', 'layer', 'container'])

const PSEUDO = /::backdrop\b|:(?:where|has|lang|host|focus-visible|nth-child|nth-last-child|nth-of-type|nth-last-of-type|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type)\b/

// The pseudo-classes whose argument is not a selector, so `odd` and `en`
// inside one are not type selectors.
const NOT_A_SELECTOR = /:(?:nth-[\w-]+|lang|dir)\([^)]*\)/g

/** Split `s` on top-level commas, outside parens and brackets. */
export function list(s) {
  const out = []
  let depth = 0, cur = ''
  for (const c of s) {
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** The first thing in `prelude` a phone cannot paint, as `{ what, shape }`, or null. */
export function cssOffense(prelude) {
  if (prelude[0] === '@') {
    const name = prelude.slice(1).match(/^[\w-]+/)?.[0].toLowerCase()
    return AT_RULES.has(name) ? { what: `@${name}`, shape: `@${name}` } : null
  }
  const bare = prelude.replace(/:global\(([^)]*)\)/g, '$1').replace(/"[^"]*"|'[^']*'/g, '""')
  for (const sel of list(bare)) {
    const pseudo = sel.match(PSEUDO)?.[0]
    if (pseudo) return { what: pseudo, shape: pseudo }
    const attr = sel.match(/\[[^\]]*\]/)?.[0]
    if (attr) return { what: `the attribute selector ${attr}`, shape: 'attribute selector' }
    const type = sel.replace(NOT_A_SELECTOR, '').match(/(?:^|[\s>+~(,])([a-zA-Z][\w-]*)/)?.[1]
    if (type) return { what: `the type selector ${type}`, shape: 'type selector' }
  }
  return null
}
