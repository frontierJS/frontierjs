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

/** `{ css, dropped }`: `src` with its layers unwrapped, its lists split, its tokens evaluated and its colors computed; `dropped` is `{ what, line }` per member or block lost. */
export function lowerSheet(src) {
  const ast = csstree.parse(src, { positions: true, parseRulePrelude: false, parseAtrulePrelude: false, parseValue: false, parseCustomProperty: false })
  const dropped = []
  const layer = () => ({ order: [], sub: new Map(), items: [] })
  const root = layer()
  let anon = 0
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
      for (const sel of list(n.prelude.value)) {
        const o = cssOffense(sel)
        if (o) dropped.push({ what: o.what, line })
        else if (!plain) into.items.push({ text: sel + body })
        else into.items.push({ sel, line, decls: kids.map(d => ({ prop: d.property, value: d.value.value.trim(), important: !!d.important })) })
      }
    }
  }
  walk(ast.children, root)
  const out = []
  const flat = (l) => { for (const name of l.order) flat(l.sub.get(name)); out.push(...l.items) }
  flat(root)
  const text = (r) => r.text ?? `${r.sel}{${r.decls.map(d => `${d.prop}:${d.value}${d.important ? '!important' : ''}`).join(';')}}`
  const { rules: tokens, unset } = lowerTokens(out)
  const { rules, kept } = lowerValues(tokens)
  return { css: rules.map(text).join('\n') + '\n', dropped: [...dropped, ...unset, ...kept] }
}
