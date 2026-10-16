/**
 * A whole stylesheet, `@frontierjs/css`'s bundle first, lowered to what a
 * phone's encoder keeps (`IDEAS/mesa-ir.md` § 12, 4.1). The encoder drops an
 * `@layer` block whole and a selector list whole when one member is
 * unsupported, both in silence, so the kit's tokens on `:root, :host` never
 * arrived (§ 11).
 *
 * - Layers are unwrapped into one flat sheet in cascade order: each layer's
 *   sublayers before its own rules, layers in the order first declared, and
 *   unlayered rules last.
 * - Every selector list is split into one rule per member, and a member
 *   `cssOffense` refuses is dropped alone rather than taking its list with it.
 * - `@media`, `@supports`, `@container` and `@import` are dropped, since the
 *   device drops them anyway. Every other at-rule is kept as written.
 *
 * - The token graph is then evaluated so no `var()` is more than one hop
 *   from a literal (`tokens.js`, 4.2), and the colors and logical
 *   properties the device cannot read are computed (`values.js`, 4.3).
 *
 * What is dropped comes back on `dropped`, by line, because a component's
 * own `<style>` is refused for the same offense (`FJS-D1088`) and a sheet an
 * app imports should not hide what it lost.
 *
 * What unwrapping cannot keep: a layer beats an earlier one whatever the
 * specificity, and a flat sheet orders by specificity first. A rule in an
 * earlier layer that is more specific than a later one on the same element
 * now wins.
 */

import { cssOffense, list } from './css.js'
import { lowerTokens } from './tokens.js'
import { lowerValues } from './values.js'
import { missingPeer } from '../optional-peer.js'

const csstree = await import('css-tree').catch(missingPeer('css-tree', 'lowerSheet'))

const DROPPED = new Set(['media', 'supports', 'container', 'import'])

