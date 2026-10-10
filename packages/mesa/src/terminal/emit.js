/**
 * The terminal emitter — `target: 'terminal'` on compile(). Reads `ctx.ir`
 * and writes the component's template block as calls on `$$tui`
 * (`runtime-terminal.js`) into `ctx.module.body`, where the DOM builder
 * would have written its template and traversal.
 *
 * It refuses rather than approximates: a tag or event missing from
 * `tags.js`, any directive and every `unlowered` node
 * throw `X at File.mesa:L:C has no terminal lowering`, the first offender in
 * document order. `terminalOffenses` is the one list of them — the emitter
 * throws its head and the portability report (`scripts/corpus.mjs
 * --portability terminal`) tallies all of it, so the report cannot count a
 * node the emitter would paint or miss one it refuses. A file with a
 * `<script module>` is not refused at compile: the compiler keeps that half
 * and moves the throw into the default export (`terminalRefusal`, `FJS-2182`).
 *
 * The lines are built EAGERLY and the xNode only writes them. The head
 * declarations (`$$props`, `$$emit`, …) are emitted only when
 * `ctx.inuse` says a template expression reached for them, and the head
 * resolves before the body — a `detectDependency` made at write time would
 * come too late, which is why the DOM builder makes its own at build time.
 *
 * Nothing here names the engine: `tags.js` is pure data and the runtime is
 * reached only through the `$$tui` import the compiler adds.
 */

