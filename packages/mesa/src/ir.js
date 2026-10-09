/**
 * The IR — the template half of a `.mesa` file after parse and analysis,
 * lowered into one tree every target reads (`IDEAS/mesa-ir.md` § 2). The
 * script half is not here: it is JavaScript over signals and every target
 * runs it unchanged.
 *
 * `lower(ctx)` runs on EVERY compile, after `emitScript` (so `ctx.accessors`
 * exists) and before the target's builder. It never throws on a node it does
 * not translate — that node becomes `{ kind: 'unlowered', what, loc, node }`,
 * named rather than dropped, which is what a portability report reads and
 * what a target refuses by name.
 *
 * It must leave the compile exactly as it found it, because the DOM builder
 * runs after it over the same `ctx`: the each-row accessor frame is entered
 * through the same `eachFrame` the DOM builder uses and restored; the two
 * per-compile counters that frame bumps are put back; and the errors
 * `applyEventModifiers` reports are moved off `ctx.analysis.errors` onto
 * `root.diagnostics`, so the DOM target reports each one once and the
 * terminal emitter reports them in its place.
 *
 * An expression is `{ raw, code, reads }`: the source text, what the DOM path
 * hands its emitter for that position, and the sorted accessor names it
 * reads. A handler's `code` is the handler AFTER its modifiers are applied.
 */

import {
  rewriteExpr, rewriteTextResult, extractKeywords, parseModifiers, applyEventModifiers,
  unwrapExp, parseEachHeader, eachFrame, templateSource, routeSlots, componentAttributes, toCamelCase,
} from './compiler.js'

// ─── expressions ──────────────────────────────────────────────────────────────

function readsOf(ctx, raw) {
  if (!ctx.accessors) return []
  let names
  try { names = extractKeywords(raw) } catch (_) { return [] }
  return names.filter((n) => Object.hasOwn(ctx.accessors, n)).sort()
}

function expr(ctx, raw, code) {
  return { raw, code, reads: readsOf(ctx, raw) }
}

function read(ctx, raw) {
  return expr(ctx, raw, ctx.accessors ? rewriteExpr(raw, ctx.accessors) : raw)
}

/** An expression in a position that may assign — a handler or a callback
 *  prop — where an assignment target must become a signal write. */
function write(ctx, raw) {
  return expr(ctx, raw, ctx.accessors ? rewriteExpr(raw, ctx.accessors, ctx.setters, ctx.proxyFireFns) : raw)
}

/** A quoted value with holes, `"y {n}"`: one template literal, the shape the
 *  DOM path gives the same attribute. */
function interpolated(ctx, raw) {
  const pe = ctx.parseText(raw)
  return expr(ctx, raw, ctx.accessors ? rewriteTextResult(pe, ctx.accessors) : pe.result)
}

// ─── attributes ───────────────────────────────────────────────────────────────

// What `bindProp` treats as something other than an attribute value. A name
// here is kept as a directive so a target can refuse it BY NAME; a name with
// a colon that is not here (`xlink:href`) is an attribute.
const DIRECTIVE_PREFIXES = [
  'bind:', 'class:', 'use:', 'transition:', 'in:', 'out:', 'animate:', 'client:',
]

/** `style:prop`'s value, read the three ways `bindProp` reads it: bare is
 *  the variable named for the property (`style:font-size` reads `fontSize`),
 *  `{expr}` an expression, and a quoted value with holes a template. */
function styleValue(ctx, p, prop) {
  if (!p.value) return read(ctx, toCamelCase(prop))
  if (p.type === 'exp' || (p.value.startsWith('{') && p.value.endsWith('}'))) return read(ctx, unwrapExp(p.value))
  return interpolated(ctx, p.value)
}

function lowerAttributes(ctx, n) {
  const attrs = [], handlers = [], directives = [], styles = []
  for (const p of n.attributes) {
    let name = p.name
    const loc = ctx.posOf(p.start ?? n.start)
    const raw = p.content ?? p.raw ?? name
    if (p.type === 'attach' || name === '@attach') { directives.push({ name: '{@attach}', raw, loc }); continue }
    // `{...spread}`, `{*raw}` and `*{raw}` carry their whole text as the name.
    // A spread stays among the attributes because their order is the order
    // the DOM path applies them in, and a later one wins.
    if (name.startsWith('{...') && name.endsWith('}')) {
      attrs.push({ name, value: { kind: 'spread', expr: read(ctx, name.slice(4, -1)) } })
      continue
    }
    if (name[0] === '{' || name.startsWith('*{')) { directives.push({ name, raw, loc }); continue }
    // The bare HTML spelling is the same handler, normalized the way bindProp does.
    if (/^on[a-z]/.test(name) && !name.startsWith('on:')) name = 'on:' + name.slice(2)
    if (name[0] === '@' || name.startsWith('on:')) {
      const { directive, modifiers } = parseModifiers(name)
      const event = directive.startsWith('on:') ? directive.slice(3) : directive.slice(1)
      const rawHand = p.value ? unwrapExp(p.value) : '() => {}'
      const code = applyEventModifiers(ctx, modifiers, event, write(ctx, rawHand).code).handler
      handlers.push({ event, modifiers, expr: expr(ctx, rawHand, code), loc })
      continue
    }
    if (name.startsWith('style:')) {
      const prop = name.slice(6)
      styles.push({ prop, expr: styleValue(ctx, p, prop), loc })
      continue
    }
    if (name === 'this' || name[0] === ':' || DIRECTIVE_PREFIXES.some((pre) => name.startsWith(pre))) {
      directives.push({ name, raw, loc })
      continue
    }
    if (p.type === 'exp') {
      attrs.push({ name, value: { kind: 'binding', expr: read(ctx, unwrapExp(p.value)), to: 'attr' } })
      continue
    }
    if (p.type === 'text' && p.value.includes('{')) {
      attrs.push({ name, value: { kind: 'binding', expr: interpolated(ctx, p.value), to: 'attr' } })
      continue
    }
    attrs.push({ name, value: p.type === 'attribute' ? true : p.value })
  }
  return { attrs, handlers, directives, styles }
}

