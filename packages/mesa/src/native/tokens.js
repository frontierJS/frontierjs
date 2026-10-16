/**
 * The token graph of a flat stylesheet evaluated at build time, so no `var()`
 * on a phone is more than one hop from a literal (`IDEAS/mesa-ir.md` § 12,
 * 4.2). The device resolves `var(--a)` when `--a` holds a literal and paints
 * nothing when it holds another `var()`, when a fallback is a `var()`, or when
 * a `var()` sits inside `color-mix()` (§ 11). Every kit tone is two hops or
 * more.
 *
 * A value depends on which classes are in effect, and three kinds of class
 * set tokens. Invariant 13 is what keeps the set small enough to enumerate:
 *
 * - **A theme**, `.theme-*`, on `<html>` or on a subtree.
 * - **An inherited axis**: the single-class setters of a property registered
 *   `inherits: true`, like `.dense` and `.roomy` for `--density`.
 * - **A self axis**: the single-class setters of a property registered
 *   `inherits: false`, the tones. It is a fact about one element.
 *
 * Each custom-property definition holding a `var()` is evaluated in every
 * combination of those classes and written once per distinct literal. A
 * definition on `:root`, `*` or an axis class is placed on the outermost class
 * it depends on and reaches its readers by inheritance, which is what keeps a
 * `.roomy` inside a `.dense` right: `* { --space-sm: ... }` would give both the
 * same specificity and let sheet order decide. Anything else gains the classes
 * it depends on, as ancestors and its own tone. A use is lowered the same way
 * only where the device cannot read it: a `var()` in a fallback or inside a
 * function.
 *
 * A `var()` naming a property the sheet never sets, an app's knob like
 * `--on-bg-mix` or `--app-bg`, is unset and its fallback stands in. A knob
 * reaches a phone only when the app's sheet is lowered with the kit's: kept as
 * `var(--knob, fallback)`, the fallback would have to be a literal, and a
 * literal written per context is what breaks a `.dense` inside a `.roomy`.
 * Each knob a lowered value reads comes back on `unset`, so the loss is said.
 *
 * What the device still loses, which no static pass gives back:
 *
 * - `inherits: false` is ignored on the device, so a tone and its tints leak
 *   into an untoned child.
 * - A class written on the same element as a theme or an inherited axis,
 *   rather than below it, is read as below it, and two nested themes are
 *   ordered by the sheet.
 * - A variant gains specificity by the classes it names, so it can now beat a
 *   rule that used to beat it.
 *
 * Arithmetic is not done here: `calc()`, `color-mix()` and relative colors
 * keep their functions with literal arguments (4.3).
 */

const IDENT = /[\w-]/
const PSEUDO_ELEMENT = /:(?:before|after|first-line|first-letter)(?![\w-])|::[\w-]+/

/**
 * `{ rules, unset }`: `{ sel, line, decls: [{ prop, value, important }] } | { text }`
 * rules, in cascade order, with their tokens evaluated. `unset` is each knob a
 * lowered value read and lost, `{ what, line }`.
 */