import { xNode, Q, htmlEntitiesToText } from '../compiler.js'
import { eachNode } from '../ir.js'
import { TERMINAL_TAGS, TERMINAL_EVENTS } from './tags.js'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** A single-quoted JS string literal. */
function q1(s) {
  return "'" + String(s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'"
}

const refusal = (what, loc) => `${what}${loc ? ` at ${loc}` : ''} has no terminal lowering`

/** The source spelling of a node the IR did not lower, for the refusal. */
function spelling(u) {
  const n = u.node
  switch (u.what) {
    case 'component':    return `<${n.name}>`
    case 'mesa-element': return `<mesa:${n.elArg}>`
    case 'slot':         return n.type === 'node' ? '<slot>' : '{#slot}'
    case 'await':        return '{#await}'
    case 'key':          return '{#key}'
    case 'snippet':      return '{#snippet}'
    case 'fragment':     return '{#fragment}'
    case 'virtual-each': return '{#virtual each}'
    case 'block':        return `{#${n.name}}`
    case 'render':       return '{@render}'
    case 'html':         return '{@html}'
    case 'debug':        return '{@debug}'
    case 'js-text':      return '{*…}'
    case 'systag':       return `{${n.value.match(/^@[\w-]*/)?.[0] ?? '@'}}`
    default:             return `{${u.what}}`
  }
}

/** Groups a directive's name for the report: `bind:value` and `bind:checked` are one gap. */
function directiveShape(name) {
  if (name === '{@attach}') return name
  if (name.startsWith('{...')) return '{...spread}'
  if (name.startsWith('{*') || name.startsWith('*{')) return '{*…}'
  if (name[0] === '{') return '{…}'
  if (name[0] === ':') return ':…'
  return name.match(/^[\w-]+:/)?.[0] ?? name
}

// ─── what does not lower ──────────────────────────────────────────────────────

/**
 * Every node in `ir` the terminal cannot paint, in document order, as
 * `{ what, shape, loc }`: `what` is the refusal's subject (`<table>`,
 * `bind:value`), `shape` the group a report counts it under (`<table>`,
 * `bind:`, `{...spread} on a component`).
 *
 * The walk goes on under a refused element, because a lowering for the outer
 * tag lowers none of its contents. It cannot go under an `unlowered` node —
 * the IR keeps no children there — so what an `{#await}` or a `<component
 * this>` holds is unseen until that node lowers. A component's own file is
 * not read: whether the CHILD lowers is the caller's question, which the
 * portability report answers by following the import.
 */
const blank = (n) => n.kind === 'comment' ||
  (n.kind === 'text' && n.parts.every((p) => p.kind === 'static' && !p.value.trim()))

/** The attributes `tags.js` says a tag cannot be painted without, that `n` lacks. */
const missing = (n) => (TERMINAL_TAGS[n.tag]?.requires ?? []).filter((a) => !n.attrs.some((x) => x.name === a))
const paints = (n) => !!TERMINAL_TAGS[n.tag] && !missing(n).length

const ariaHidden = (n) => n.attrs.some((a) => a.name === 'aria-hidden' && a.value === 'true')

/**
 * The elements the terminal leaves out rather than refuses: a tag missing
 * from `tags.js`, or lacking an attribute it `requires`, on an element that
 * is, or sits inside, a static
 * `aria-hidden="true"`. The author has said a reader needs nothing there —
 * the icon in an alert, a sort arrow beside a header — so the terminal paints
 * what assistive technology reads. Lexical: a component called inside one is
 * its own file and answers for itself. One answer for `terminalOffenses` and
 * the emitter both, so the report cannot count a node the emitter drops.
 */
export function terminalDropped(ir) {
  const dropped = new Set()
  const walk = (children, hidden) => eachNode(children, (n) => {
    if (n.kind !== 'element' && n.kind !== 'dynamic-element') return
    const h = hidden || ariaHidden(n)
    if (h && n.kind === 'element' && !paints(n)) { dropped.add(n); return false }
    if (h && !hidden) { walk(n.children, true); return false }
  })
  walk(ir.children, false)
  return dropped
}

/**
 * A field's text is its value, never its children: the engine's field is a
 * layout leaf, and adding a child to one aborts the process. Static text is
 * the starting value, which a `value=` beside it writes over as the property
 * does in a browser, less the one newline HTML drops after the open tag. Live
 * text without a `value=` is refused, since a browser moves a field's text
 * into it only until someone types, and a terminal writing it would overwrite
 * what was typed.
 */
const isField = (n) => ['input', 'textarea'].includes(TERMINAL_TAGS[n.tag]?.role)
// A `<progress>`'s children are the fallback a browser shows only when it
// cannot draw the bar, so nothing in them is built or refused.
const fallbackOnly = (n) => TERMINAL_TAGS[n.tag]?.role === 'progress'
// The roles a person changes the value of, so the only ones a `bind:value`
// hears back from.
const CONTROLS = ['input', 'textarea', 'select']
const hasValue = (n) => n.attrs.some((a) => a.name === 'value')
const liveText = (n) => n.children.some((c) => !blank(c) && !(c.kind === 'text' && c.static))
const fieldText = (n) => n.children
  .filter((c) => c.kind === 'text').flatMap((c) => c.parts).map((p) => p.value).join('')
  .replace(/^\r?\n/, '')

const elementOffenses = (n, add) => {
  for (const d of n.directives) add(d.name, directiveShape(d.name), d.loc)
  for (const h of n.handlers) if (!TERMINAL_EVENTS[h.event]) add(`on:${h.event}`, `on:${h.event}`, h.loc)
}

// `passive` promises a browser the handler never prevents a scroll; a
// terminal scrolls nothing, so it has no listener option to become.
const listenerOptions = (h) => {
  const opts = h.modifiers.filter((m) => m.name === 'capture' || m.name === 'once').map((m) => `${m.name}: true`)
  return opts.length ? `, { ${opts.join(', ')} }` : ''
}

export function terminalOffenses(ir) {
  const out = []
  const add = (what, shape, loc) => out.push({ what, shape, loc })
  const dropped = terminalDropped(ir)
  // A cell alone in its row already fills the row, so its colspan moves no
  // value under another header: the empty-state row every table carries.
  const alone = new Set()
  eachNode(ir.children, (n) => {
    if (dropped.has(n)) return false
    switch (n.kind) {
      case 'element':
        if (!TERMINAL_TAGS[n.tag]) add(`<${n.tag}>`, `<${n.tag}>`, n.loc)
        for (const a of missing(n)) add(`<${n.tag}> without ${a}`, `<${n.tag}> without ${a}`, n.loc)
        if (n.tag === 'tr') {
          const cells = n.children.filter((c) => !blank(c))
          if (cells.length === 1 && cells[0].kind === 'element') alone.add(cells[0])
        }
        for (const a of n.attrs) {
          if (!TERMINAL_TAGS[n.tag]?.refuses?.includes(a.name)) continue
          if (a.name === 'colspan' && alone.has(n)) continue
          // A live `multiple` is checked when it is written, since the kit's
          // `<Select>` passes `multiple={multiple}`, false unless asked.
          if (a.name === 'multiple' && typeof a.value === 'object') continue
          add(`${a.name} on <${n.tag}>`, `${a.name} on <${n.tag}>`, n.loc)
        }
        if (!CONTROLS.includes(TERMINAL_TAGS[n.tag]?.role)) {
          for (const b of n.binds) add(`bind:${b.name} on <${n.tag}>`, 'bind: on a non-control', b.loc)
        }
        if (isField(n) && !hasValue(n) && liveText(n)) {
          add(`live text in <${n.tag}> without value=`, `live text in <${n.tag}>`, n.loc)
          return false
        }
        elementOffenses(n, add)
        return fallbackOnly(n) ? false : undefined
      // A tag that is a read is checked against the same table when it is
      // built, naming the tag; only a literal one can be refused here.
      case 'dynamic-element': {
        if (!n.tag) add('<mesa:element> without this', '<mesa:element> without this', n.loc)
        else if (/^"[^"]*"$/.test(n.tag.code) && !TERMINAL_TAGS[JSON.parse(n.tag.code)]) {
          add(`<${JSON.parse(n.tag.code)}>`, `<${JSON.parse(n.tag.code)}>`, n.loc)
        }
        elementOffenses(n, add)
        return
      }
      case 'text':
        for (const p of n.parts) if (p.kind === 'unlowered') add(spelling(p), spelling(p), p.loc)
        return
      case 'slot':
        for (const d of n.directives) add(`${d.name} on <slot>`, 'attribute on <slot>', d.loc)
        return
      case 'comment':
      case 'component':
      case 'if':
      case 'each':
      case 'snippet':
      case 'render':
      case 'const':
        return
      case 'unlowered':
        return add(spelling(n), n.what === 'component' ? 'component' : spelling(n), n.loc)
      default:
        return add(`{${n.kind}}`, `{${n.kind}}`, n.loc)
    }
  })
  return out
}