// ─── components and slots ─────────────────────────────────────────────────────

/**
 * `<Child …>`: the call `makeComponent` emits on the DOM path, as data, read
 * off `componentAttributes` — the one answer to what each attribute is. A
 * prop is `{ name, value }` where `value` is `true` (a bare attribute), a
 * string, or a binding; a spread is a read. `bind:` and `bind:this` are kept
 * as directives, so a target that cannot wire them refuses them by name. An
 * attribute `componentAttributes` refuses is reported, as the DOM path
 * reports it, and passes nothing on either target. `client:` is a hint to a
 * server render and is dropped, as the DOM path drops it without `islands`.
 *
 * `slots` maps a slot name to its lowered children, routed by `routeSlots`,
 * the one routing the DOM path builds from too. A `{#snippet}` child is a
 * prop on the DOM path, so it is kept apart rather than lowered into the
 * default slot.
 */
function lowerComponent(ctx, n) {
  const props = [], spreads = [], directives = []
  const at = ctx.posOf(n.start)
  for (const a of componentAttributes(n)) {
    const p = a.attr
    const loc = ctx.posOf(p.start ?? n.start)
    switch (a.kind) {
      case 'refused':
        ctx.analysis?.errors.push(`${a.message} — ${at}`)
        break
      case 'spread':
        spreads.push(read(ctx, a.expr))
        break
      case 'bind':
      case 'bind-this':
        directives.push({ name: p.name, loc })
        break
      case 'prop': {
        let value
        if (p.value === undefined) value = true
        else if (p.type === 'exp') value = { kind: 'binding', expr: write(ctx, unwrapExp(p.raw)), to: 'prop' }
        else if (p.value.includes('{')) value = { kind: 'binding', expr: interpolated(ctx, p.value), to: 'prop' }
        else value = p.value
        props.push({ name: a.name, value })
        break
      }
    }
  }

  const routing = routeSlots(n, ctx.config?.preserveComments)
  const slots = {}
  for (const [name, nodes] of routing.slots) slots[name] = lowerChildren(ctx, nodes)
  const snippets = routing.snippets.map((s) => unlowered(ctx, 'snippet', s))

  const accessor = ctx.accessors?.[n.name]
  return {
    kind: 'component',
    name: n.name,
    call: accessor && accessor !== n.name ? accessor : n.name,
    loc: ctx.posOf(n.start),
    props,
    spreads,
    directives,
    slots,
    snippets,
  }
}

/** `<slot>` / `<slot:name>` / `<slot name="x">` with its fallback content.
 *  An attribute other than `name` is a directive: the DOM path reports it,
 *  and a slot carries nothing outward. */
