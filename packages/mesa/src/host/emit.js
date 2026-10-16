/**
 * The host emitter: the stage compile() runs for every target in
 * `targets.js` (`FJS-D699`, `FJS-D1074`). Reads `ctx.ir` and writes the
 * component's template block as calls on `$$host`, the target's runtime,
 * into `ctx.module.body`, where the DOM builder would have written its
 * template and traversal. Every function here takes the target's profile
 * as `t`; nothing names a target or an engine.
 *
 * It refuses rather than approximates: a tag or event missing from the
 * target's tables, any directive and every `unlowered` node throw
 * `X at File.mesa:L:C has no <target> lowering`, the first offender in
 * document order. `hostOffenses` is the one list of them — the emitter
 * throws its head and the portability report (`scripts/corpus.mjs
 * --portability <target>`) tallies all of it, so the report cannot count a
 * node the emitter would paint or miss one it refuses. A file with a
 * `<script module>` is not refused at compile: the compiler keeps that half
 * and moves the throw into the default export (`targetRefusal`, `FJS-2182`).
 *
 * The lines are built EAGERLY and the xNode only writes them. The head
 * declarations (`$$props`, `$$emit`, …) are emitted only when
 * `ctx.inuse` says a template expression reached for them, and the head
 * resolves before the body — a `detectDependency` made at write time would
 * come too late, which is why the DOM builder makes its own at build time.
 */