/** The refusal for `ir`'s first offender in document order, or null when it lowers. */
export function terminalRefusal(ir) {
  const [first] = terminalOffenses(ir)
  return first ? refusal(first.what, first.loc) : null
}

// ─── emit ─────────────────────────────────────────────────────────────────────

export function buildTerminal(ctx) {
  const ir = ctx.ir
  for (const d of ir.diagnostics ?? []) ctx.analysis.errors.push(d)
  const refused = terminalRefusal(ir)
  if (refused) throw new Error(refused)
  const dropped = terminalDropped(ir)

  const seq = { el: 0, t: 0, m: 0, s: 0 }
  const lines = []
  const line = (ind, text) => lines.push([ind, text])
  const dep = (e) => ctx.detectDependency(e.raw)

  const emitFragment = (children, ind) => {
    line(ind, 'const $$b = $$tui.fragment();')
    emitChildren(children, '$$b', ind)
    line(ind, 'return $$b;')
  }

  // A body's snippets are declared before anything in it, since a
  // `{@render}` may come first in the source.
  const emitChildren = (children, parent, ind) => {
    for (const c of children) if (c.kind === 'snippet') emitSnippet(c, c.varName, ind)
    for (const c of children) if (c.kind !== 'snippet' && !dropped.has(c)) emitNode(c, parent, ind)
  }

  // The DOM path's shape: an anchor, then one getter per argument, and the
  // content placed before the anchor.
  const emitSnippet = (n, name, ind) => {
    line(ind, `const ${name} = (${['__anchor', ...n.params].join(', ')}) => {`)
    line(ind + 1, 'const $$b = $$tui.fragment();')
    emitChildren(n.children, '$$b', ind + 1)
    line(ind + 1, '$$tui.append(__anchor, $$b);')
    line(ind, '};')
  }

  const emitRender = (n, parent, ind) => {
    const m = marker(parent, ind)
    dep(n.callee)
    const args = [m, ...n.args.map((a) => { dep(a); return `() => (${a.code})` })].join(', ')
    if (n.guard) line(ind, `{ const $$sf = ${n.callee.code}; if ($$sf) $$sf(${args}); }`)
    else line(ind, `${n.callee.code}(${args});`)
  }

  // A changed tag is a different node, so the element is rebuilt under a
  // key, as the DOM path's keyBlock rebuilds it.
  const emitDynamicElement = (n, parent, ind) => {
    const m = marker(parent, ind)
    dep(n.tag)
    line(ind, `$$tui.keyBlock(${m}, () => (${n.tag.code}), ($$tag) => {`)
    line(ind + 1, 'const $$b = $$tui.fragment();')
    emitElement(n, '$$b', ind + 1, '$$tag')
    line(ind + 1, 'return $$b;')
    line(ind, '});')
  }

  const emitElement = (n, parent, ind, tag = q1(n.tag)) => {
    const el = `$$el${seq.el++}`
    const attrs = n.attrs.filter((a) => typeof a.value !== 'object').map((a) => {
      const key = IDENT.test(a.name) ? a.name : q1(a.name)
      return `${key}: ${a.value === true ? 'true' : q1(htmlEntitiesToText(a.value))}`
    })
    const field = isField(n)
    if (field && fieldText(n)) attrs.push(`value: ${q1(htmlEntitiesToText(fieldText(n)))}`)
    line(ind, `const ${el} = $$tui.element(${tag}${attrs.length ? `, { ${attrs.join(', ')} }` : ''});`)
    line(ind, `$$tui.append(${parent}, ${el});`)
    // A live attribute is a static one that moves: the same owner, written
    // from a render effect guarded the way a text binding is.
    for (const a of n.attrs) {
      if (typeof a.value !== 'object') continue
      dep(a.value.expr)
      if (a.value.kind === 'spread') {
        line(ind, `$$tui.spread(${el}, () => (${a.value.expr.code}));`)
        continue
      }
      line(ind, '$$runtime.render((__prev) => {')
      line(ind + 1, `var __a; try { __a = (${a.value.expr.code}); } catch (e) { __a = $$runtime.contain(e, __prev.a); }`)
      line(ind + 1, `if (__prev.a !== __a) $$tui.set_attribute(${el}, ${q1(a.name)}, __prev.a = __a);`)
      line(ind, '}, { a: undefined });')
    }
    // `n.styles` and `n.classes` are CSS, and a terminal paints no CSS: they
    // are inert here as a static `style` or `class` and the scoped rules are.
    if (!field && !fallbackOnly(n)) emitChildren(n.children, el, ind)
    for (const h of n.handlers) {
      dep(h.expr)
      line(ind, `$$tui.on(${el}, '${h.event}', ${h.expr.code}${listenerOptions(h)});`)
    }
    for (const b of n.binds) line(ind, `$$tui.bind(${el}, ${q1(b.name)}, ${b.getter}, ${b.setter});`)
    if (n.ref) line(ind, `${n.ref}(${el});`)
    // The DOM path's owner, handed the renderable: it waits for mount the
    // way `$.onMount` does, so an attachment written for the DOM throws when
    // it runs here rather than at compile.
    for (const a of n.attachments) {
      dep(a.expr)
      line(ind, `$$runtime.attach(${el}, () => (${a.expr.code}));`)
    }
  }

  const emitText = (n, parent, ind) => {
    if (n.static) {
      const value = n.parts.map((p) => p.value).join('')
      if (!value.trim()) return
      line(ind, `$$tui.append(${parent}, $$tui.text(${q1(htmlEntitiesToText(value))}));`)
      return
    }
    // One template literal for the whole text, each hole guarded on its own —
    // the same shape the DOM path's render group gives a text binding (FJS-D208).
    const tpl = '`' + n.parts.map((p) => {
      if (p.kind === 'static') return Q(htmlEntitiesToText(p.value))
      dep(p.expr)
      return '${(' + p.expr.code + ") ?? ''}"
    }).join('') + '`'
    const t = `$$t${seq.t++}`
    line(ind, `const ${t} = $$tui.text('');`)
    line(ind, `$$tui.append(${parent}, ${t});`)
    line(ind, '$$runtime.render((__prev) => {')
    line(ind + 1, `var __a; try { __a = ${tpl}; } catch (e) { __a = $$runtime.contain(e, __prev.a); }`)
    line(ind + 1, `if (__prev.a !== __a) $$tui.set_text(${t}, __prev.a = __a);`)
    line(ind, "}, { a: '' });")
  }

  const marker = (parent, ind) => {
    const m = `$$m${seq.m++}`
    line(ind, `const ${m} = $$tui.marker();`)
    line(ind, `$$tui.append(${parent}, ${m});`)
    return m
  }

  const emitIf = (n, parent, ind) => {
    const m = marker(parent, ind)
    n.branches.forEach((b) => dep(b.test))
    let select
    if (n.branches.length === 1) {
      select = `() => (${n.branches[0].test.code}) ? 0 : ${n.else ? 1 : 'null'}`
    } else {
      const tests = n.branches.map((b, i) => `if (${b.test.code}) return ${i};`)
      if (n.else) tests.push(`return ${n.branches.length};`)
      select = `() => { ${tests.join(' ')} }`
    }
    line(ind, `$$tui.ifBlock(${m}, ${select}, [`)
    const blocks = n.branches.map((b) => b.children)
    if (n.else) blocks.push(n.else)
    blocks.forEach((children, i) => {
      line(ind + 1, '() => {')
      emitFragment(children, ind + 2)
      line(ind + 1, i < blocks.length - 1 ? '},' : '}')
    })
    line(ind, ']);')
  }

  const emitEach = (n, parent, ind) => {
    const m = marker(parent, ind)
    dep(n.items)
    const itemParam = n.item.name ?? '$$item'
    const params = [itemParam, n.index].filter(Boolean).join(', ')
    let keyFn = 'null'
    if (n.key) {
      dep(n.key)
      keyFn = n.item.pattern
        ? `(${params}) => { const ${n.item.pattern} = ${itemParam}; return (${n.key.code}); }`
        : `(${params}) => (${n.key.code})`
    }
    for (const [outer, name] of n.lifts) line(ind, `const ${name} = $$runtime.createKeyedEquals(() => ${outer});`)
    line(ind, `$$tui.eachBlock(${m}, () => (${n.items.code}), ${keyFn}, (${params}) => {`)
    if (n.item.pattern) {
      line(ind + 1, `const ${n.item.fn} = () => { const ${n.item.pattern} = ${itemParam}(); return { ${n.item.names.join(', ')} }; };`)
    }
    emitFragment(n.children, ind + 1)
    if (n.else) {
      line(ind, '}, () => {')
      emitFragment(n.else, ind + 1)
      line(ind, '});')
    } else line(ind, '}, null);')
  }

  // The anchor is a marker, and the child's own `append(__anchor, …)` lands
  // its nodes before it — the DOM path's anchor comment, as a cell. The
  // registry is keyed by that marker, so each call gets one of its own.
  const emitComponent = (n, parent, ind) => {
    const m = marker(parent, ind)
    const props = n.props.map((p) => {
      const key = IDENT.test(p.name) ? p.name : q1(p.name)
      if (p.value === true) return `${key}: true`
      if (typeof p.value === 'string') return `${key}: ${q1(p.value)}`
      dep(p.value.expr)
      return `${key}: ${p.value.expr.code}`
    })
    // Spreads first and the written props last, so a written prop wins, as
    // on the DOM path.
    for (const e of n.spreads) dep(e)
    // A snippet passed to a component is declared in the calling scope, which
    // it closes over, under a name of its own: two calls may each take a `row`.
    for (const s of n.snippets) {
      const name = `$$snip${seq.s++}_${s.name}`
      emitSnippet(s, name, ind)
      props.push(`${IDENT.test(s.name) ? s.name : q1(s.name)}: ${name}`)
    }
    const literal = `{${props.join(', ')}}`
    const obj = n.spreads.length
      ? `Object.assign({}, ${n.spreads.map((e) => `(${e.code})`).join(', ')}, ${literal})`
      : literal
    const slots = Object.keys(n.slots)
    if (!slots.length) line(ind, `${n.call}(${m}, ${obj}, null);`)
    else {
      line(ind, `${n.call}(${m}, ${obj}, {`)
      slots.forEach((name, i) => {
        line(ind + 1, `${IDENT.test(name) ? name : q1(name)}: () => {`)
        emitFragment(n.slots[name], ind + 2)
        line(ind + 1, i < slots.length - 1 ? '},' : '}')
      })
      line(ind, '});')
    }
    // The child's registry is found by its anchor, so every call below needs
    // it registered first; the order is the DOM path's.
    const live = n.spreads.length || n.props.some((p) => typeof p.value === 'object')
    if (live || n.binds.length || n.ref) line(ind, `$$runtime.registerComponentAnchor(${m});`)
    for (const b of n.binds) line(ind, `$$runtime.bindProp(${m}, ${q1(b.name)}, (v) => ${b.setter}(v));`)
    if (n.ref) line(ind, `${n.ref}($$runtime.componentApi(${m}));`)
    // The whole object, as the DOM path pushes it: an undeclared key is the
    // child's `$attributes`, rebuilt from each push.
    if (live) line(ind, `$$runtime.createEffect(() => { $$runtime.pushProps(${m}, ${obj}); });`)
  }

  const emitSlot = (n, parent, ind) => {
    ;(ctx.slotNames ??= new Set()).add(n.name)
    const m = marker(parent, ind)
    const block = `__block?.[${q1(n.name)}]`
    if (!n.fallback.length) { line(ind, `$$tui.slot(${m}, ${block}, null);`); return }
    line(ind, `$$tui.slot(${m}, ${block}, () => {`)
    emitFragment(n.fallback, ind + 1)
    line(ind, '});')
  }

  const emitNode = (n, parent, ind) => {
    switch (n.kind) {
      case 'element':   return emitElement(n, parent, ind)
      case 'text':      return emitText(n, parent, ind)
      case 'comment':   return
      case 'if':        return emitIf(n, parent, ind)
      case 'each':      return emitEach(n, parent, ind)
      case 'component': return emitComponent(n, parent, ind)
      case 'slot':      return emitSlot(n, parent, ind)
      case 'render':    return emitRender(n, parent, ind)
      case 'dynamic-element': return emitDynamicElement(n, parent, ind)
      case 'const':     dep(n.value); for (const l of n.lines) line(ind, l); return
      default:          throw new Error(`terminal emitter reached a ${n.kind} node that terminalOffenses passed`)
    }
  }

  line(0, 'const $$parentElement = $$tui.fragment();')
  emitChildren(ir.children, '$$parentElement', 0)
  line(0, '$$tui.append(__anchor, $$parentElement);')

  // The scoped rules are handed back rather than emitted: a terminal paints
  // no CSS, and a caller that asked for them can still read them.
  if (ctx.css?.active?.()) {
    const style = ctx.css.getContent()
    if (style) ctx.css.result = style
  }

  const runtime = xNode.block({ scope: true })
  ctx.module.body.push(runtime)
  runtime.push(xNode('terminal', { lines }, (w, n) => {
    for (const [ind, text] of n.lines) {
      w.indent = ind
      w.writeLine(text)
    }
    w.indent = 0
  }))
}
