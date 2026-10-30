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
  rewriteExpr, rewriteTextResult, extractKeywords, eventAttribute, applyEventModifiers,
  unwrapExp, parseEachHeader, eachFrame, templateSource, componentAttributes, styleSource, classSource,
  bindSetter, elementBindTarget, snippetParam, parseRenderTag, constScope, constDeclaration, boundaryWatchSet,
  withoutWatchedCalls, withAwaitParam, fieldRead, LOC_ATTR,
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
  'bind:', 'use:', 'transition:', 'in:', 'out:', 'animate:', 'client:',
]

function styleValue(ctx, p, prop) {
  const src = styleSource(p, prop)
  return src.template ? interpolated(ctx, src.raw) : read(ctx, src.raw)
}

/** An element's attributes by what each is. `ref` is `bind:this`'s setter
 *  and `attachments` the `{@attach}` expressions, both handed the target's own
 *  node — a DOM element or a terminal renderable. An attachment may write
 *  state through a callback in its options, so it is lowered as a write.
 *  `binds` holds a plain `bind:value` or `bind:checked`, `{ name, getter,
 *  setter }` from `elementBindTarget`, and a `bind:group` on a top-level `let`
 *  with `value`, its element's `value` attribute as written; any other element
 *  `bind:`, and one with a modifier, stays a directive for a target to refuse
 *  by name. */
function lowerAttributes(ctx, n) {
  const attrs = [], handlers = [], directives = [], styles = [], classes = [], attachments = [], binds = []
  let ref = null
  for (const p of n.attributes) {
    const name = p.name
    const loc = ctx.posOf(p.start ?? n.start)
    // The source offset, so a target can order attributes, `class:` and
    // `style:` together as they were written.
    const at = p.start ?? n.start
    const raw = p.content ?? p.raw ?? name
    if (p.type === 'attach' || name === '@attach') { attachments.push({ expr: write(ctx, p.value), loc }); continue }
    // `{...spread}`, `{*raw}` and `*{raw}` carry their whole text as the name.
    // A spread stays among the attributes because their order is the order
    // the DOM path applies them in, and a later one wins.
    if (name.startsWith('{...') && name.endsWith('}')) {
      attrs.push({ name, value: { kind: 'spread', expr: read(ctx, name.slice(4, -1)) }, at })
      continue
    }
    if (name[0] === '{' || name.startsWith('*{')) { directives.push({ name, raw, loc }); continue }
    const on = eventAttribute(name)
    if (on) {
      const { event, modifiers } = on
      const rawHand = p.value ? unwrapExp(p.value) : '() => {}'
      const code = applyEventModifiers(ctx, modifiers, event, write(ctx, rawHand).code).handler
      handlers.push({ event, modifiers, expr: expr(ctx, rawHand, code), loc })
      continue
    }
    if (name === 'bind:this') {
      ref = bindSetter(ctx, { kind: 'bind-this', target: p.value ? unwrapExp(p.value) : null }, '')
      continue
    }
    if (name.startsWith('style:')) {
      const prop = name.slice(6)
      styles.push({ prop, expr: styleValue(ctx, p, prop), loc, at })
      continue
    }
    if (name.startsWith('class:')) {
      const cls = name.slice(6)
      classes.push({ name: cls, expr: read(ctx, classSource(p, cls)), loc, at })
      continue
    }
    if (name === 'bind:value' || name === ':value' || name === 'bind:checked' || name === ':checked') {
      const prop = name.endsWith('checked') ? 'checked' : 'value'
      const target = elementBindTarget(ctx, prop, p.value ? unwrapExp(p.value) : prop)
      if (target) binds.push({ name: prop, ...target, loc })
      continue
    }
    // The DOM path takes only a top-level `let` here; anything else stays a
    // directive, refused by name rather than bound on one target alone.
    if (name === 'bind:group') {
      const v = p.value ? unwrapExp(p.value) : null
      if (v && ctx.setters?.[v] && ctx.accessors?.[v]) {
        binds.push({ name: 'group', getter: `() => (${ctx.accessors[v]})`, setter: ctx.setters[v], loc })
        continue
      }
    }
    if (name === 'this' || name[0] === ':' || DIRECTIVE_PREFIXES.some((pre) => name.startsWith(pre))) {
      directives.push({ name, raw, loc })
      continue
    }
    if (p.type === 'exp') {
      attrs.push({ name, value: { kind: 'binding', expr: read(ctx, unwrapExp(p.value)), to: 'attr' }, at })
      continue
    }
    if (p.type === 'text' && p.value.includes('{')) {
      attrs.push({ name, value: { kind: 'binding', expr: interpolated(ctx, p.value), to: 'attr' }, at })
      continue
    }
    if (name === LOC_ATTR) {
      const done = ctx.locIn(p.value)
      if (done) attrs.push({ name, value: done, at })
      continue
    }
    attrs.push({ name, value: p.type === 'attribute' ? true : p.value, at })
  }
  // A group bind reads its element's value each time, the DOM path's `getVal`.
  for (const b of binds) if (b.name === 'group') b.value = attrs.find((a) => a.name === 'value')?.value ?? null
  return { attrs, handlers, directives, styles, classes, ref, attachments, binds }
}