function lowerSlot(ctx, n) {
  const nameAttr = n.attributes?.find((a) => a.name === 'name')
  const directives = (n.attributes ?? [])
    .filter((a) => a !== nameAttr)
    .map((a) => ({ name: a.name, loc: ctx.posOf(a.start ?? n.start) }))
  return {
    kind: 'slot',
    name: n.elArg || nameAttr?.value?.replace(/^['"]|['"]$/g, '') || 'default',
    loc: ctx.posOf(n.start),
    directives,
    fallback: lowerChildren(ctx, n.body ?? []),
  }
}

// ─── nodes ────────────────────────────────────────────────────────────────────

const SYSTAGS = { render: 'render', html: 'html', const: 'const', debug: 'debug' }

function unlowered(ctx, what, node) {
  return { kind: 'unlowered', what, loc: ctx.posOf(node.start), node }
}

function lowerText(ctx, n) {
  const loc = ctx.posOf(n.start)
  if (!n.value.includes('{')) return { kind: 'text', parts: [{ kind: 'static', value: n.value }], static: true }
  // pathOnly is the PROSE rule (FJS-D213), the same switch the DOM builder reads.
  const pe = ctx.parseText(n.value, { pathOnly: ctx.config?.pathInterpolation === true })
  const parts = pe.parts.map((p) => {
    if (p.type === 'text') return { kind: 'static', value: p.value }
    if (p.type === 'exp') return { kind: 'binding', expr: read(ctx, p.value), to: 'text' }
    return { kind: 'unlowered', what: 'js-text', loc, node: p }
  })
  return { kind: 'text', parts, static: parts.every((p) => p.kind === 'static') }
}

function lowerIf(ctx, n) {
  const branches = n.parts.map((part) => {
    const rx = part.value.match(/^(#if|:elif|:else\s+if)\s(.*)$/s)
    return { test: read(ctx, rx?.[2]?.trim() ?? ''), children: lowerChildren(ctx, part.body) }
  })
  return {
    kind: 'if',
    loc: ctx.posOf(n.start),
    branches,
    else: n.elsePart ? lowerChildren(ctx, n.elsePart) : null,
  }
}

function lowerEach(ctx, n) {
  const header = parseEachHeader(n.value)
  const { arrayName, itemName, indexName, keyName, isDestructure, destructurePattern, patNames } = header
  const items = read(ctx, arrayName)

  // The key is called with VALUES, so the row names are plain parameters
  // there: they shadow the outer accessors instead of becoming getters.
  let key = null
  if (keyName) {
    let code = keyName
    if (ctx.accessors) {
      const shadowed = { ...ctx.accessors }
      for (const name of isDestructure ? patNames : [itemName]) shadowed[name] = name
      if (indexName) shadowed[indexName] = indexName
      code = rewriteExpr(keyName, shadowed)
    }
    key = expr(ctx, keyName, code)
  }

  const frame = eachFrame(ctx, header, templateSource(n.mainBlock))
  let children
  try { children = lowerChildren(ctx, n.mainBlock) } finally { frame.restore() }

  return {
    kind: 'each',
    loc: ctx.posOf(n.start),
    items,
    item: isDestructure ? { pattern: destructurePattern, names: patNames, fn: frame.patFn } : { name: itemName },
    index: indexName,
    key,
    children,
    else: n.elseBlock ? lowerChildren(ctx, n.elseBlock) : null,
  }
}

function lowerNode(ctx, n) {
  switch (n.type) {
    case 'script':
    case 'script-module':
    case 'style':
    case 'template':
      return null
    case 'text':
      return lowerText(ctx, n)
    case 'comment':
      return { kind: 'comment', value: n.content }
    case 'if':
      return lowerIf(ctx, n)
    case 'each':
      return lowerEach(ctx, n)
    case 'node': {
      if (n.name === 'mesa') return unlowered(ctx, 'mesa-element', n)
      if (n.name === 'component') return unlowered(ctx, 'component', n)
      if (/^[A-Z]/.test(n.name)) return lowerComponent(ctx, n)
      if (n.name === 'slot') return lowerSlot(ctx, n)
      const { attrs, handlers, directives, styles } = lowerAttributes(ctx, n)
      return {
        kind: 'element',
        tag: n.name,
        loc: ctx.posOf(n.start),
        attrs,
        handlers,
        directives,
        styles,
        children: n.closedTag ? [] : lowerChildren(ctx, n.body ?? []),
        selfClosing: !!n.closedTag,
      }
    }
    case 'systag': {
      const tag = n.value.match(/^@([\w-]*)/)?.[1]
      return unlowered(ctx, SYSTAGS[tag] ?? 'systag', n)
    }
    case 'await':
    case 'key':
    case 'snippet':
    case 'slot':
    case 'fragment':
    case 'virtual-each':
    case 'block':
      return unlowered(ctx, n.type, n)
    default:
      return unlowered(ctx, n.type, n)
  }
}

function lowerChildren(ctx, body) {
  const out = []
  for (const n of body) {
    const ir = lowerNode(ctx, n)
    if (ir) out.push(ir)
  }
  return out
}

// ─── walking ──────────────────────────────────────────────────────────────────

/** Every node under `children`, each before its own contents, in document
 *  order: through an element's children, every arm of a block, a
 *  component's slots and a slot's fallback. */
export function eachNode(children, visit) {
  for (const n of children) {
    visit(n)
    switch (n.kind) {
      case 'element':
        eachNode(n.children, visit)
        break
      case 'if':
        for (const b of n.branches) eachNode(b.children, visit)
        if (n.else) eachNode(n.else, visit)
        break
      case 'each':
        eachNode(n.children, visit)
        if (n.else) eachNode(n.else, visit)
        break
      case 'component':
        for (const name in n.slots) eachNode(n.slots[name], visit)
        break
      case 'slot':
        eachNode(n.fallback, visit)
        break
    }
  }
}

// ─── entry ────────────────────────────────────────────────────────────────────

export function lower(ctx) {
  const patternSeq = ctx._eachPatternSeq
  const liftSeq = ctx._eachLiftSeq
  const errors = ctx.analysis?.errors
  const errorsBefore = errors?.length ?? 0
  let children
  try {
    children = lowerChildren(ctx, ctx.DOM?.body ?? [])
  } finally {
    ctx._eachPatternSeq = patternSeq
    ctx._eachLiftSeq = liftSeq
  }
  const diagnostics = errors ? errors.splice(errorsBefore) : []
  return { kind: 'root', children, diagnostics }
}