const LIST_PSEUDO = /:(?:where|is|-webkit-any|-moz-any)\(/g

/**
 * `sel` with each top-level `:where()`, `:is()` and vendor copy of `:is()`
 * replaced by one selector per member of its list, as a cross product. The
 * encoder drops a whole rule over a list inside one, and the Block surface,
 * the chip fill and the outlined button's ink are each one such rule.
 *
 * A member that is a type goes to the front of its compound, since `.x` then
 * `a` written together is the class `xa`. A member holding a combinator is
 * substituted only where the pseudo is the whole selector: `.p :is(.a .b)`
 * also matches an `.a` above `.p`, which `.p .a .b` does not. Anything inside
 * another pseudo, `:not()` and `:has()` among them, is left as written.
 */
function unwrapLists(sel) {
  for (const m of sel.matchAll(LIST_PSEUDO)) {
    if (depthAt(sel, m.index) !== 0) continue
    const open = m.index + m[0].length
    const close = closingParen(sel, open)
    const before = sel.slice(0, m.index), after = sel.slice(close + 1)
    const members = list(sel.slice(open, close))
    const whole = !before.trim() && !after.trim()
    if (!whole && members.some(hasCombinator)) continue
    const start = compoundStart(before)
    return members.flatMap(mem => unwrapLists(/^[a-zA-Z*]/.test(mem)
      ? before.slice(0, start) + mem + before.slice(start) + after
      : before + mem + after))
  }
  return [sel]
}

function depthAt(s, at) {
  let d = 0
  for (let i = 0; i < at; i++) if (s[i] === '(' || s[i] === '[') d++; else if (s[i] === ')' || s[i] === ']') d--
  return d
}

function closingParen(s, from) {
  for (let i = from, d = 1; i < s.length; i++) {
    if (s[i] === '(') d++
    else if (s[i] === ')' && --d === 0) return i
  }
  return s.length
}

function hasCombinator(s) {
  let flat = s.trim(), prev
  do { prev = flat; flat = flat.replace(/\([^()]*\)|\[[^[\]]*\]/g, '') } while (flat !== prev)
  return /[\s>+~]/.test(flat)
}

// The index in `before` where its last compound selector begins.
function compoundStart(before) {
  for (let i = before.length - 1, d = 0; i >= 0; i--) {
    const c = before[i]
    if (c === ')' || c === ']') d++
    else if (c === '(' || c === '[') d--
    else if (d === 0 && /[\s>+~]/.test(c)) return i + 1
  }
  return 0
}

/** `{ css, dropped }`: `src` with its layers unwrapped, its lists split, its tokens evaluated and its colors computed; `dropped` is `{ what, line }` per member or block lost. */
export function lowerSheet(src) {
  const ast = csstree.parse(src, { positions: true, parseRulePrelude: false, parseAtrulePrelude: false, parseValue: false, parseCustomProperty: false })
  const dropped = []
  const layer = () => ({ order: [], sub: new Map(), items: [] })
  const root = layer()
  let anon = 0, sources = 0
  const named = (into, name) => {
    let l = into
    for (const part of name.split('.')) {
      if (!l.sub.has(part)) { l.sub.set(part, layer()); l.order.push(part) }
      l = l.sub.get(part)
    }
    return l
  }
  function walk(nodes, into) {
    for (const n of nodes) {
      const line = n.loc.start.line
      if (n.type === 'Atrule') {
        const name = n.name.toLowerCase()
        if (name === 'layer') {
          const names = (n.prelude?.value ?? '').split(',').map(s => s.trim()).filter(Boolean)
          if (!n.block) for (const ln of names) named(into, ln)
          else walk(n.block.children, named(into, names[0] ?? `\0${anon++}`))
        } else if (DROPPED.has(name)) dropped.push({ what: `@${name}`, line })
        else into.items.push({ text: csstree.generate(n) })
        continue
      }
      if (n.type !== 'Rule') continue
      const kids = n.block.children.toArray()
      const plain = kids.every(d => d.type === 'Declaration')
      const body = csstree.generate(n.block)
      const source = sources++
      let member = 0
      for (const sel of list(n.prelude.value).flatMap(unwrapLists)) {
        const o = cssOffense(sel)
        if (o) dropped.push({ what: o.what, line })
        else if (!plain) into.items.push({ text: sel + body })
        else into.items.push({ sel, line, source, member: member++, decls: kids.map(d => ({ prop: d.property, value: d.value.value.trim(), important: !!d.important })) })
      }
    }
  }
  walk(ast.children, root)
  const out = []
  const flat = (l) => { for (const name of l.order) flat(l.sub.get(name)); out.push(...l.items) }
  flat(root)
  const text = (r) => r.text ?? `${r.sel}{${r.decls.map(d => `${d.prop}:${d.value}${d.important ? '!important' : ''}`).join(';')}}`
  // The bundler's vendor copies of an `:is()` rule are the same rule once
  // unwrapped. A later identical rule wins wherever the earlier one would.
  const last = new Map(out.map((r, i) => [text(r), i]))
  const { rules: tokens, unset } = lowerTokens(out.filter((r, i) => last.get(text(r)) === i))
  const { rules, kept } = lowerValues(tokens)
  return { css: joinLists(rules, text).map(text).join('\n') + '\n', dropped: [...dropped, ...unset, ...kept] }
}

/**
 * `rules` with the members of one source rule joined back into a list, which
 * the encoder keeps when every member is one it reads. Unwrapping writes each
 * token definition once per member, and the kit's sheet triples without it.
 *
 * `lowerTokens` writes a source rule member by member, each member followed by
 * its rules per context. Members whose runs have the same bodies are one
 * class, and a class is written context by context, the order one rule over
 * the list would have had, each row one rule. A member that sets its own
 * knobs has bodies of its own and is a class alone.
 *
 * Lost: an element carrying members of two classes, a `.dialog.surface`, can
 * see their rules in another order than member by member.
 */
function joinLists(rules, text) {
  const body = (r) => text({ ...r, sel: '' })
  const out = []
  for (let i = 0; i < rules.length;) {
    const { source } = rules[i]
    if (source === undefined) { out.push(rules[i++]); continue }
    let end = i + 1
    while (end < rules.length && rules[end].source === source) end++
    const runs = []
    for (const r of rules.slice(i, end)) (runs[r.member] ??= []).push(r)
    const classes = new Map()
    for (const run of runs.filter(Boolean)) {
      const key = run.map(body).join('\n')
      classes.get(key)?.push(run) ?? classes.set(key, [run])
    }
    for (const members of classes.values()) {
      for (let j = 0; j < members[0].length; j++) out.push({ ...members[0][j], sel: members.map(m => m[j].sel).join(',') })
    }
    i = end
  }
  return out
}