// ─── components ───────────────────────────────────────────────────────────────

/**
 * `<Child …>`: the call `makeComponent` emits on the DOM path, as data, read
 * off `componentAttributes` — the one answer to what each attribute is. A
 * prop is `{ name, value }` where `value` is `true` (a bare attribute), a
 * string, or a binding; a spread is a read. `bind:name={x}` is both halves
 * the DOM path wires: a live prop reading `x` down, and a `binds` entry whose
 * `setter` takes the child's changes back up. `ref` is `bind:this`'s setter,
 * handed the child's exported interface. A bind with no setter to call is
 * reported and dropped (`bindSetter`). An attribute
 * `componentAttributes` refuses is reported, as the DOM path reports it, and
 * passes nothing on either target. `client:` is a hint to a
 * server render: `island` is `{ directive, media? }`, and a target reads it
 * only under `root.islands`, as the DOM path drops it without `islands`.
 *
 * `snippets` are its children: every child of a call is a snippet by now,
 * `slot=` and unslotted content included (`lowerSlots`, `FJS-D668`), which
 * the target names and passes as the prop of its name.
 */
function lowerComponent(ctx, n) {
  const props = [], spreads = [], binds = []
  let ref = null, island = null
  const at = ctx.posOf(n.start)
  for (const a of componentAttributes(n)) {
    const p = a.attr
    switch (a.kind) {
      case 'refused':
        ctx.analysis?.errors.push(`${a.message} — ${at}`)
        break
      case 'island': {
        island = { directive: a.name.slice('client:'.length) }
        if (island.directive === 'media' && p.value) island.media = String(p.value).replace(/^["']|["']$/g, '')
        break
      }
      case 'spread':
        spreads.push(read(ctx, a.expr))
        break
      case 'bind': {
        const setter = bindSetter(ctx, a, ` — ${at}`)
        if (!setter) break
        props.push({ name: a.name, value: { kind: 'binding', expr: read(ctx, a.target), to: 'prop' } })
        binds.push({ name: a.name, setter })
        break
      }
      case 'bind-this':
        ref = bindSetter(ctx, a, ` — ${at}`)
        break
      case 'prop': {
        let value
        if (a.modifiers) {
          const rawHand = unwrapExp(p.raw ?? p.value)
          const code = applyEventModifiers(ctx, a.modifiers, a.event, write(ctx, rawHand).code).handler
          value = { kind: 'binding', expr: expr(ctx, rawHand, code), to: 'prop' }
        } else if (p.value === undefined) value = true
        else if (p.type === 'exp') value = { kind: 'binding', expr: write(ctx, unwrapExp(p.raw)), to: 'prop' }
        else if (p.value.includes('{')) value = { kind: 'binding', expr: interpolated(ctx, p.value), to: 'prop' }
        else value = p.value
        props.push({ name: a.name, value })
        break
      }
    }
  }

  const snippets = (n.body ?? []).filter((c) => c.type === 'snippet').map((s) => lowerSnippet(ctx, s))

  const accessor = ctx.accessors?.[n.name]
  return {
    kind: 'component',
    name: n.name,
    call: accessor && accessor !== n.name ? accessor : n.name,
    loc: ctx.posOf(n.start),
    props,
    spreads,
    binds,
    ref,
    island,
    snippets,
  }
}

// ─── snippets ─────────────────────────────────────────────────────────────────

/**
 * `{#snippet name(args)}`: a function of an anchor and one GETTER per
 * argument, as `makeSnippet` builds it — inside the body each parameter reads
 * through its getter, so the accessors are shadowed for the body and put back.
 * `params` are the names the function takes. A snippet in a body is called
 * `$$snippet_<name>`, the name an expression or a `{@render}` reaches it by;
 * one passed to a component has no `varName`, and the target names it.
 */
function lowerSnippet(ctx, s, varName = null) {
  const params = s.rawArgs ? splitParams(s.rawArgs).map((a, i) => snippetParam(a, i, s.name)) : []
  const saved = {}
  if (ctx.accessors) {
    for (const p of params) for (const [bound, read] of Object.entries(p.reads)) {
      saved[bound] = ctx.accessors[bound]
      ctx.accessors[bound] = read
    }
  }
  let children
  try { children = lowerChildren(ctx, s.body) } finally {
    for (const bound of Object.keys(saved)) {
      if (saved[bound] === undefined) delete ctx.accessors[bound]
      else ctx.accessors[bound] = saved[bound]
    }
  }
  return { kind: 'snippet', name: s.name, varName, params: params.map((p) => p.param), loc: ctx.posOf(s.start), children }
}

function splitParams(raw) {
  // `snippetParam` takes one declared parameter; the list splits at top-level
  // commas exactly as a render's arguments do.
  return parseRenderTag(`@render f(${raw})`).args
}

/**
 * `{@render x(args)}`, resolved the way `makeRenderTag` resolves it: a snippet
 * declared in an enclosing body is called directly; a variable holding one is
 * read once and called, guarded when the call is optional-chained; any other
 * name is `$$snippet_<name>`, guarded. Each argument is handed over as a
 * getter, so `args` are reads the target wraps.
 */
function lowerRender(ctx, n) {
  const r = parseRenderTag(n.value)
  const local = ctx._irSnippets?.has(r.name)
  const accessor = !local && ctx.accessors?.[r.name]
  let callee, guard
  if (local) { callee = `$$snippet_${r.name}`; guard = false }
  else if (accessor) { callee = accessor; guard = r.optional }
  else { callee = `$$snippet_${r.name}`; guard = true }
  return {
    kind: 'render',
    loc: ctx.posOf(n.start),
    callee: expr(ctx, r.name, callee),
    guard,
    args: r.args.map((a) => read(ctx, a)),
  }
}

// ─── nodes ────────────────────────────────────────────────────────────────────

const SYSTAGS = { render: 'render', html: 'html', const: 'const', debug: 'debug' }

function unlowered(ctx, what, node) {
  return { kind: 'unlowered', what, loc: ctx.posOf(node.start), node }
}

/** `{@const}`: `lines` are the statements that declare it, the DOM path's
 *  own, and its names read through them until the block closes. A malformed
 *  one is reported and lowers to nothing, as it emits nothing on the DOM. */
function lowerConst(ctx, n) {
  const decl = constDeclaration(ctx, n.value)
  if (decl.error) { ctx.analysis?.errors.push(decl.error); return null }
  return { kind: 'const', loc: ctx.posOf(n.start), names: decl.names, value: expr(ctx, decl.value, decl.code), lines: decl.lines }
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

/** `{#key}`: its children are rebuilt whenever `key` reads a different
 *  value (`===`), the DOM path's rule. */
function lowerKey(ctx, n) {
  const rx = n.value.match(/^#key\s+(.+)$/s)
  return { kind: 'key', loc: ctx.posOf(n.start), key: read(ctx, rx?.[1]?.trim() ?? ''), children: lowerChildren(ctx, n.body) }
}

/**
 * `{#await}`, read as `makeAwaitBlock` reads it: the expression without the
 * watched-call rewrite, a branch with no body is null, and `{:then v}` /
 * `{:catch e}` bind a plain value, a pattern kept in the parameter list.
 */
function lowerAwait(ctx, n) {
  const raw = n.value.match(/^#await\s+(.+)$/s)?.[1]?.trim() ?? ''
  const value = expr(ctx, raw, ctx.accessors ? rewriteExpr(raw, withoutWatchedCalls(ctx.accessors)) : raw)
  const branch = (body, header) => {
    if (!body?.length) return null
    const param = header?.match(/^:(?:then|catch)\s*(.*)/s)?.[1]?.trim() || null
    return { param, children: withAwaitParam(ctx, param, () => lowerChildren(ctx, body)) }
  }
  return {
    kind: 'await',
    loc: ctx.posOf(n.start),
    value,
    pending: n.parts.main?.length ? lowerChildren(ctx, n.parts.main) : null,
    then: branch(n.parts.then, n.parts.thenValue),
    catch: branch(n.parts.catch, n.parts.catchValue),
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
    // A row's `x === outer` is read through `$$selN(x)`, which the target
    // declares beside the block as the DOM path does: `[outer code, name]`.
    lifts: frame.lift ? [...frame.lift.names] : [],
    children,
    else: n.elseBlock ? lowerChildren(ctx, n.elseBlock) : null,
  }
}

/**
 * `<mesa:element this={tag}>`: an element whose tag is a read. Its `this`
 * leaves the directives, since it is the tag; everything else is an element's.
 */
function lowerDynamicElement(ctx, n) {
  const at = n.attributes.find((a) => a.name === 'this')
  const lowered = lowerAttributes(ctx, n)
  const tag = !at ? null : at.type === 'exp' ? read(ctx, unwrapExp(at.value)) : expr(ctx, at.value, JSON.stringify(at.value))
  return {
    kind: 'dynamic-element',
    tag,
    loc: ctx.posOf(n.start),
    ...lowered,
    ...stampOf(ctx, n),
    directives: lowered.directives.filter((d) => d.name !== 'this'),
    children: n.closedTag ? [] : lowerChildren(ctx, n.body ?? []),
  }
}

/**
 * `<mesa:window|document|body>`: listeners on a target outside the
 * component, as an element's attributes. It has no children — the DOM path
 * reports any it is given — so none are lowered.
 */
function lowerGlobal(ctx, n) {
  return { kind: 'global', target: n.elArg, loc: ctx.posOf(n.start), ...lowerAttributes(ctx, n) }
}

const GLOBALS = ['window', 'document', 'body']

/**
 * `<mesa:portal to={node}>`: children built where they are written and placed
 * in another node. `to` is null when unwritten, which the DOM reads as the
 * body; a target with one surface has no other node to name.
 */
function lowerPortal(ctx, n) {
  const to = n.attributes.find((a) => a.name === 'to')
  return {
    kind: 'portal',
    to: to?.value ? read(ctx, unwrapExp(to.value)) : null,
    loc: ctx.posOf(n.start),
    children: n.closedTag ? [] : lowerChildren(ctx, n.body ?? []),
  }
}

/**
 * `<mesa:boundary>`: `states` are the `$$async_` state objects the body reads
 * (`boundaryWatchSet`, `FJS-D378`), and `pending` / `failed` the snippet
 * variable each branch calls, a local one first and the component's global
 * one behind it (RULE 40), or null when neither is written. The local
 * snippets stay in `children`, so a target emits them where it emits the
 * body.
 */
function lowerBoundary(ctx, n) {
  const body = n.body ?? []
  const asyncVars = Object.values(ctx.analysis?.vars ?? {}).filter((v) => v.isAsync)
  const has = (list, name) => (list ?? []).some((c) => c.type === 'snippet' && c.name === name)
  const snippet = (name) => (has(body, name) || has(ctx.DOM?.body, name) ? `$$snippet_${name}` : null)
  return {
    kind: 'boundary',
    loc: ctx.posOf(n.start),
    states: boundaryWatchSet(asyncVars, body).map((v) => `$$async_${v.name}`),
    pending: snippet('pending'),
    failed: snippet('failed'),
    children: lowerChildren(ctx, body),
  }
}

/**
 * `<mesa:head>`: children for the document's head. A `<style>` child is the
 * sheet's text as written -- the DOM path injects it raw, past the scoper --
 * and every other child lowers as markup.
 */
function lowerHead(ctx, n) {
  const body = n.body ?? []
  return {
    kind: 'head',
    loc: ctx.posOf(n.start),
    styles: body.filter((c) => c.type === 'style').map((c) => (c.content ?? '').trim()).filter(Boolean),
    children: lowerChildren(ctx, body.filter((c) => c.type !== 'style')),
  }
}

/**
 * A dev build's `data-fjs-loc`, as the DOM builder writes it: the element's
 * own line as `stamp.at`, and as `stamp.read` the field it shows, whose
 * recorded line wins at render (`FJS-D1231`). An element out of Markdown
 * carries its own, completed in `lowerAttributes`.
 */
function stampOf(ctx, n) {
  if (n.attributes.some((a) => a.name === LOC_ATTR)) return {}
  const at = ctx.locOf(n.start)
  return at ? { stamp: { at, read: fieldRead(n, ctx) } } : {}
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
      if (n.name === 'mesa' && n.elArg === 'element') return lowerDynamicElement(ctx, n)
      if (n.name === 'mesa' && GLOBALS.includes(n.elArg)) return lowerGlobal(ctx, n)
      if (n.name === 'mesa' && n.elArg === 'portal') return lowerPortal(ctx, n)
      if (n.name === 'mesa' && n.elArg === 'boundary') return lowerBoundary(ctx, n)
      if (n.name === 'mesa' && n.elArg === 'head') return lowerHead(ctx, n)
      if (n.name === 'mesa') return unlowered(ctx, 'mesa-element', n)
      if (n.name === 'component') return unlowered(ctx, 'component', n)
      if (/^[A-Z]/.test(n.name)) return lowerComponent(ctx, n)
      return {
        kind: 'element',
        tag: n.name,
        loc: ctx.posOf(n.start),
        ...lowerAttributes(ctx, n),
        ...stampOf(ctx, n),
        children: n.closedTag ? [] : lowerChildren(ctx, n.body ?? [], false),
        selfClosing: !!n.closedTag,
      }
    }
    case 'systag': {
      const tag = n.value.match(/^@([\w-]*)/)?.[1]
      if (tag === 'render') return lowerRender(ctx, n)
      if (tag === 'const') return lowerConst(ctx, n)
      if (tag === 'html') return { kind: 'html', loc: ctx.posOf(n.start), value: read(ctx, n.value.slice('@html'.length).trim()) }
      return unlowered(ctx, SYSTAGS[tag] ?? 'systag', n)
    }
    case 'snippet':
      return lowerSnippet(ctx, n, `$$snippet_${n.name}`)
    case 'key':
      return lowerKey(ctx, n)
    case 'await':
      return lowerAwait(ctx, n)
    case 'fragment':
    case 'virtual-each':
    case 'block':
      return unlowered(ctx, n.type, n)
    default:
      return unlowered(ctx, n.type, n)
  }
}

/**
 * A body's snippets are in scope for the whole body, before and after where
 * they are written, and for everything inside it: an expression names one
 * through its accessor, which a prop or a variable of the same name keeps,
 * and a `{@render}` finds it in `_irSnippets`. Both are put back on the way
 * out, so a sibling body does not see them.
 *
 * A `{@const}` lives to the end of its BLOCK, the function a target builds
 * the body in, and an element's children are built in its parent's: so an
 * element passes `block` false and its consts close with the enclosing body.
 */
function lowerChildren(ctx, body, block = true) {
  const closeConsts = block ? constScope(ctx) : null
  const names = body.filter((n) => n.type === 'snippet').map((n) => n.name)
  const outer = ctx._irSnippets
  const claimed = []
  if (names.length) {
    ctx._irSnippets = new Set([...(outer ?? []), ...names])
    for (const name of names) {
      if (ctx.accessors && ctx.accessors[name] === undefined) {
        ctx.accessors[name] = `$$snippet_${name}`
        claimed.push(name)
      }
    }
  }
  const out = []
  try {
    for (const n of body) {
      const ir = lowerNode(ctx, n)
      if (ir) out.push(ir)
    }
  } finally {
    if (names.length) {
      ctx._irSnippets = outer
      for (const name of claimed) delete ctx.accessors[name]
    }
    closeConsts?.()
  }
  return out
}

// ─── walking ──────────────────────────────────────────────────────────────────

/** Every node under `children`, each before its own contents, in document
 *  order: through an element's children, every arm of a block, a
 *  component's snippets and a snippet's body.
 *  A visit answering `false` skips that node's contents. */
export function eachNode(children, visit) {
  for (const n of children) {
    if (visit(n) === false) continue
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
      case 'dynamic-element':
      case 'snippet':
      case 'portal':
      case 'boundary':
      case 'head':
      case 'key':
        eachNode(n.children, visit)
        break
      case 'await':
        for (const b of [n.pending, n.then?.children, n.catch?.children]) if (b) eachNode(b, visit)
        break
      case 'component':
        eachNode(n.snippets, visit)
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
    delete ctx._irSnippets
  }
  const diagnostics = errors ? errors.splice(errorsBefore) : []
  const root = { kind: 'root', children, diagnostics, islands: !!ctx.config?.islands }
  if (ctx.styleNodes?.length) root.styles = lowerStyles(ctx)
  return root
}

// ─── styles ───────────────────────────────────────────────────────────────────

// Whose blocks hold no selectors: `from` and `50%` in a `@keyframes` are not
// rules a target could refuse.
const OPAQUE_AT = /^@(?:-\w+-)?(?:keyframes|font-face|property|counter-style|font-palette-values|page)\b/i

/**
 * The `<style>` blocks as the preludes they open, `{ prelude, loc }` in
 * source order, with `scope`, the class every element of the component
 * carries. A target that paints CSS judges each prelude as written —
 * `:global(...)` included, since a global rule paints on the same engine —
 * and the scoped text itself is `ctx.css.result`.
 */
function lowerStyles(ctx) {
  const rules = []
  for (const n of ctx.styleNodes) {
    const src = n.content
    const base = n.start + n.openTag.length
    let from = 0
    let opaque = 0
    let depth = 0
    for (let i = 0; i < src.length; i++) {
      const c = src[i]
      if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue }
      if (c === '"' || c === "'") { while (++i < src.length && src[i] !== c) if (src[i] === '\\') i++; continue }
      if (c === ';' || c === '}') {
        if (c === '}' && --depth < opaque) opaque = 0
        from = i + 1
        continue
      }
      if (c !== '{') continue
      depth++
      const raw = src.slice(from, i)
      const prelude = raw.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      const lead = raw.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0].length
      if (!opaque && prelude) rules.push({ prelude, loc: ctx.posOf(base + from + lead) })
      if (!opaque && OPAQUE_AT.test(prelude)) opaque = depth
      from = i + 1
    }
  }
  return { scope: ctx.css.id, rules }
}