export function lowerTokens(rules) {
  const registered = registry(rules)
  const defs = new Map()
  const rulesOf = rules.filter(r => r.sel)
  rulesOf.forEach((r, order) => {
    r.order = order
    r.spec = specificity(r.sel)
    for (const d of r.decls) if (d.prop.startsWith('--')) (defs.get(d.prop) ?? defs.set(d.prop, []).get(d.prop)).push({ rule: r, d })
  })
  const dims = axes(rulesOf, registered)
  const dimOf = new Map(dims.flatMap((dim, i) => dim.classes.map(c => [c, i])))
  const contexts = product(dims)

  // ── Computing a value in a context ───────────────────────────────────
  const kind = (sel) => sel === ':root' ? 'root' : sel === '*' ? 'star' : dimOf.has(sel) ? (dims[dimOf.get(sel)].self ? 'self' : 'inh') : 'local'
  const memo = new Map()
  const active = (ctx) => ctx.map((c, i) => c && { c, i }).filter(Boolean)

  // The ancestors and `<html>`: `:root`, the active theme and inherited axes,
  // and `*` beneath them, read as one element on which an axis nested deeper
  // wins, since `.dense` under `.theme-press` is the nearer of the two.
  function inherited(ctx) {
    const key = 'i' + ctx.join()
    if (memo.has(key)) return memo.get(key)
    const on = new Set(active(ctx).filter(a => !dims[a.i].self).map(a => a.c))
    const rank = (sel) => sel === '*' ? 0 : sel === ':root' ? 1 : 2 + dimOf.get(sel)
    const env = scope((p) => (defs.get(p) ?? []).filter(({ rule }) => rule.sel === '*' || rule.sel === ':root' || on.has(rule.sel))
      .sort((a, b) => rank(a.rule.sel) - rank(b.rule.sel) || a.rule.order - b.rule.order), () => undefined, registered, 'inh')
    memo.set(key, env)
    return env
  }

  // The element `sel` matches: `*`, its own tone, and every rule whose one
  // compound is a subset of its own; a rule matching an ancestor compound
  // sits between it and the inherited scope.
  function element(sel, ctx) {
    const key = 'e' + ctx.join() + '|' + sel
    if (memo.has(key)) return memo.get(key)
    const parts = compounds(sel)
    const own = new Set(simples(parts.at(-1)).filter(s => s !== '*'))
    for (const a of active(ctx)) if (dims[a.i].self) own.add(a.c)
    const ancestors = parts.slice(0, -1).map(c => new Set(simples(c)))
    const fits = (rule, set) => { const p = compounds(rule.sel); return p.length === 1 && simples(p[0]).every(s => s === '*' || set.has(s)) }
    const order = (a, b) => (a.d.important - b.d.important) || cmp(a.rule.spec, b.rule.spec) || a.rule.order - b.rule.order
    const parent = ancestors.reduceRight((up, set) => scope((p) => (defs.get(p) ?? []).filter(({ rule }) =>
      kind(rule.sel) === 'local' && fits(rule, set)).sort(order), up, registered, 'anc'), inherited(ctx))
    const env = scope((p) => (defs.get(p) ?? []).filter(({ rule }) => {
      const k = kind(rule.sel)
      return k === 'star' || (k === 'self' && own.has(rule.sel)) || (k === 'local' && fits(rule, own))
    }).sort(order), parent, registered, 'el')
    memo.set(key, env)
    return env
  }

  // ── Placing a value ──────────────────────────────────────────────────
  const outer = (ctx) => active(ctx).sort((a, b) => dims[a.i].self - dims[b.i].self || a.i - b.i).map(a => a.c)
  const placeGlobal = (ctx) => { const o = outer(ctx); return o.length ? o.join(' ') : ':root' }
  const placeLocal = (sel, ctx) => {
    const a = active(ctx)
    const up = a.filter(x => !dims[x.i].self && x.c !== sel).map(x => x.c)
    const self = a.filter(x => dims[x.i].self && x.c !== sel).map(x => x.c).join('')
    return [...up, self ? withClass(sel, self) : sel].join(' ')
  }
  // Nearer element first, then more classes: the cascade over the placements.
  const levelGlobal = (ctx) => { const a = active(ctx); return [a.length ? Math.max(...a.map(x => dims[x.i].self ? dims.length : x.i)) : -1, a.length] }
  const levelLocal = (ctx) => [0, active(ctx).length]

  const ambient = contexts.filter(c => c.every((x, i) => !x || !dims[i].self))
  const hoisted = new Map()
  const out = []
  const unset = []
  for (const r of rules) {
    if (!r.sel) { out.push(r); continue }
    const extra = new Map()
    const decls = []
    // One declaration written once per distinct value, in the order the
    // cascade over its placements reads them, so a context that would read
    // the same value from a broader placement is not written.
    const place = (d, ctxs, read, global) => {
      const level = global ? levelGlobal : levelLocal
      const emitted = []
      for (const ctx of ctxs.sort((a, b) => active(a).length - active(b).length)) {
        const v = read(ctx)
        const at = emitted.filter(e => e.ctx.every((x, i) => !x || x === ctx[i]))
          .sort((a, b) => cmp(level(a.ctx), level(b.ctx)) || a.n - b.n).at(-1)
        if (v === undefined || (at ? at.v === v : false)) continue
        emitted.push({ ctx, v, n: emitted.length })
        const sel = global ? placeGlobal(ctx) : placeLocal(r.sel, ctx)
        const nd = { ...d, value: v }
        if (sel === r.sel && !active(ctx).some(a => a.c !== r.sel)) decls.push(nd)
        else (extra.get(sel) ?? extra.set(sel, []).get(sel)).push(nd)
      }
    }
    const k = kind(r.sel)
    const pseudo = PSEUDO_ELEMENT.test(r.sel)
    for (const d of r.decls) {
      const custom = d.prop.startsWith('--')
      if (!d.value.includes('var(') || (!custom && !needsLowering(d.value))) { decls.push(d); continue }
      for (const [, name] of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const what = `the unset token ${name}`
        if (!defs.has(name) && !unset.some(u => u.what === what && u.line === r.line)) unset.push({ what, line: r.line })
      }
      // `*::before` repeats what `*` declares, and a phone's pseudo-element
      // inherits it from its element.
      if (custom && pseudo && simples(compounds(r.sel)[0]).every(s => s === '*' || PSEUDO_ELEMENT.test(s))
        && defs.get(d.prop).some(x => x.rule.sel === '*' && x.d.value === d.value)) continue
      if (!custom) {
        // A use that must be a literal and reads only the ambient tokens is
        // hoisted into a private token placed as `:root`'s are, and read one
        // hop away: written per context on its own selector, `.dense .x` and
        // `.roomy .x` tie, and the sheet decides a `.dense` inside a `.roomy`.
        const lit = (env) => evaluate(d.value, env)
        const values = new Set(ambient.map(ctx => lit(inherited(ctx))))
        if (values.size > 1 && contexts.every(ctx => lit(element(r.sel, ctx)) === lit(inherited(ctx)))) {
          // What is hoisted reads only the ambient tokens, so one value is one token.
          let name = hoisted.get(d.value)
          if (!name) {
            hoisted.set(d.value, name = `--_v${hoisted.size}`)
            place({ prop: name, value: '', important: false }, [...ambient], (ctx) => lit(inherited(ctx)), true)
          }
          decls.push({ ...d, value: `var(${name})` })
          continue
        }
        place(d, [...contexts], (ctx) => use(d.value, element(r.sel, ctx)), false)
        continue
      }
      const global = k === 'root' || k === 'star' || k === 'inh'
      const fixed = dimOf.has(r.sel) ? dimOf.get(r.sel) : -1
      const ctxs = contexts.filter(c => (fixed < 0 || c[fixed] === r.sel) && (!global || k === 'star' || c.every((x, i) => !x || !dims[i].self)))
      place(d, ctxs, (ctx) => (k === 'root' || k === 'inh' ? inherited(ctx) : element(r.sel, ctx)).eval(d), global)
    }
    if (decls.length || !r.decls.length) out.push({ ...r, decls })
    for (const [sel, ds] of extra) out.push({ ...r, sel, decls: ds })
  }
  return { rules: out, unset }
}