import { xNode, Q, PRESERVE_WHITESPACE, contentFallback } from '../compiler.js'
import { htmlEntitiesToText } from '../entities.js'
import { eachNode } from '../ir.js'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** A single-quoted JS string literal. */
function q1(s) {
  return "'" + String(s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'"
}

const refusalText = (t, what, loc) => `${what}${loc ? ` at ${loc}` : ''} has no ${t.name} lowering`

/** The source spelling of a node the IR did not lower, for the refusal. */
function spelling(u) {
  const n = u.node
  switch (u.what) {
    case 'component':    return `<${n.name}>`
    case 'mesa-element': return `<mesa:${n.elArg}>`
    case 'await':        return '{#await}'
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
 * Every node in `ir` the target cannot paint, in document order, then every
 * `<style>` rule its stylesheet cannot (`cssOffense`), as
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

/** The attribute `tags.js` says an image cannot be painted without, if `n` lacks it. */
const missing = (t, n) => [t.tags[n.tag]?.text].filter((a) => a && !n.attrs.some((x) => x.name === a))
const paints = (t, n) => !!t.tags[n.tag] && !missing(t, n).length

const ariaHidden = (n) => n.attrs.some((a) => a.name === 'aria-hidden' && a.value === 'true')

/**
 * The elements the terminal leaves out rather than refuses: a tag missing
 * from `tags.js`, or an image lacking its `text` attribute, on an element that
 * is, or sits inside, a static
 * `aria-hidden="true"`. The author has said a reader needs nothing there —
 * the icon in an alert, a sort arrow beside a header — so the terminal paints
 * what assistive technology reads. Lexical: a component called inside one is
 * its own file and answers for itself. One answer for `hostOffenses` and
 * the emitter both, so the report cannot count a node the emitter drops.
 */
export function hostDropped(ir, t) {
  const dropped = new Set()
  const walk = (children, hidden) => eachNode(children, (n) => {
    if (n.kind !== 'element' && n.kind !== 'dynamic-element') return
    const h = hidden || ariaHidden(n)
    if (h && n.kind === 'element' && !paints(t, n)) { dropped.add(n); return false }
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
const isField = (t, n) => ['input', 'textarea'].includes(t.tags[n.tag]?.role)
// A `<progress>`'s children are the fallback a browser shows only when it
// cannot draw the bar, and an `<svg>`'s are drawing, which a terminal shows
// as the image's text; nothing in either is built or refused.
const childless = (t, n) => ['progress', 'image'].includes(t.tags[n.tag]?.role)
// The roles a person changes the value of, so the only ones a `bind:value`
// hears back from.
const CONTROLS = ['input', 'textarea', 'select']
const hasValue = (n) => n.attrs.some((a) => a.name === 'value')
const liveText = (n) => n.children.some((c) => !blank(c) && !(c.kind === 'text' && c.static))
const fieldText = (n) => n.children
  .filter((c) => c.kind === 'text').flatMap((c) => c.parts).map((p) => p.value).join('')
  .replace(/^\r?\n/, '')

/**
 * Where a `<pre>`'s whitespace is the content, a browser still drops two
 * newlines: the one right after the open tag, and one ending the block,
 * which opens no line. The engine paints both, so the text that starts the
 * block loses its first and the text that ends it loses its last.
 */
const preserves = (t, n) => PRESERVE_WHITESPACE.has(n.tag) && !isField(t, n)
function preEdges(n, starts, ends) {
  const first = n.children[0]
  if (first?.kind === 'text' && first.parts[0]?.kind === 'static') starts.add(first)
  let last = n.children.at(-1)
  while (last?.kind === 'element' && last.children.length) last = last.children.at(-1)
  if (last?.kind === 'text' || last?.kind === 'html') ends.add(last)
}
/**
 * The white space between two siblings that may sit in one line, which a
 * browser paints as one space: `</kbd> <kbd>`, `</button> <button>`. Kept as
 * one space unless either neighbor is a block tag, beside which a browser
 * paints none. One beside a component, a block or a slot cannot be judged
 * here, and the runtime drops it where it starts a line (`flow`).
 */
function spacesIn(t, children) {
  const out = new Set()
  const real = children.filter((c) => c.kind !== 'comment' && c.kind !== 'snippet' && c.kind !== 'const')
  const block = (c) => c?.kind === 'element' && !t.isInline(c.tag)
  real.forEach((c, i) => {
    if (i === 0 || i === real.length - 1 || !blank(c)) return
    if (!block(real[i - 1]) && !block(real[i + 1])) out.add(c)
  })
  return out
}
const LEADING_NEWLINE = /^\r?\n/
const TRAILING_NEWLINE = /\r?\n$/

/**
 * An `<input>` is the control its `type` names (`INPUT_TYPES`). A static type
 * the table lacks is refused here, and a live one when it is written. A bind
 * that does not fit the type is refused too: `checked` and `group` are a
 * check's, `value` a field's, and a file input takes none. A live `type`
 * cannot be judged here, so the runtime refuses that pairing when it binds.
 */
function inputOffenses(t, n, add) {
  const type = n.attrs.find((a) => a.name === 'type')
  if (typeof type?.value === 'object') return
  const kind = t.inputKind(type?.value)
  if (!kind) {
    add(`type="${type.value}" on <input>`, `type="${type.value}" on <input>`, n.loc)
    return
  }
  for (const b of n.binds) {
    if (kind !== 'file' && (b.name === 'value') === (kind === 'field')) continue
    add(`bind:${b.name} on <input type="${type?.value ?? 'text'}">`, `bind:${b.name} on <input type="${type?.value ?? 'text'}">`, b.loc)
  }
}

const elementOffenses = (t, n, add) => {
  for (const d of n.directives) add(d.name, directiveShape(d.name), d.loc)
  for (const h of n.handlers) if (!t.events[h.event]) add(`on${h.event}`, `on${h.event}`, h.loc)
}

// `passive` promises a browser the handler never prevents a scroll; a
// terminal scrolls nothing, so it has no listener option to become.
const listenerOptions = (h) => {
  const opts = h.modifiers.filter((m) => m.name === 'capture' || m.name === 'once').map((m) => `${m.name}: true`)
  return opts.length ? `, { ${opts.join(', ')} }` : ''
}

export function hostOffenses(ir, t) {
  const out = []
  const add = (what, shape, loc) => out.push({ what, shape, loc })
  const dropped = hostDropped(ir, t)
  // A cell alone in its row already fills the row, so its colspan moves no
  // value under another header: the empty-state row every table carries.
  const alone = new Set()
  eachNode(ir.children, (n) => {
    if (dropped.has(n)) return false
    switch (n.kind) {
      case 'element':
        if (!t.tags[n.tag]) add(`<${n.tag}>`, `<${n.tag}>`, n.loc)
        for (const a of missing(t, n)) add(`<${n.tag}> without ${a}`, `<${n.tag}> without ${a}`, n.loc)
        if (n.tag === 'tr') {
          const cells = n.children.filter((c) => !blank(c))
          if (cells.length === 1 && cells[0].kind === 'element') alone.add(cells[0])
        }
        for (const a of n.attrs) {
          if (!t.tags[n.tag]?.refuses?.includes(a.name)) continue
          if (a.name === 'colspan' && alone.has(n)) continue
          // A live `multiple` is checked when it is written, since the kit's
          // `<Select>` passes `multiple={multiple}`, false unless asked.
          if (a.name === 'multiple' && typeof a.value === 'object') continue
          add(`${a.name} on <${n.tag}>`, `${a.name} on <${n.tag}>`, n.loc)
        }
        if (!CONTROLS.includes(t.tags[n.tag]?.role)) {
          for (const b of n.binds) add(`bind:${b.name} on <${n.tag}>`, 'bind: on a non-control', b.loc)
        } else if (n.tag === 'input') inputOffenses(t, n, add)
        if (isField(t, n) && !hasValue(n) && liveText(n)) {
          add(`live text in <${n.tag}> without value=`, `live text in <${n.tag}>`, n.loc)
          return false
        }
        elementOffenses(t, n, add)
        return childless(t, n) ? false : undefined
      // A tag that is a read is checked against the same table when it is
      // built, naming the tag; only a literal one can be refused here.
      case 'dynamic-element': {
        if (!n.tag) add('<mesa:element> without this', '<mesa:element> without this', n.loc)
        else if (/^"[^"]*"$/.test(n.tag.code) && !t.tags[JSON.parse(n.tag.code)]) {
          add(`<${JSON.parse(n.tag.code)}>`, `<${JSON.parse(n.tag.code)}>`, n.loc)
        }
        elementOffenses(t, n, add)
        return
      }
      // The window is the end of every event's path; a document and a body
      // would be two more stops on it that no component here listens at.
      case 'global': {
        const tag = `<mesa:${n.target}>`
        if (n.target !== 'window') add(tag, tag, n.loc)
        elementOffenses(t, n, add)
        if (n.ref) add(`bind:this on ${tag}`, `bind:this on ${tag}`, n.loc)
        for (const b of n.binds) add(`bind:${b.name} on ${tag}`, `bind: on ${tag}`, b.loc)
        for (const a of n.attachments) add(`{@attach} on ${tag}`, `{@attach} on ${tag}`, a.loc)
        return
      }
      case 'text':
        for (const p of n.parts) if (p.kind === 'unlowered') add(spelling(p), spelling(p), p.loc)
        return
      case 'comment':
      case 'portal':
      case 'component':
      case 'if':
      case 'each':
      case 'key':
      case 'snippet':
      case 'render':
      case 'const':
      case 'html':
        return
      case 'unlowered':
        return add(spelling(n), n.what === 'component' ? 'component' : spelling(n), n.loc)
      default:
        return add(`{${n.kind}}`, `{${n.kind}}`, n.loc)
    }
  })
  for (const r of ir.styles?.rules ?? []) {
    const o = t.cssOffense(r.prelude)
    if (o) add(o.what, o.shape, r.loc)
  }
  return out
}

/** The refusal for `ir`'s first offender in document order, or null when it lowers. */
export function hostRefusal(ir, t) {
  const [first] = hostOffenses(ir, t)
  return first ? refusalText(t, first.what, first.loc) : null
}

// ─── emit ─────────────────────────────────────────────────────────────────────

export function buildHost(ctx, t) {
  const ir = ctx.ir
  for (const d of ir.diagnostics ?? []) ctx.analysis.errors.push(d)
  const refused = hostRefusal(ir, t)
  if (refused) throw new Error(refused)
  const dropped = hostDropped(ir, t)
  const scope = t.paintsCss ? ir.styles?.scope : null

  const seq = { el: 0, t: 0, m: 0, s: 0 }
  const lines = []
  const line = (ind, text) => lines.push([ind, text])
  const dep = (e) => ctx.detectDependency(e.raw)

  const emitFragment = (children, ind) => {
    line(ind, 'const $$b = $$host.fragment();')
    emitChildren(children, '$$b', ind)
    line(ind, 'return $$b;')
  }

  // How many `<pre>`s the node being emitted sits in, and the texts at a
  // `<pre>`'s two edges (`preEdges`).
  let inPre = 0
  const startsPre = new Set()
  const endsPre = new Set()
  const spaces = new Set()

  // A body's snippets are declared before anything in it, since a
  // `{@render}` may come first in the source.
  const emitChildren = (children, parent, ind) => {
    for (const c of spacesIn(t, children)) spaces.add(c)
    for (const c of children) if (c.kind === 'snippet') emitSnippet(c, c.varName, ind)
    for (const c of children) if (c.kind !== 'snippet' && !dropped.has(c)) emitNode(c, parent, ind)
  }

  // The DOM path's shape: an anchor, then one getter per argument, and the
  // content placed before the anchor.
  // Content passed to a component is marked, as on the DOM path, so the
  // child can report what it drops.
  const emitSnippet = (n, name, ind, content = false) => {
    const fn = `(${['__anchor', ...n.params].join(', ')}) => {`
    line(ind, `const ${name} = ${content ? `$$runtime.content(${fn}` : fn}`)
    line(ind + 1, 'const $$b = $$host.fragment();')
    emitChildren(n.children, '$$b', ind + 1)
    line(ind + 1, '$$host.append(__anchor, $$b);')
    line(ind, content ? '});' : '};')
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
    line(ind, `$$host.keyBlock(${m}, () => (${n.tag.code}), ($$tag) => {`)
    line(ind + 1, 'const $$b = $$host.fragment();')
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
    const field = isField(t, n)
    if (field && fieldText(n)) attrs.push(`value: ${q1(htmlEntitiesToText(fieldText(n)))}`)
    // The scoped rules match on the component's class, which every element
    // it writes carries beside its own, as on the DOM path.
    const args = [tag]
    if (attrs.length || scope) args.push(attrs.length ? `{ ${attrs.join(', ')} }` : '{}')
    if (scope) args.push(q1(scope))
    line(ind, `const ${el} = $$host.element(${args.join(', ')});`)
    line(ind, `$$host.append(${parent}, ${el});`)
    // A live attribute is a static one that moves: the same owner, written
    // from a render effect guarded the way a text binding is.
    for (const a of n.attrs) {
      if (typeof a.value !== 'object') continue
      dep(a.value.expr)
      if (a.value.kind === 'spread') {
        line(ind, `$$host.spread(${el}, () => (${a.value.expr.code}));`)
        continue
      }
      line(ind, '$$runtime.render((__prev) => {')
      line(ind + 1, `var __a; try { __a = (${a.value.expr.code}); } catch (e) { __a = $$runtime.contain(e, __prev.a); }`)
      line(ind + 1, `if (__prev.a !== __a) $$host.set_attribute(${el}, ${q1(a.name)}, __prev.a = __a);`)
      line(ind, '}, { a: undefined });')
    }
    // A target that paints no CSS drops a `style:` as it does the `style`
    // attribute and the scoped rules; its `class:` reaches it only for a name
    // it paints, which for the terminal is a surface or a see-through variant,
    // as for the `class` attribute (`opaque`).
    if (t.paintsCss) for (const st of n.styles) {
      dep(st.expr)
      line(ind, '$$runtime.render((__prev) => {')
      line(ind + 1, `var __s; try { __s = (${st.expr.code}); } catch (e) { __s = $$runtime.contain(e, __prev.s); }`)
      line(ind + 1, `if (__prev.s !== __s) $$host.set_style(${el}, ${q1(st.prop)}, __prev.s = __s);`)
      line(ind, '}, { s: undefined });')
    }
    for (const c of n.classes) {
      if (!t.paintsClass(c.name)) continue
      dep(c.expr)
      line(ind, '$$runtime.render((__prev) => {')
      line(ind + 1, `var __c; try { __c = !!(${c.expr.code}); } catch (e) { __c = $$runtime.contain(e, __prev.c); }`)
      line(ind + 1, `if (__prev.c !== __c) $$host.toggle_class(${el}, ${q1(c.name)}, __prev.c = __c);`)
      line(ind, '}, { c: undefined });')
    }
    if (preserves(t, n)) { preEdges(n, startsPre, endsPre); inPre++ }
    if (!field && !childless(t, n)) emitChildren(n.children, el, ind)
    if (preserves(t, n)) inPre--
    for (const h of n.handlers) {
      dep(h.expr)
      line(ind, `$$host.on(${el}, '${h.event}', ${h.expr.code}${listenerOptions(h)});`)
    }
    for (const b of n.binds) {
      if (b.name !== 'group') { line(ind, `$$host.bind(${el}, ${q1(b.name)}, ${b.getter}, ${b.setter});`); continue }
      const v = b.value
      if (typeof v === 'object' && v) dep(v.expr)
      const value = typeof v === 'string' ? q1(htmlEntitiesToText(v)) : v && typeof v === 'object' ? `(${v.expr.code})` : `${el}.value`
      line(ind, `$$host.bind(${el}, 'group', ${b.getter}, ${b.setter}, () => ${value});`)
    }
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
    const parts = n.parts.map((p, i) => {
      if (p.kind !== 'static') return p
      let value = p.value
      if (i === 0 && startsPre.has(n)) value = value.replace(LEADING_NEWLINE, '')
      if (i === n.parts.length - 1 && endsPre.has(n)) value = value.replace(TRAILING_NEWLINE, '')
      return { ...p, value }
    })
    if (n.static) {
      const value = parts.map((p) => p.value).join('')
      if (!value.trim()) {
        if (spaces.has(n)) line(ind, `$$host.append(${parent}, $$host.text(' '));`)
        return
      }
      line(ind, `$$host.append(${parent}, $$host.text(${q1(htmlEntitiesToText(value))}));`)
      return
    }
    // One template literal for the whole text, each hole guarded on its own —
    // the same shape the DOM path's render group gives a text binding (FJS-D208).
    let tpl = '`' + parts.map((p) => {
      if (p.kind === 'static') return Q(htmlEntitiesToText(p.value))
      dep(p.expr)
      return '${(' + p.expr.code + ") ?? ''}"
    }).join('') + '`'
    if (endsPre.has(n) && parts.at(-1).kind !== 'static') tpl += `.replace(${TRAILING_NEWLINE}, '')`
    liveText(parent, ind, tpl)
  }

  const liveText = (parent, ind, value, node = "$$host.text('')") => {
    const t = `$$t${seq.t++}`
    line(ind, `const ${t} = ${node};`)
    line(ind, `$$host.append(${parent}, ${t});`)
    line(ind, '$$runtime.render((__prev) => {')
    line(ind + 1, `var __a; try { __a = ${value}; } catch (e) { __a = $$runtime.contain(e, __prev.a); }`)
    line(ind + 1, `if (__prev.a !== __a) $$host.set_text(${t}, __prev.a = __a);`)
    line(ind, "}, { a: '' });")
  }

  // Markup is painted as the text a browser's `innerText` reads from it,
  // since a terminal has text and no markup.
  const emitHtml = (n, parent, ind) => {
    dep(n.value)
    let value = `$$host.markupText((${n.value.code}), ${inPre > 0})`
    if (endsPre.has(n)) value += `.replace(${TRAILING_NEWLINE}, '')`
    liveText(parent, ind, value, '$$host.markup()')
  }

  const marker = (parent, ind) => {
    const m = `$$m${seq.m++}`
    line(ind, `const ${m} = $$host.marker();`)
    line(ind, `$$host.append(${parent}, ${m});`)
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
    line(ind, `$$host.ifBlock(${m}, ${select}, [`)
    const blocks = n.branches.map((b) => b.children)
    if (n.else) blocks.push(n.else)
    blocks.forEach((children, i) => {
      line(ind + 1, '() => {')
      emitFragment(children, ind + 2)
      line(ind + 1, i < blocks.length - 1 ? '},' : '}')
    })
    line(ind, ']);')
  }

  const emitKey = (n, parent, ind) => {
    const m = marker(parent, ind)
    dep(n.key)
    line(ind, `$$host.keyBlock(${m}, () => (${n.key.code}), () => {`)
    emitFragment(n.children, ind + 1)
    line(ind, '});')
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
    line(ind, `$$host.eachBlock(${m}, () => (${n.items.code}), ${keyFn}, (${params}) => {`)
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
    const keyOf = (name) => (IDENT.test(name) ? name : q1(name))
    const values = n.props.map((p) => {
      if (p.value === true) return 'true'
      if (typeof p.value === 'string') return q1(p.value)
      dep(p.value.expr)
      return p.value.expr.code
    })
    const props = n.props.map((p, i) => `${keyOf(p.name)}: ${values[i]}`)
    // Spreads first and the written props last, so a written prop wins, as
    // on the DOM path.
    for (const e of n.spreads) dep(e)
    // A snippet passed to a component is declared in the calling scope, which
    // it closes over, under a name of its own: two calls may each take a `row`.
    // A prop written under the same name is the override and the content its
    // fallback, as on the DOM path.
    for (const s of n.snippets) {
      const name = `$$snip${seq.s++}_${s.name}`
      emitSnippet(s, name, ind, true)
      const written = n.props.findIndex((p) => p.name === s.name)
      if (written === -1) props.push(`${keyOf(s.name)}: ${name}`)
      else props[written] = `${keyOf(s.name)}: ${contentFallback(values[written], name)}`
    }
    const literal = `{${props.join(', ')}}`
    const obj = n.spreads.length
      ? `Object.assign({}, ${n.spreads.map((e) => `(${e.code})`).join(', ')}, ${literal})`
      : literal
    line(ind, `${n.call}(${m}, ${obj}, null);`)
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

  // Wired where it is written, so it lives as long as the block around it.
  const emitGlobal = (n, ind) => {
    for (const h of n.handlers) {
      dep(h.expr)
      line(ind, `$$host.onWindow('${h.event}', ${h.expr.code}${listenerOptions(h)});`)
    }
  }

  const emitNode = (n, parent, ind) => {
    switch (n.kind) {
      case 'element':   return emitElement(n, parent, ind)
      case 'text':      return emitText(n, parent, ind)
      case 'comment':   return
      case 'if':        return emitIf(n, parent, ind)
      case 'each':      return emitEach(n, parent, ind)
      case 'key':       return emitKey(n, parent, ind)
      case 'component': return emitComponent(n, parent, ind)
      case 'render':    return emitRender(n, parent, ind)
      case 'html':      return emitHtml(n, parent, ind)
      case 'dynamic-element': return emitDynamicElement(n, parent, ind)
      case 'const':     dep(n.value); for (const l of n.lines) line(ind, l); return
      case 'global':    return emitGlobal(n, ind)
      // `to` names a DOM node and is never read: a terminal has one surface,
      // so the children paint where the portal is written, beside the
      // element it was opened from in every kit use.
      case 'portal':    return emitChildren(n.children, parent, ind)
      default:          throw new Error(`${t.name} emitter reached a ${n.kind} node that hostOffenses passed`)
    }
  }

  line(0, 'const $$parentElement = $$host.fragment();')
  emitChildren(ir.children, '$$parentElement', 0)
  line(0, '$$host.append(__anchor, $$parentElement);')

  // The scoped rules are handed back rather than emitted, whatever `css`
  // says: an engine that paints them reads its stylesheet from the bundle,
  // which a build assembles (`scripts/host-tree.js`), and has no call that
  // adds one at runtime.
  if (ctx.css?.active?.()) {
    const style = ctx.css.getContent()
    if (style) ctx.css.result = style
  }

  const runtime = xNode.block({ scope: true })
  ctx.module.body.push(runtime)
  runtime.push(xNode('host', { lines }, (w, n) => {
    for (const [ind, text] of n.lines) {
      w.indent = ind
      w.writeLine(text)
    }
    w.indent = 0
  }))
}