/** A scope: each property's computed value, or undefined when it is unset or invalid. */
function scope(candidates, parent, registered, tag) {
  const memo = new Map()
  const resolving = new Set()
  const self = {
    get(p) {
      if (memo.has(p)) return memo.get(p)
      if (resolving.has(p)) return undefined
      const list = candidates(p)
      let v
      if (list.length) {
        resolving.add(p)
        v = evaluate(list.at(-1).d.value, (q) => self.get(q))
        resolving.delete(p)
      } else {
        const reg = registered.get(p)
        v = reg && !reg.inherits ? reg.initial : parent(p) ?? (tag === 'inh' ? reg?.initial : undefined)
      }
      memo.set(p, v)
      return v
    },
    eval(d) { return evaluate(d.value, (q) => self.get(q)) },
  }
  const fn = (p) => self.get(p)
  fn.get = self.get
  fn.eval = self.eval
  return fn
}

/** `raw` with every `var()` replaced, or undefined when one has no value and no fallback. */
function evaluate(raw, get) {
  const v = rewriteVars(raw, (name, fallback) => get(name) ?? (fallback === undefined ? undefined : evaluate(fallback, get)))
  if (v === undefined) return undefined
  const t = v.trim()
  return t === 'initial' ? undefined : t
}

/**
 * A normal declaration's value for the device. At the top level a `var()`
 * stays one hop wherever its token is set, since every definition is a
 * literal by now, which keeps a use from being written once per theme and
 * leaves density to inheritance; where the token is unset its fallback is
 * taken. Inside a function every `var()` is evaluated.
 */
function use(raw, env, inFn = false) {
  const v = rewriteVars(raw, (name, fallback, nested) => {
    const fn = inFn || nested
    const got = env.get(name)
    if (got !== undefined) return fn ? got : `var(${name})`
    return fallback === undefined ? undefined : use(fallback, env, fn)
  })
  return v?.trim()
}

/** What the device cannot read: a `var()` in a fallback, or inside a function. */
function needsLowering(raw) {
  let bad = false
  rewriteVars(raw, (name, fallback, inFn) => { if (inFn || fallback?.includes('var(')) bad = true; return '' })
  return bad
}

/** `v` with each `var(name[, fallback])` replaced by `visit(name, fallback, inFn)`; undefined if a visit is. */
function rewriteVars(v, visit) {
  let out = '', depth = 0
  for (let i = 0; i < v.length;) {
    const c = v[i]
    if (c === '"' || c === "'") { const j = v.indexOf(c, i + 1); const e = j < 0 ? v.length : j + 1; out += v.slice(i, e); i = e; continue }
    if (v.startsWith('var(', i) && !IDENT.test(v[i - 1] ?? '')) {
      const j = close(v, i + 3)
      const inner = v.slice(i + 4, j)
      const k = topComma(inner)
      const r = visit((k < 0 ? inner : inner.slice(0, k)).trim(), k < 0 ? undefined : inner.slice(k + 1), depth > 0)
      if (r === undefined) return undefined
      out += r
      i = j + 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth--
    out += c
    i++
  }
  return out
}

function close(s, open) {
  for (let i = open, depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length
}

function topComma(s) {
  for (let i = 0, depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) return i
  }
  return -1
}

/** `@property` rules as `name → { inherits, initial }`. */
function registry(rules) {
  const out = new Map()
  for (const r of rules) {
    const m = r.text?.match(/^@property\s+(--[\w-]+)\s*\{([^}]*)\}/)
    if (!m) continue
    const desc = Object.fromEntries(m[2].split(';').map(s => s.split(':').map(x => x.trim())).filter(([k]) => k))
    out.set(m[1], { inherits: desc.inherits !== 'false', initial: desc['initial-value'] })
  }
  return out
}

/** The classes that set tokens: themes, then one group per registered property its single-class setters share. */
function axes(rules, registered) {
  const single = /^\.[\w-]+$/
  const setters = rules.filter(r => single.test(r.sel) && r.decls.some(d => d.prop.startsWith('--')))
  const taken = new Set()
  const dims = []
  const themes = [...new Set(setters.filter(r => r.sel.startsWith('.theme-')).map(r => r.sel))]
  themes.forEach(c => taken.add(c))
  if (themes.length) dims.push({ classes: themes, self: false })
  for (const [prop, reg] of registered) {
    const classes = [...new Set(setters.filter(r => !taken.has(r.sel) && r.decls.some(d => d.prop === prop)).map(r => r.sel))]
    if (!classes.length) continue
    classes.forEach(c => taken.add(c))
    dims.push({ classes, self: !reg.inherits })
  }
  return dims
}

/** Every combination of at most one class per axis, null for none. */
function product(dims) {
  return dims.reduce((acc, dim) => acc.flatMap(ctx => [null, ...dim.classes].map(c => [...ctx, c])), [[]])
}

/** `sel` split at its combinators. */
function compounds(sel) {
  const out = []
  let cur = '', depth = 0
  for (const c of sel) {
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    if (depth === 0 && /[\s>+~]/.test(c)) { if (cur) out.push(cur); cur = '' }
    else cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** One compound's simple selectors: `.btn.outlined:hover` is three. */
function simples(compound) {
  const out = []
  let cur = '', depth = 0
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i]
    if (depth === 0 && (c === '.' || c === '#' || c === '[' || (c === ':' && compound[i - 1] !== ':')) && cur) { out.push(cur); cur = '' }
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** `cls` added to the last compound of `sel`, ahead of a pseudo-element. */
function withClass(sel, cls) {
  const parts = compounds(sel)
  const last = parts.at(-1)
  const m = last.match(PSEUDO_ELEMENT)
  let head = m ? last.slice(0, m.index) : last
  const tail = m ? last.slice(m.index) : ''
  if (head === '*' || head === '') head = ''
  const at = sel.lastIndexOf(last)
  return sel.slice(0, at) + head + cls + tail
}

/** `[ids, classes, types]`, `:is()` and its kin counted as one class. */
function specificity(sel) {
  const s = [0, 0, 0]
  for (const c of compounds(sel)) for (const x of simples(c)) {
    if (x[0] === '#') s[0]++
    else if (x[0] === '.' || x[0] === '[' || (x[0] === ':' && x[1] !== ':' && !PSEUDO_ELEMENT.test(x))) s[1]++
    else if (x !== '*') s[2]++
  }
  return s
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
