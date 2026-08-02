/**
 * @frontierjs/mesa-compiler  v0.1.0
 *
 * Sections
 *   1.  Utils            — assert, Q, isSimpleName, toCamelCase, genId,
 *                          rewriteExpr, rewriteTextResult, rewriteAssignments
 *   2.  xNode IR         — code-generation node graph
 *   3.  Parser           — HTML/template parser
 *   4.  Analyzer         — let/const/var/export classifier + $: label dispatch
 *   5.  CSS              — scoped style processing
 *   6.  Builder          — DOM tree → xNode IR
 *   7.  Parts            — #if, #each, #await, slot, component, prop binding
 *   8.  Emitter          — analysis results → signal/memo/effect xNode emissions
 *   9.  Compiler         — top-level compile() pipeline
 *   10. Plugin hooks     — vite/rollup integration helpers
 */

import * as acorn from 'acorn'
import * as astring from 'astring'

// ─── 1. UTILS ─────────────────────────────────────────────────────────────────

// Events that do not bubble and therefore cannot be delegated to a root listener.
// All other events (click, input, change, keydown, mousedown, etc.) are delegated.
const NON_DELEGATED_EVENTS = new Set([
  'focus', 'blur', 'scroll', 'resize',
  'abort', 'error', 'load', 'unload', 'beforeunload',
  'mouseenter', 'mouseleave', 'pointerenter', 'pointerleave',
])

export function assert(condition, msg) {
  if (condition) return
  throw new Error(msg || 'AssertionError')
}

export function Q(s, inlineTemplate) {
  if (inlineTemplate)
    return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\n/g, '\\n')
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
}

export function last(a) {
  return a[a.length - 1]
}

export function isSimpleName(name) {
  if (!name) return false
  if (!name.match(/^([a-zA-Z$_][\w\d$_.]*)$/)) return false
  if (name[name.length - 1] === '.') return false
  return true
}

export function toCamelCase(name) {
  assert(last(name) !== '-', 'Wrong name: ' + name)
  return name.replace(/(.)-([\w])/g, (_, pre, ch) => pre + ch.toUpperCase())
}

/**
 * Parse modifier chain from an attribute name.
 * `on:click|preventDefault|debounce(300)` →
 *   { directive: 'on:click', modifiers: [{ name: 'preventDefault' }, { name: 'debounce', arg: '300' }] }
 *
 * Modifier args can be reactive expressions: `debounce({delay})` → arg: '{delay}'.
 * The `|` split respects nested parentheses so `debounce(fn(x))` parses correctly.
 */
export function parseModifiers(fullName) {
  // Split on | outside of parens
  const parts = []
  let cur = '', depth = 0
  for (const ch of fullName) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === '|' && depth === 0) { parts.push(cur); cur = '' }
    else cur += ch
  }
  parts.push(cur)

  const directive = parts[0]
  const modifiers = parts.slice(1).map((m) => {
    const pi = m.indexOf('(')
    if (pi === -1) return { name: m }
    return { name: m.slice(0, pi), arg: m.slice(pi + 1, -1).trim() }
  })
  return { directive, modifiers }
}

export function unwrapExp(e) {
  assert(e, 'Empty expression')
  const rx = e.match(/^\{(.*)\}$/s)
  assert(rx, 'Wrong expression: ' + e)
  return rx[1]
}

export function trimEmptyNodes(nodes) {
  nodes = nodes.slice()
  while (nodes.length && nodes[0].type === 'text' && !nodes[0].value.trim()) nodes.shift()
  while (nodes.length && last(nodes).type === 'text' && !last(nodes).value.trim()) nodes.pop()
  return nodes
}

export const isNumber = (v) =>
  typeof v === 'number' || (v && typeof v === 'string' && !isNaN(v))
export const isObject = (d) => d !== null && typeof d === 'object'

let _genIdCounter = 0
export const genId = () =>
  'm' + (Date.now().toString(36) + (++_genIdCounter).toString(36)).slice(-8)

const svgElementList =
  'animate,animateMotion,animateTransform,circle,clipPath,defs,desc,ellipse,feBlend,feColorMatrix,feComponentTransfer,feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,feDistantLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,g,hatch,hatchpath,image,line,linearGradient,marker,mask,mpath,path,pattern,polygon,polyline,radialGradient,rect,set,stop,switch,symbol,text,textPath,tspan,use,view'
export const svgElements = Object.fromEntries(svgElementList.split(',').map((k) => [k, true]))

export function replaceKeyword(exp, fn, fullParse) {
  let changed = false
  const r = parseJS(exp, fullParse).transform((n, pk) => {
    if (n.type !== 'Identifier') return
    if (pk === 'property' || pk === 'params') return
    const name = fn(n.name)
    if (name) {
      n.name = name
      changed = true
    }
  })
  return changed ? r.build() : exp
}

export function detectExpressionType(name) {
  if (isSimpleName(name)) return 'identifier'
  const ast = acorn.parse(name, { allowReturnOutsideFunction: true, ecmaVersion: 'latest' })
  const body = ast.body
  if (body.length !== 1 || body[0].type !== 'ExpressionStatement') return undefined
  const obj = body[0].expression
  if (obj.type === 'Identifier' || obj.type === 'MemberExpression') return 'identifier'
  if (obj.type === 'ArrowFunctionExpression') return 'function'
  if (obj.type === 'CallExpression') return { type: 'function-call', name: obj.callee?.name }
  return undefined
}

export function parseJS(exp, fullParse) {
  const self = {}
  if (fullParse === true) self.ast = acorn.parse(exp, { ecmaVersion: 'latest' })
  else self.ast = acorn.parseExpressionAt(exp, 0, { ecmaVersion: 'latest' })

  const parents = new WeakMap()
  self.transform = function (fn) {
    const rec = (n, pk, parent) => {
      if (!n || typeof n !== 'object') return
      if (n.type) {
        parents.set(n, parent)
        fn?.(n, pk)
      }
      for (const k in n) {
        if (k === 'start' || k === 'end' || k === 'type') continue
        const v = n[k]
        if (!v || typeof v !== 'object') continue
        if (Array.isArray(v)) v.forEach((i) => rec(i, k, n))
        else rec(v, k, n)
      }
    }
    rec(self.ast, null, null)
    return self
  }
  self.getParent = (n) => parents.get(n)
  self.build = (data) => astring.generate(data || self.ast, { indent: '', lineEnd: '' })
  return self
}

export function extractKeywords(exp) {
  const ast = acorn.parse(exp, { sourceType: 'module', ecmaVersion: 'latest' })
  const keys = new Set()
  const parents = new WeakMap()
  const rec = (n, parent) => {
    if (!n || typeof n !== 'object') return
    if (n.type) {
      parents.set(n, parent)
      if (n.type === 'Identifier') {
        const p = parents.get(n)
        if (!(p?.type === 'MemberExpression' && p.property === n)) {
          let name = [n.name]
          let i = p
          while (i?.type === 'MemberExpression') {
            if (i.property.type === 'Identifier') name.push('.' + i.property.name)
            else if (i.property.type === 'Literal') name.push(`[${i.property.raw}]`)
            i = parents.get(i)
          }
          keys.add(name.join(''))
        }
      }
    }
    for (const k in n) {
      const v = n[k]
      if (!v || typeof v !== 'object') continue
      if (Array.isArray(v)) v.forEach((i) => rec(i, n))
      else rec(v, n)
    }
  }
  rec(ast, null)
  return [...keys]
}

export function htmlEntitiesToText(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&#47;/g, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
}

export function checkRootName(name, script, warning) {
  const rx = name.match(/^([\w$_][\w\d$_]*)/)
  if (!rx) return warning({ message: 'Error name: ' + name })
  const root = rx[1]
  if (script.rootVariables[root] || script.rootFunctions[root]) return true
  warning({ message: 'No name: ' + name })
}

// ─── EXPRESSION / ASSIGNMENT REWRITERS ───────────────────────────────────────
//
// These are the core mechanism that makes compiled template expressions and
// script-body assignments correctly route through signal getters / setters.

/**
 * Rewrite identifier references in a JS expression string.
 *
 * accessorMap: { varName: accessorExpr }
 *   e.g. { count: '$$sig_count()', user: '$$proxy_user', double: 'double()' }
 *
 * Works at source level using position patches so call-suffix rewrites like
 * 'count' → '$$sig_count()' are emitted correctly without AST mutation.
 *
 * @param {string} expr        JS expression or statement source string.
 * @param {object} accessorMap
 * @returns {string}
 */
export function rewriteExpr(expr, accessorMap, setterMap) {
  if (!accessorMap || !expr) return expr

  const rewrites = {}
  for (const [name, acc] of Object.entries(accessorMap)) {
    if (acc !== name) rewrites[name] = acc
  }
  if (!Object.keys(rewrites).length && !setterMap) return expr

  let ast
  try {
    ast = acorn.parseExpressionAt(expr, 0, { ecmaVersion: 'latest' })
  } catch (_) {
    try {
      ast = acorn.parse(expr, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (_2) {
      return expr
    }
  }

  const patches = []

  // Collect parameter names for a function node.
  const collectParams = (node) => {
    const names = new Set()
    const addPattern = (p) => {
      if (!p) return
      if (p.type === 'Identifier') names.add(p.name)
      else if (p.type === 'AssignmentPattern') addPattern(p.left)
      else if (p.type === 'RestElement') addPattern(p.argument)
      else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern)
      else if (p.type === 'ObjectPattern')
        p.properties.forEach((prop) => addPattern(prop.value || prop.key))
    }
    ;(node.params || []).forEach(addPattern)
    return names
  }

  const walk = (n, parentKey, localScope) => {
    if (!n || typeof n !== 'object') return

    // When entering a new function scope, extend the local scope with params.
    if (
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'FunctionExpression' ||
      n.type === 'FunctionDeclaration'
    ) {
      const params = collectParams(n)
      const inner = new Set([...localScope, ...params])
      for (const k of Object.keys(n)) {
        if (k === 'start' || k === 'end' || k === 'type' || k === 'raw') continue
        const v = n[k]
        if (Array.isArray(v))
          v.forEach((item) => {
            if (item?.type) walk(item, k, inner)
          })
        else if (v?.type) walk(v, k, inner)
      }
      return // already handled all children
    }

    // Rewrite assignments to reactive lets: x = val → $$set_x(val)
    if (setterMap && n.type === 'AssignmentExpression') {
      const left = n.left
      if (left.type === 'Identifier' && setterMap[left.name] && !localScope.has(left.name)) {
        const setter = setterMap[left.name]
        const op = n.operator
        const rightRaw = expr.slice(n.right.start, n.right.end)
        const rightRw = rewriteExpr(rightRaw, accessorMap, setterMap)
        let replacement
        if (op === '=') {
          replacement = `${setter}(${rightRw})`
        } else {
          const base = op.slice(0, -1)
          const sigName = `$$sig_${left.name}`
          replacement = `${setter}($runtime.get(${sigName}) ${base} (${rightRw}))`
        }
        patches.push({ start: n.start, end: n.end, replacement })
        return
      }
    }

    // Rewrite update expressions: x++ → $$set_x($runtime.get($$sig_x) + 1)
    if (setterMap && n.type === 'UpdateExpression') {
      const arg = n.argument
      if (arg.type === 'Identifier' && setterMap[arg.name] && !localScope.has(arg.name)) {
        const setter = setterMap[arg.name]
        const sigName = `$$sig_${arg.name}`
        const op = n.operator === '++' ? '+' : '-'
        patches.push({
          start: n.start,
          end: n.end,
          replacement: `${setter}($runtime.get(${sigName}) ${op} 1)`
        })
        return
      }
    }

    // Shorthand property: { username } — key and value are the same node.
    // Replacing just the value identifier loses the key name.
    // Detect and expand to `key: newValue` form before the identifier walk.
    if (n.type === 'Property' && n.shorthand && n.value?.type === 'Identifier') {
      const name = n.value.name
      if (!localScope.has(name) && rewrites[name] !== undefined) {
        // Expand shorthand: { username } → { username: $runtime.get($$sig_username) }
        patches.push({ start: n.start, end: n.end, replacement: `${name}: ${rewrites[name]}` })
        return  // don't walk children — we've handled this Property
      }
      // Not a reactive var — leave as shorthand, walk normally
    }

    if (n.type === 'Identifier') {
      // Skip non-computed property names (obj.name) but NOT computed keys (obj[name])
      const skip = parentKey === 'key'
               || parentKey === 'params'
               || (parentKey === 'property' && !n._isComputedProp)
      if (!skip) {
        if (!localScope.has(n.name)) {
          const acc = rewrites[n.name]
          if (acc !== undefined) {
            patches.push({ start: n.start, end: n.end, replacement: acc })
            return
          }
        }
      }
    }

    // Mark computed MemberExpression property identifiers before walking them
    if (n.type === 'MemberExpression' && n.computed && n.property?.type === 'Identifier') {
      n.property._isComputedProp = true
    }

    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'type' || k === 'raw') continue
      const v = n[k]
      if (Array.isArray(v))
        v.forEach((item) => {
          if (item?.type) walk(item, k, localScope)
        })
      else if (v?.type) walk(v, k, localScope)
    }
  }

  walk(ast, null, new Set())
  if (!patches.length) return expr

  patches.sort((a, b) => b.start - a.start)
  let result = expr
  for (const p of patches) {
    result = result.slice(0, p.start) + p.replacement + result.slice(p.end)
  }
  return result
}

/**
 * Rewrite reactive variable references inside all expression parts of a
 * parseText result, returning a new template literal string.
 *
 * @param {object} pe         parseText() result
 * @param {object} accessorMap
 * @returns {string}  New template literal, e.g. `` `${$$sig_count()} items` ``
 */
export function rewriteTextResult(pe, accessorMap) {
  if (!accessorMap) return pe.result
  const result = []
  pe.parts.forEach((p) => {
    if (p.type === 'js') return
    if (p.type === 'exp') {
      result.push({ ...p, value: rewriteExpr(p.value, accessorMap) })
    } else {
      const l = last(result)
      if (l?.type === 'text') l.value += p.value
      else result.push({ ...p })
    }
  })
  return (
    '`' +
    result.map((p) => (p.type === 'text' ? Q(p.value) : '${' + p.value + '}')).join('') +
    '`'
  )
}

/**
 * Walk an AST node (a single script statement) and rewrite assignments to
 * reactive `let` variables so they call the corresponding signal setter.
 *
 *   count = 5     →  $$set_count(5)
 *   count += 2    →  $$set_count($runtime.get($$sig_count) + (2))
 *   count++       →  $$set_count($runtime.get($$sig_count) + 1)
 *   count--       →  $$set_count($runtime.get($$sig_count) - 1)
 *
 * Patches are relative to `srcOffset` (the node's start position in the full
 * script source), so the returned string is a self-contained rewritten snippet.
 *
 * @param {string} src       Raw source of the node (raw.slice(node.start, node.end))
 * @param {object} node      Acorn AST node (used for position info)
 * @param {object} ctx       Compile context (ctx.setters, ctx.accessors, ctx.script)
 * @returns {string}
 */
export function rewriteAssignments(src, node, ctx) {
  const { setters, accessors, script } = ctx
  // Early return only if there are NEITHER local setters NOR proxy fire functions.
  // Without proxy fire fns, self-assignments like `themeNew = themeNew` also need rewriting.
  const hasSetters = setters && Object.keys(setters).length > 0
  const hasProxyFire = ctx.proxyFireFns && Object.keys(ctx.proxyFireFns).length > 0
  if (!hasSetters && !hasProxyFire) return src

  const patches = [] // positions relative to full script source
  const srcOffset = node.start

  const walk = (n) => {
    if (!n || typeof n !== 'object') return

    if (n.type === 'AssignmentExpression') {
      const left = n.left
      // Self-assignment on an imported proxy root: `themeNew = themeNew`
      // This is the developer's way of saying "I mutated this object externally,
      // please force a re-render". ES module bindings are read-only so the assignment
      // would throw at runtime. Rewrite to fire the root signal instead.
      if (
        left.type === 'Identifier' &&
        ctx.proxyFireFns?.[left.name] &&
        n.right.type === 'Identifier' &&
        n.right.name === left.name &&
        n.operator === '='
      ) {
        const fireVar = ctx.proxyFireFns[left.name]
        patches.push({ start: n.start, end: n.end, replacement: `${fireVar}()` })
        return
      }
      if (left.type === 'Identifier' && setters[left.name]) {
        const setter = setters[left.name]
        const op = n.operator
        // Recursively rewrite the right-hand side BEFORE building our replacement.
        // This handles nested assignments inside callbacks:
        //   _interval = setInterval(() => { time = ... })
        // Without this, the outer replacement would capture the un-rewritten inner `time = ...`.
        const rightRawOriginal = script.source.slice(n.right.start, n.right.end)
        // Build a fake node spanning just the right side for recursive rewriting
        const rightRewritten = rewriteAssignments(rightRawOriginal, n.right, ctx)
        const rightRw = rewriteExpr(rightRewritten, accessors)
        let replacement
        if (op === '=') {
          replacement = `${setter}(${rightRw})`
        } else {
          const base = op.slice(0, -1) // strip trailing =
          const sigName = `$$sig_${left.name}`
          replacement = `${setter}($runtime.get(${sigName}) ${base} (${rightRw}))`
        }
        patches.push({ start: n.start, end: n.end, replacement })
        return // don't descend — right side already handled above
      }
    }

    if (n.type === 'UpdateExpression') {
      const arg = n.argument
      if (arg.type === 'Identifier' && setters[arg.name]) {
        const setter = setters[arg.name]
        const sigName = `$$sig_${arg.name}`
        const op = n.operator === '++' ? '+' : '-'
        patches.push({
          start: n.start,
          end: n.end,
          replacement: `${setter}($runtime.get(${sigName}) ${op} 1)`
        })
        return
      }
    }

    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'type' || k === 'raw') continue
      const v = n[k]
      if (Array.isArray(v))
        v.forEach((item) => {
          if (item?.type) walk(item)
        })
      else if (v?.type) walk(v)
    }
  }

  walk(node)
  if (!patches.length) return src

  // Convert absolute script positions → src-relative positions, then patch.
  patches.sort((a, b) => b.start - a.start)
  let result = src
  for (const p of patches) {
    const s = p.start - srcOffset
    const e = p.end - srcOffset
    result = result.slice(0, s) + p.replacement + result.slice(e)
  }
  return result
}

// ─── 2. xNODE IR ──────────────────────────────────────────────────────────────

let _current_context = null
export const get_context = (check) => {
  if (check !== false) assert(_current_context, 'Out of context')
  return _current_context
}
export const use_context = (ctx, fn) => {
  const prev = _current_context
  try {
    _current_context = ctx
    return fn.call(ctx)
  } finally {
    _current_context = prev
  }
}

class Indent {
  constructor(v = 0) {
    this.$indent = v
  }
}

class xWriter {
  constructor(node) {
    this.indent = 0
    this.write = (...args) => {
      for (const a of args) {
        if (a === true) node.$result.push(new Indent(this.indent))
        else node.$result.push(a)
      }
    }
    this.writeLine = (s) => this.write(true, s)
    this.add = (n) => {
      if (n === null) return
      assert(n instanceof xNode, 'xWriter.add: not an xNode')
      assert(!n.$inserted, 'xWriter.add: already inserted')
      node.$result.push({ node: n, indent: this.indent })
      n.$inserted = true
    }
    this.isEmpty = (n) => {
      if (n == null) return true
      assert(n.$done, 'isEmpty: node not built')
      return !n.$result.some((r) => {
        if (typeof r === 'string') return true
        if (r?.node instanceof xNode) return !this.isEmpty(r.node)
        if (r instanceof Indent) return true
        return false
      })
    }
  }
}

export function xBuild(node, option = {}) {
  let pending, trace, active
  const resolve = (n) => {
    if (n.__resolving) return
    n.__resolving = true
    active = n
    resolveDependencies(n, { check: true })
    if (!n.$done) {
      let ready = true
      n.$wait?.forEach((i) => {
        if (!i || i.$done) return
        resolve(i)
        if (i.$done) return
        ready = false
        trace.push(`${n.$type} -> ${i.$type}`)
      })
      if (ready) {
        const w = new xWriter(n)
        n.$handler(w, n)
        n.$done = true
      }
    }
    if (n.$done)
      n.$result.forEach((r) => {
        if (r?.node instanceof xNode) resolve(r.node)
      })
    else pending++
    n.__resolving = false
  }
  let depth
  for (depth = 10; depth > 0; depth--) {
    pending = 0
    trace = []
    try {
      resolve(node)
    } catch (e) {
      if (active) console.log('# Error node', active)
      throw e
    }
    if (!pending) break
  }
  if (!depth) {
    option.warning?.('(i) Circular dependency:\n' + trace.map((s) => ` * ${s}`).join('\n'))
    throw new Error('xNode: Circular dependency')
  }
  const result = []
  const asm = (n, baseIndent) => {
    if (!n.$done) throw new Error('node not resolved: ' + n.$type)
    n.$result.forEach((r) => {
      if (typeof r === 'string') result.push(r)
      else if (r?.node instanceof xNode) asm(r.node, r.indent + baseIndent)
      else if (r instanceof Indent) {
        r.$indent += baseIndent
        result.push(r)
      }
    })
  }
  asm(node, 0)
  for (let i = 0; i < result.length; i++) {
    if (!(result[i] instanceof Indent)) continue
    const next = result[i + 1]
    if (next instanceof Indent) {
      result[i] = ''
      continue
    }
    result[i] = '\n' + '  '.repeat(result[i].$indent)
  }
  return result.join('')
}

const _noop_handler = () => {}

export function xNode(type, ...args) {
  if (!(this instanceof xNode)) return new xNode(type, ...args)
  let data, handler
  if (args.length === 2) {
    ;[data, handler] = args
  } else if (typeof args[0] === 'function') {
    handler = args[0]
    data = {}
  } else {
    data = args[0] || {}
  }
  Object.assign(this, data)
  this.$type = type
  this.$handler = handler || _noop_handler
  this.$done = false
  this.$inserted = false
  this.$result = []
  this.$setValue = function (value = true) {
    assert(!this.$done, 'setValue on resolved node')
    if (typeof value === 'object') Object.assign(this, value)
    else this.value = value
  }
  get_context(false) && resolveDependencies(this)
  return this
}

export const resolveDependencies = (node, option) => {
  if (node.$wait) {
    node.$wait = node.$wait.map((n) => {
      if (typeof n === 'string') {
        const ctx = get_context()
        if (ctx.glob[n]) n = ctx.glob[n]
        else if (option?.check) throw new Error(`Wrong dependency '${n}'`)
      }
      return n
    })
  }
  if (node.$hold) {
    node.$hold = node.$hold.map((n) => {
      if (typeof n === 'string') {
        const ctx = get_context()
        if (ctx.glob[n]) n = ctx.glob[n]
        else if (option?.check) throw new Error(`Wrong dependency '${n}'`)
        else return n
      }
      if (!n.$wait) n.$wait = []
      if (!n.$wait.includes(node)) {
        assert(!n.$done, 'Attempt to add dependency, but node is already resolved')
        n.$wait.push(node)
      }
      return n
    })
  }
}

xNode.raw = (value) =>
  xNode('raw', { value }, (ctx, n) => {
    ctx.write(true, n.value)
  })

xNode.block = (data = {}) =>
  xNode(
    'block',
    {
      body: [],
      push(child) {
        assert(arguments.length === 1)
        if (typeof child === 'string') child = xNode.raw(child)
        this.body.push(child)
      },
      unshift(child) {
        assert(arguments.length === 1)
        if (typeof child === 'string') child = xNode.raw(child)
        this.body.unshift(child)
      },
      ...data
    },
    (ctx, node) => {
      if (node.scope) {
        ctx.writeLine('{')
        ctx.indent++
      }
      node.body.forEach((n) => {
        if (n == null) return
        if (typeof n === 'string') {
          if (n) ctx.writeLine(n)
        } else ctx.add(n)
      })
      if (node.scope) {
        ctx.indent--
        ctx.writeLine('}')
      }
    }
  )

xNode.baseNode = (type, data, handler) =>
  xNode(
    type,
    {
      bindName() {
        if (!this._boundName) this._boundName = `el${get_context().uniqIndex++}`
        return this._boundName
      },
      ...data
    },
    handler
  )

xNode.node = (data) =>
  xNode.baseNode(
    'node',
    {
      children: [],
      attributes: [],
      class: new Set(),
      voidTag: false,
      getLast() {
        return last(this.children)
      },
      push(n) {
        if (typeof n === 'string') {
          const p = last(this.children)
          if (p && p.$type === 'node:text') {
            p.value += n
            return p
          }
          n = xNode.baseNode('node:text', { value: n }, (ctx, node) => {
            ctx.write(node.value)
          })
        }
        assert(n instanceof xNode)
        this.children.push(n)
        return n
      },
      ...data
    },
    (ctx, node) => {
      if (node.inline) {
        node.children.forEach((n) => ctx.add(n))
        return
      }
      assert(node.name, 'No node name')
      ctx.write(`<${node.name}`)
      node.attributes.forEach((p) => {
        if (p.name === 'class') {
          if (p.value) p.value.split(/\s+/).forEach((c) => node.class.add(c))
          return
        }
        if (p.value) ctx.write(` ${p.name}="${p.value}"`)
        else ctx.write(` ${p.name}`)
      })
      if (node.class.size)
        ctx.add(get_context().css.resolveAsNode(node.class, [' class="', '"']))
      if (node.children.length) {
        ctx.write('>')
        node.children.forEach((n) => ctx.add(n))
        ctx.write(`</${node.name}>`)
      } else {
        ctx.write(node.voidTag ? '/>' : `></${node.name}>`)
      }
    }
  )

xNode.nodeComment = (data) =>
  xNode.baseNode('node:comment', data, (ctx, node) => {
    const { debug, debugLabel } = get_context().config
    if (debug && debugLabel) ctx.write(`<!-- ${node.value} -->`)
    else ctx.write('<!---->')
  })

xNode.template = (data) =>
  xNode('template', data, (ctx, node) => {
    const { config } = get_context()
    let template = xBuild(node.body, { warning: config.warning })
    let convert,
      cloneNode = node.cloneNode
    if (node.svg) {
      convert = '$runtime.svgToFragment'
      cloneNode = false
    } else if (!template.match(/[<>]/) && !node.requireFragment) {
      convert = '$runtime.createTextNode'
      cloneNode = false
      if (!node.raw) template = htmlEntitiesToText(template)
    } else {
      convert = config.hideLabel ? '$runtime.htmlToFragmentClean' : '$runtime.htmlToFragment'
      template = template.replace(/<!---->/g, '<>')
    }
    if (node.raw) {
      ctx.write(Q(template))
      return
    }
    const opt = (cloneNode ? 1 : 0) + (node.requireFragment ? 2 : 0)
    const optStr = opt ? `, ${opt}` : ''
    if (node.inline) {
      ctx.write(`${convert}(\`${Q(template)}\`${optStr})`)
    } else {
      assert(node.name)
      ctx.write(true, `const ${node.name} = ${convert}(\`${Q(template)}\`${optStr});`)
    }
  })

// ─── 3. PARSER ────────────────────────────────────────────────────────────────

class Reader {
  constructor(src) {
    if (src instanceof Reader) return src
    this.index = 0
    this.source = src
  }
  read(pattern) {
    assert(!this.end(), 'EOF')
    if (pattern == null) return this.source[this.index++]
    if (pattern instanceof RegExp) {
      assert(pattern.source[0] === '^')
      const rx = this.source.substring(this.index).match(pattern)
      assert(
        rx && rx.index === 0,
        'Wrong syntax at: ' + this.source.substring(this.index, this.index + 30)
      )
      this.index += rx[0].length
      return rx[rx.length - 1]
    }
    throw new Error('Not implemented')
  }
  probe(pattern) {
    if (pattern instanceof RegExp) {
      assert(pattern.source[0] === '^')
      const r = this.source.substring(this.index).match(pattern)
      return r ? r[0] : null
    }
    return this.source.startsWith(pattern, this.index) ? pattern : null
  }
  probeQuote() {
    const a = this.source[this.index]
    return a === '"' || a === "'" || a === '`'
  }
  readIf(pattern) {
    const r = this.probe(pattern)
    if (r != null) this.index += r.length
    return r
  }
  end() {
    return this.index >= this.source.length
  }
  skip() {
    while (!this.end() && /\s/.test(this.source[this.index])) this.index++
  }
  readString() {
    const q = this.read()
    assert(q === '"' || q === '`' || q === "'")
    let a = null,
      p,
      result = q
    while (true) {
      p = a
      a = this.read()
      result += a
      if (a === q && p !== '\\') break
    }
    return result
  }
  readAttribute() {
    let name = ''
    let depth = 0  // paren depth — chars inside (...) are part of the name regardless
    while (!this.end()) {
      const a = this.source[this.index]
      if (a === '(') depth++
      else if (a === ')') {
        if (depth > 0) { depth--; name += a; this.index++; continue }
      }
      if (depth === 0 && '=/>\t\n\v\f\r '.includes(a)) break
      name += a
      this.index++
    }
    assert(name, 'Syntax error: empty attribute name')
    return name
  }
  sub(start, end) {
    return this.source.substring(start, end ?? this.index)
  }
}

export function parseHTML(source) {
  const reader = new Reader(source)
  const _parseErrors = []   // parse-time errors collected without throwing

  const readScriptJS = () => {
    class ScriptParser extends acorn.Parser {
      readToken_lt_gt(code) {
        if (this.input.slice(this.pos, this.pos + 9) === '</script>')
          return this.finishToken(acorn.tokTypes.eof)
        return super.readToken_lt_gt(code)
      }
      scan() {
        this.nextToken()
        while (this.type !== acorn.tokTypes.eof) this.parseStatement(null, true, null)
        return this.end
      }
    }
    const start = reader.index
    const parser = new ScriptParser(
      { ecmaVersion: 'latest', sourceType: 'module' },
      reader.source,
      start
    )
    const end = parser.scan()
    reader.index = end + 9
    return reader.sub(start, end)
  }

  const go = (parent, push) => {
    let textNode = null
    if (!push) push = (n) => parent.body.push(n)
    const addText = (v) => {
      if (!textNode) textNode = { type: 'text', value: '' }
      textNode.value += v
    }
    const flushText = () => {
      if (!textNode) return
      push(textNode)
      textNode = null
    }

    while (!reader.end()) {
      if (reader.probe('<') && reader.probe(/^<\S/)) {
        flushText()
        if (reader.probe('<!--')) {
          push({ type: 'comment', content: reader.read(/^<!--.*?-->/s) })
          continue
        }
        if (reader.readIf('</')) {
          let name = reader.read(/^([^>]*)>/)
          name = name.trim().split(':')[0]
          if (name)
            assert(
              name === parent.name,
              `Wrong close-tag: expected </${parent.name}> got </${name}>`
            )
          return
        }
        const tag = readTag(reader)
        push(tag)
        if (tag.name === 'script') {
          let isJS = true
          let isModule = false
          for (const a of tag.attributes) {
            if (['lang', 'language', 'type'].includes(a.name)) {
              isJS = a.value.includes('javascript') || a.value.includes('ecmascript')
            }
            if (a.name === 'module' || (a.name === 'context' && a.value === 'module')) {
              isModule = true
            }
          }
          tag.type = isModule ? 'script-module' : 'script'
          tag.content = isJS ? readScriptJS() : reader.read(/^(.*?)<\/script>/s)
          continue
        }
        if (tag.name === 'style') {
          tag.type = 'style'
          tag.content = reader.read(/^(.*?)<\/style>/s)
          continue
        }
        if (tag.name === 'template') {
          tag.type = 'template'
          tag.content = reader.read(/^(.*?)<\/template>/s)
          continue
        }
        tag.classes = new Set()
        if (tag.closedTag) continue
        tag.body = []
        try {
          go(tag)
        } catch (e) {
          if (typeof e === 'string') e = new Error(e)
          if (!e.details) e.details = tag.openTag
          throw e
        }
        continue
      }

      if (reader.probe('{')) {
        if (reader.probe(/^\{[#/:@*]/)) {
          const bind = parseBinding(reader)
          if (bind.value[0] !== '*') flushText()
          if (bind.value[0] === '*') {
            addText(bind.raw)
            continue
          }
          const v = bind.value
          if (v.match(/^@\w+/)) {
            if (v.startsWith('@attach')) {
              const expr = v.slice(7).trim()
              _parseErrors.push(
                `{@attach} is an element directive — it cannot appear in text content. ` +
                `Place it on an element instead: <div {@attach ${expr}}>…</div>`
              )
            }
            push({ type: 'systag', value: v })
            continue
          }
          if (v.startsWith('#virtual each ')) {
            // {#virtual each arr as item (key)} — windowed virtual list
            const tag = { type: 'virtual-each', value: v.replace('#virtual ', '#'), mainBlock: [] }
            push(tag)
            go(tag, (n) => tag.mainBlock.push(n))
            continue
          }
          if (v === '/virtual') {
            assert(parent.type === 'virtual-each', '/virtual outside #virtual each')
            return
          }
          if (v.startsWith('#each ')) {
            const tag = { type: 'each', value: v, mainBlock: [] }
            push(tag)
            go(tag, (n) => tag.mainBlock.push(n))
            continue
          }
          if (v === ':else' && parent.type === 'each') {
            assert(!parent.elseBlock)
            parent.elseBlock = []
            return go(parent, (n) => parent.elseBlock.push(n))
          }
          if (v === '/each') {
            assert(parent.type === 'each', '/each outside #each')
            return
          }
          if (v.startsWith('#if ')) {
            const tag = { type: 'if', parts: [{ value: v, body: [] }] }
            push(tag)
            go(tag, (n) => tag.parts[0].body.push(n))
            continue
          }
          if (v.startsWith('#key ')) {
            const tag = { type: 'key', value: v, body: [] }
            push(tag)
            go(tag, (n) => tag.body.push(n))
            continue
          }
          if (v === '/key') {
            assert(parent.type === 'key', '/key outside #key')
            return
          }
          if (v.startsWith('#snippet ')) {
            const rx = v.match(/^#snippet\s+(\w+)\s*\(([^)]*)\)/)
            assert(rx, `Invalid #snippet syntax: ${v}`)
            const tag = { type: 'snippet', name: rx[1], rawArgs: rx[2].trim(), body: [] }
            push(tag)
            go(tag, (n) => tag.body.push(n))
            continue
          }
          if (v === '/snippet') {
            assert(parent.type === 'snippet', '/snippet outside #snippet')
            return
          }
          if (v.match(/^:elif\s|^:else\s+if\s/)) {
            assert(parent.type === 'if')
            const part = { value: v, body: [] }
            parent.parts.push(part)
            return go(parent, (n) => part.body.push(n))
          }
          if (v === ':else') {
            assert(parent.type === 'if', ':else outside #if')
            parent.elsePart = []
            return go(parent, (n) => parent.elsePart.push(n))
          }
          if (v === '/if') {
            assert(parent.type === 'if', '/if outside #if')
            return
          }
          if (v.startsWith('#await ')) {
            const tag = { type: 'await', value: v, parts: { main: [] } }
            push(tag)
            go(tag, (n) => tag.parts.main.push(n))
            continue
          }
          if (v.match(/^:then( |$)/)) {
            assert(parent.type === 'await')
            parent.parts.then = []
            parent.parts.thenValue = v
            return go(parent, (n) => parent.parts.then.push(n))
          }
          if (v.match(/^:catch( |$)/)) {
            assert(parent.type === 'await')
            parent.parts.catch = []
            parent.parts.catchValue = v
            return go(parent, (n) => parent.parts.catch.push(n))
          }
          if (v === '/await') {
            assert(parent.type === 'await')
            return
          }
          if (v.match(/^#slot(:| |$)/)) {
            const tag = { type: 'slot', value: v, body: [] }
            push(tag)
            go(tag)
            continue
          }
          if (v === '/slot') {
            assert(parent.type === 'slot')
            return
          }
          if (v.startsWith('#fragment:')) {
            const tag = { type: 'fragment', value: v, body: [] }
            push(tag)
            go(tag)
            continue
          }
          if (v === '/fragment') {
            assert(parent.type === 'fragment')
            return
          }
          if (v.match(/^#([\w\-]+)/)) {
            const name = v.match(/^#([\w\-]+)/)[1]
            const tag = { type: 'block', value: v, name, body: [] }
            push(tag)
            go(tag)
            continue
          }
          if (v.match(/^\/([\w\-]+)/)) {
            const name = v.match(/^\/([\w\-]+)/)[1]
            assert(
              parent.type === 'block' && parent.name === name,
              `Block mismatch: ${parent.name} vs ${name}`
            )
            return
          }
          throw new Error('Unknown binding: ' + v)
        }
        addText(parseBinding(reader).raw)
        continue
      }
      addText(reader.read())
    }
    flushText()
    assert(parent.type === 'root', 'Unexpected EOF')
  }

  const root = { type: 'root', body: [] }
  go(root)
  root._parseErrors = _parseErrors
  return root
}

function readTag(reader) {
  const start = reader.index
  assert(reader.read() === '<')
  let name = reader.read(/^[\da-zA-Z^\-]+/)
  let elArg = null
  if (reader.readIf(':')) elArg = reader.read(/^[^\s>/]+/)
  const attributes = parseAttributes(reader, { closedByTag: true })
  let closedTag = false
  if (reader.readIf('/>')) closedTag = true
  else assert(reader.readIf('>'), 'Expected >')
  const voidTags = [
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
  ]
  if (voidTags.includes(name)) closedTag = true
  return {
    type: 'node',
    name,
    elArg,
    openTag: reader.sub(start),
    start,
    end: reader.index,
    closedTag,
    voidTag: voidTags.includes(name),
    attributes
  }
}

export function parseText(source) {
  let i = 0,
    step = 0,
    text = '',
    exp = '',
    q,
    len = source.length
  const parts = []
  let depth = 0
  while (i < len) {
    const a = source[i++]
    if (step === 1) {
      if (q) {
        if (a === q) q = null
        exp += a
        continue
      }
      if (a === '"' || a === "'" || a === '`') {
        q = a
        exp += a
        continue
      }
      if (a === '{') depth++
      else if (a === '}') {
        depth--
        if (!depth) {
          step = 0
          const js = exp[0] === '*'
          if (js) exp = exp.substring(1)
          exp = exp.trim()
          if (!exp) throw new Error('Wrong expression')
          parts.push({ value: exp, type: js ? 'js' : 'exp' })
          exp = ''
          continue
        }
      }
      exp += a
      continue
    }
    if (a === '{') {
      depth++
      if (text) {
        parts.push({ value: text, type: 'text' })
        text = ''
      }
      step = 1
      continue
    }
    text += a
  }
  if (text) parts.push({ value: text, type: 'text' })
  assert(step === 0, 'Wrong expression in: ' + source)

  const staticText = !parts.some((p) => p.type === 'exp')
    ? parts.map((p) => (p.type === 'text' ? p.value : '')).join('')
    : null

  const pe = {
    parts,
    staticText,
    binding: parts.length === 1 && parts[0].type === 'exp' ? parts[0].value : null,
    getResult() {
      const result = []
      this.parts.forEach((p) => {
        if (p.type === 'js') return
        if (p.type === 'exp') result.push(p)
        else {
          const l = last(result)
          if (l?.type === 'text') l.value += p.value
          else result.push({ ...p })
        }
      })
      return (
        '`' +
        result.map((p) => (p.type === 'text' ? Q(p.value) : '${' + p.value + '}')).join('') +
        '`'
      )
    }
  }
  pe.result = pe.getResult()
  return pe
}

export const parseBinding = (source) => {
  const reader = new Reader(source)
  const start = reader.index
  assert(reader.read() === '{', 'Bind error')
  let a = null,
    p,
    q,
    bkt = 1
  while (true) {
    p = a
    a = reader.read()
    if (q) {
      if (a === q && p !== '\\') q = null
      continue
    }
    if (a === '"' || a === "'" || a === '`') {
      q = a
      continue
    }
    if (a === '{') {
      bkt++
      continue
    }
    if (a === '}') {
      bkt--
      if (!bkt) break
    } else continue
  }
  const raw = reader.sub(start)
  return { raw, value: raw.substring(1, raw.length - 1).trim() }
}

export const parseAttributes = (source, option = {}) => {
  const r = new Reader(source)
  const result = []
  while (!r.end()) {
    r.skip()
    if (option.closedByTag && (r.probe('/>') || r.probe('>'))) break
    if (r.end()) break
    const start = r.index
    if (r.probe('{@attach')) {
      // {@attach expr} — element/component attachment
      const { raw, value } = parseBinding(r)
      const expr = value.replace(/^@attach\s*/, '')
      result.push({ name: '@attach', value: expr, raw, content: raw, type: 'attach' })
    } else if (r.probe('{*')) {
      const { raw } = parseBinding(r)
      result.push({ name: raw, content: raw })
    } else if (r.probe('*{')) {
      r.read()
      const { raw } = parseBinding(r)
      result.push({ name: '*' + raw, content: '*' + raw })
    } else if (r.probe('{...')) {
      const { raw } = parseBinding(r)
      result.push({ name: raw, content: raw })
    } else {
      let name = r.readAttribute()
      if (r.readIf('=')) {
        if (r.probe('{')) {
          const { raw } = parseBinding(r)
          result.push({ name, value: raw, raw, content: r.sub(start), type: 'exp' })
        } else if (r.probeQuote()) {
          const raw = r.readString()
          result.push({
            name,
            value: raw.slice(1, -1),
            raw,
            content: r.sub(start),
            type: 'text'
          })
        } else {
          const value = r.readIf(/^[^\s<>]+/)
          result.push({ name, value, raw: value, content: r.sub(start), type: 'word' })
        }
      } else {
        if (name[0] === '{' && last(name) === '}' && !name.startsWith('{...')) {
          const value = name
          const attrName = unwrapExp(name)
          // {class} shorthand → class={$class} (class is reserved, auto-wire $class prop)
          if (attrName === 'class') {
            result.push({
              name: 'class',
              value: '{$class}',
              raw: '{$class}',
              content: r.sub(start),
              type: 'exp',
              $classAuto: true
            })
          } else {
            result.push({ name: attrName, value, raw: value, content: r.sub(start), type: 'exp' })
          }
        } else {
          // bind:class (no value)  → bind:class={$class}
          // {class}    (shorthand) → class={$class}  (the {class} form already unwraps to class with value {class})
          // These are the child-side magic: auto-wire the $class prop.
          const autoClass = name === 'bind:class' || name === ':class'
          if (autoClass) {
            result.push({
              name,
              value: '{$class}',
              raw: '{$class}',
              content: r.sub(start),
              type: 'exp',
              $classAuto: true
            })
          } else {
            result.push({
              name,
              value: undefined,
              raw: undefined,
              content: r.sub(start),
              type: 'attribute'
            })
          }
        }
      }
    }
  }
  return result
}

// ─── 4. ANALYZER ──────────────────────────────────────────────────────────────

function collectRefs(node) {
  const refs = new Set()
  const walk = (n, parentKey) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Identifier') {
      // Skip identifiers that are non-computed property keys — they're names,
      // not references to variables. Covers:
      //   { name: 'Alice' }       → 'name' is a Property key, not a ref
      //   obj.name                → 'name' is a MemberExpression property, not a ref
      //   class { method() {} }   → 'method' is a MethodDefinition key, not a ref
      if (parentKey !== 'key' && parentKey !== 'property') {
        refs.add(n.name)
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'type') continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((i) => { if (i?.type) walk(i, k) })
      else if (c?.type) walk(c, k)
    }
  }
  walk(node, null)
  return refs
}

function memberPath(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression' && !node.computed)
    return memberPath(node.object) + '.' + node.property.name
  return null
}

export function analyzeScript(raw, ast) {
  const vars = {}
  const watchPaths = []
  const watchHandlers = []
  const watchGroups = []
  const postCallHooks = []
  const effects = []
  const imports = []
  const errors = []
  const warnings = []
  // Nodes that cannot be expanded (e.g. computed keys) — emitted verbatim.
  const passthroughDeclStarts = new Set()

  /**
   * Expand a destructuring declarator into synthetic flat identifier entries
   * in `vars`, as if the developer had written individual member-access consts.
   *
   *   const {name, age}   = source  →  const name = source.name
   *                                     const age  = source.age
   *   const {name: alias} = source  →  const alias = source.name
   *   const {name = 'X'}  = source  →  const name = source.name ?? 'X'
   *   const [a, b]        = source  →  const a = source[0]
   *                                     const b = source[1]
   *   const {[dyn]: v}    = source  →  WARNING + passthrough
   *
   * @param {object} pattern  Acorn ObjectPattern or ArrayPattern node
   * @param {string} initExpr Access expression for the RHS (e.g. 'source', 'source.totals')
   * @param {string} kind     'let' | 'const' | 'var'
   * @param {object} node     Original VariableDeclaration node (for nodeStart/nodeEnd)
   * @returns {boolean} true if fully expanded, false if a computed key forced passthrough
   */
  const expandPattern = (pattern, initExpr, kind, node) => {
    if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        // Rest element: { ...rest }
        if (prop.type === 'RestElement') {
          warnings.push(
            `Rest element in destructuring is not expanded by Mesa — ` +
            `'${raw.slice(prop.start, prop.end)}' emitted as plain JS`
          )
          passthroughDeclStarts.add(node.start)
          return false
        }
        // Computed key: { [expr]: val }
        if (prop.computed) {
          const keyStr = raw.slice(prop.key.start, prop.key.end)
          warnings.push(
            `Computed destructuring key '[${keyStr}]' cannot be statically expanded — ` +
            `emitted as plain JS. Consider: const val = source[${keyStr}]`
          )
          passthroughDeclStarts.add(node.start)
          return false
        }

        const keyName = prop.key.name ?? prop.key.value
        const memberExpr = `${initExpr}.${keyName}`

        // { name: pattern } — recurse for nested destructuring
        if (
          prop.value.type === 'ObjectPattern' ||
          prop.value.type === 'ArrayPattern'
        ) {
          const ok = expandPattern(prop.value, memberExpr, kind, node)
          if (!ok) return false
          continue
        }

        // { name: alias } or { name } (shorthand, value is Identifier)
        // { name = default } (AssignmentPattern)
        let localName, syntheticInit

        if (prop.value.type === 'AssignmentPattern') {
          // { name = defaultValue }
          localName = prop.value.left.name
          const defaultSrc = raw.slice(prop.value.right.start, prop.value.right.end)
          syntheticInit = `(${memberExpr}) !== undefined ? (${memberExpr}) : (${defaultSrc})`
        } else {
          // { name } or { name: alias }
          localName = prop.value.name
          syntheticInit = memberExpr
        }

        vars[localName] = {
          name: localName,
          kind,
          initRaw: syntheticInit,
          // Synthetic initNode — null because we built the expression ourselves.
          // Dep detection in Pass 2 will parse initRaw from scratch.
          initNode: null,
          _syntheticInit: syntheticInit,
          deps: [],
          isExport: false,
          isDerived: false,
          isAsync: false,
          isProp: false,
          nodeStart: node.start,
          nodeEnd: node.end
        }
      }
      return true
    }

    if (pattern.type === 'ArrayPattern') {
      pattern.elements.forEach((el, idx) => {
        if (!el) return // holes: const [,second] = arr

        // Rest element: [...rest]
        if (el.type === 'RestElement') {
          warnings.push(
            `Rest element in array destructuring is not expanded by Mesa — ` +
            `'${raw.slice(el.start, el.end)}' emitted as plain JS`
          )
          passthroughDeclStarts.add(node.start)
          return
        }

        const memberExpr = `${initExpr}[${idx}]`

        // Nested pattern
        if (el.type === 'ObjectPattern' || el.type === 'ArrayPattern') {
          expandPattern(el, memberExpr, kind, node)
          return
        }

        // Default: [a = default]
        let localName, syntheticInit
        if (el.type === 'AssignmentPattern') {
          localName = el.left.name
          const defaultSrc = raw.slice(el.right.start, el.right.end)
          syntheticInit = `(${memberExpr}) !== undefined ? (${memberExpr}) : (${defaultSrc})`
        } else {
          localName = el.name
          syntheticInit = memberExpr
        }

        vars[localName] = {
          name: localName,
          kind,
          initRaw: syntheticInit,
          initNode: null,
          _syntheticInit: syntheticInit,
          deps: [],
          isExport: false,
          isDerived: false,
          isAsync: false,
          isProp: false,
          nodeStart: node.start,
          nodeEnd: node.end
        }
      })
      return !passthroughDeclStarts.has(node.start)
    }

    return true
  }

  // ── Pass 1: classify declarations ──────────────────────────────────────────
  const contextProvides = []   // { key, initRaw, nodeStart }

  // Pre-scan for import names so $: label parsing (also in Pass 1) can
  // distinguish imported identifiers from locally-declared functions.
  // An imported name in $: (a, b) is a path watch, never a handler.
  const importedNameSet = new Set()
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) importedNameSet.add(s.local.name)
    }
  }

  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      imports.push(node)
      continue
    }

    // $context.key = expr  — context provide
    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression' &&
      node.expression.operator === '=' &&
      node.expression.left?.type === 'MemberExpression' &&
      node.expression.left.object?.type === 'Identifier' &&
      node.expression.left.object.name === '$context' &&
      !node.expression.left.computed &&
      node.expression.left.property?.type === 'Identifier'
    ) {
      const key     = node.expression.left.property.name
      const initRaw = raw.slice(node.expression.right.start, node.expression.right.end)
      contextProvides.push({ key, initRaw, nodeStart: node.start })
      passthroughDeclStarts.add(node.start)
      continue
    }

    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'VariableDeclaration'
    ) {
      const decl = node.declaration
      for (const d of decl.declarations) {
        const name = d.id?.name
        if (!name) continue
        vars[name] = {
          name,
          kind: decl.kind,
          initRaw: d.init ? raw.slice(d.init.start, d.init.end) : undefined,
          initNode: d.init,
          deps: [],
          isExport: true,
          isDerived: false,
          isAsync: false,
          isProp: true,   // all export let/const/var are props; kind determines mutability
          nodeStart: node.start,
          nodeEnd: node.end
        }
      }
      continue
    }

    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        const name = d.id?.name
        if (!name) {
          // Pattern declarator — attempt to expand into flat identifier vars.
          if (d.id.type === 'ObjectPattern' || d.id.type === 'ArrayPattern') {
            const initExpr = d.init ? raw.slice(d.init.start, d.init.end) : 'undefined'
            expandPattern(d.id, initExpr, node.kind, node)
          } else {
            passthroughDeclStarts.add(node.start)
          }
          continue
        }

        // $context.key consume — let/const/var name = $context.key
        const init = d.init
        if (
          init?.type === 'MemberExpression' &&
          init.object?.type === 'Identifier' &&
          init.object.name === '$context' &&
          !init.computed &&
          init.property?.type === 'Identifier'
        ) {
          const contextKey = init.property.name
          // Do NOT add to passthroughDeclStarts — the original `const x = $context.key`
          // must be suppressed so the compiler-generated track() version is the only
          // declaration emitted. Passthrough would re-declare x with `$context.key`
          // (undefined at runtime), overwriting the reactive signal.
          vars[name] = {
            name,
            kind: node.kind,
            initRaw: raw.slice(init.start, init.end),
            initNode: init,
            deps: [],
            isExport: false,
            isDerived: node.kind === 'const' || node.kind === 'let',
            isAsync: false,
            isProp: false,
            isContextConsume: true,
            contextKey,
            nodeStart: node.start,
            nodeEnd: node.end
          }
          continue
        }

        vars[name] = {
          name,
          kind: node.kind,
          initRaw: d.init ? raw.slice(d.init.start, d.init.end) : undefined,
          initNode: d.init,
          deps: [],
          isExport: false,
          isDerived: false,
          isAsync: false,
          isProp: false,
          nodeStart: node.start,
          nodeEnd: node.end
        }
      }
      continue
    }

    if (node.type === 'LabeledStatement') {
      const lbl = node.label.name

      // Only process Mesa reactive labels.
      if (!lbl.startsWith('$')) continue

      // $: and $_name: are valid.
      // Any other $xxx: is reserved for future Mesa features — compiler error.
      const isBase   = lbl === '$'
      const isDebug  = lbl.startsWith('$_') && lbl.length > 2
      if (!isBase && !isDebug) {
        errors.push(
          `'${lbl}:' is reserved for future Mesa use. ` +
          `Use '$:' or '$_name:' (with underscore) for named effects.`
        )
        continue
      }

      // The debug label name (without leading $_ ), or null for plain $:
      const debugName = isDebug ? lbl.slice(2) : null
      const body = node.body

      // Block form — $: { dep, handler \n dep, handler \n ... }
      // Each statement in the block must be a watch+handler expression statement.
      // The entries are collected as an ordered group and emitted as a single
      // orderedGroup() call — deps are subscribed individually but handlers run
      // in declared order, batched, once per flush.
      if (body.type === 'BlockStatement') {
        // Check if this looks like an ordered watch group:
        // every statement is a SequenceExpression ending in a function.
        // If any statement is a bare expression, treat the whole block as
        // an auto-tracked side effect instead.
        const allAreWatchPairs = body.body.every((stmt) => {
          if (stmt.type !== 'ExpressionStatement') return false
          const e = stmt.expression
          if (e.type !== 'SequenceExpression') return false
          const lastE = e.expressions[e.expressions.length - 1]
          // Inside a block the handler must be an INLINE function. The bare form
          // (`$: dep, syncFn`) still accepts a function reference, but in a block
          // that shorthand is indistinguishable from a plain multi-value read:
          // `{ a, syncFn }` and `{ a, b }` have identical ASTs. Requiring `() =>`
          // here removes the ambiguity and costs one arrow per line in a form
          // whose whole purpose is ordering several handlers.
          return ['ArrowFunctionExpression', 'FunctionExpression'].includes(lastE.type)
        })

        // A block runs code. If its body provably does nothing — every statement
        // is a bare read — the author reached for braces to express a watch and
        // got silence instead: effects don't drive renders in Mesa, so an effect
        // with no side effect is unobservable.
        //
        // This is a compile error rather than a warning because it is decidable,
        // and because the previous behaviour was worse than either: `$: { (a, b) }`
        // compiled to orderedGroup([{ deps: [a], handler: <value of b> }]) and
        // threw `fn is not a function` the first time `a` changed.
        // `[].every()` is true, so an empty block reads as "all watch pairs" —
        // check length explicitly.
        const looksLikeGroup = body.body.length > 0 && allAreWatchPairs
        if (!looksLikeGroup && _isInertBlock(body)) {
          const inner = raw.slice(body.start + 1, body.end - 1).trim()

          // Distinguish "you probably meant a handler" from "you probably meant
          // a watch". An unparenthesised sequence with an identifier tail is the
          // shape of an attempted `dep, handlerRef`, which blocks no longer take.
          const looksLikeHandlerRef = body.body.some((stmt) => {
            if (stmt.type !== 'ExpressionStatement') return false
            const e = stmt.expression
            if (e.type !== 'SequenceExpression') return false
            if (raw[e.start - 1] === '(') return false
            return e.expressions[e.expressions.length - 1].type === 'Identifier'
          })

          if (body.body.length === 0) {
            errors.push(
              `'$: { }' is empty. A '$: { }' block runs code; to watch values without a body, use '$: deps' instead.`
            )
          } else if (looksLikeHandlerRef) {
            const tail = inner.split(',').pop().trim()
            const head = inner.slice(0, inner.lastIndexOf(',')).trim()
            errors.push(
              `'$: { ${inner} }' does nothing. A handler inside a '$: { }' block must be an inline ` +
              `function — the reference shorthand is only available on the unbraced form, because ` +
              `'{ a, handler }' and '{ a, b }' are indistinguishable. ` +
              `If '${tail}' is a handler, write '${head}, () => ${tail}()'. ` +
              `If you meant to watch both values, drop the braces: '$: (${inner})'.`
            )
          } else {
            errors.push(
              `'$: { ${inner} }' does nothing — a '$: { }' block runs code, and this body only reads values. ` +
              `To watch these and re-render, drop the braces: '$: ${inner}'. ` +
              `To run something when they change, add a handler: '$: ${inner}, () => { ... }'.`
            )
          }
          continue
        }

        if (looksLikeGroup) {
          // Ordered watch group — all entries are dep, handler pairs.
          const entries = []
          for (const stmt of body.body) {
            const e = stmt.expression
            const seqExprs = e.expressions
            const lastE = seqExprs[seqExprs.length - 1]
            const depExprs = seqExprs.slice(0, -1)
            entries.push({
              deps: depExprs.flatMap((de) => {
                const p = memberPath(de)
                return p ? [p] : [...collectRefs(de)]
              }),
              isAsync: lastE.async || false,
              handlerRaw: raw.slice(lastE.start, lastE.end),
              depsRaw: depExprs.map((de) => raw.slice(de.start, de.end)).join(', ')
            })
          }
          if (entries.length > 0) {
            watchGroups.push({ entries, debugName })
          }
        } else {
          // Auto-tracked block effect — re-runs when any reactive dep changes.
          effects.push({
            type: 'block',
            raw: raw.slice(body.start, body.end),
            debugName
          })
        }
        continue
      }

      if (body.type !== 'ExpressionStatement') {
        // $: if / $: for / $: while etc. are not valid Mesa forms.
        // Use $: { if (...) { } } — the block form — for conditional side effects.
        if (body.type !== 'BlockStatement') {
          errors.push(
            `'$: ${body.type.replace('Statement', '').toLowerCase()} ...' is not a valid Mesa reactive form. ` +
            `Wrap it in a block: $: { ${raw.slice(body.start, body.end)} }`
          )
        }
        continue
      }
      const expr = body.expression

      if (expr.type === 'SequenceExpression') {
        const exprs = expr.expressions
        const lastEx = exprs[exprs.length - 1]
        const rest = exprs.slice(0, -1)
        // An Identifier is a handler only if it's NOT a known reactive variable
        // AND NOT an imported name. `$: dep, fn` is valid when fn is a locally-
        // declared function. `$: (a, b)` where a/b are imports or local lets
        // must go to Shape 3 (multi-path watch), not Shape 2 (watch+handler).
        const identIsHandler = lastEx.type === 'Identifier' &&
          !vars[lastEx.name] &&
          !importedNameSet.has(lastEx.name)
        const isHandler = [
          'ArrowFunctionExpression',
          'FunctionExpression',
        ].includes(lastEx.type) || identIsHandler
        // New shape: $: fn(), handler — post-execution hook
        // First element is a CallExpression on a local function.
        const firstEx = rest.length === 1 ? rest[0] : null
        if (
          isHandler &&
          firstEx?.type === 'CallExpression' &&
          firstEx.callee?.type === 'Identifier'
        ) {
          postCallHooks.push({
            fnName: firstEx.callee.name,
            handlerRaw: raw.slice(lastEx.start, lastEx.end),
            isAsync: lastEx.async || false,
            debugName,
            nodeStart: node.start,
            nodeEnd: node.end,
          })
          continue
        }

        if (isHandler) {
          // Shape 2: $: dep, handler  or  $: (dep1, dep2), handler
          watchHandlers.push({
            deps: rest.flatMap((e) => {
              const p = memberPath(e)
              return p ? [p] : [...collectRefs(e)]
            }),
            isAsync: lastEx.async || false,
            handlerRaw: raw.slice(lastEx.start, lastEx.end),
            depsRaw: rest.map((e) => raw.slice(e.start, e.end)).join(', '),
            debugName,
            nodeStart: node.start,
            nodeEnd: node.end
          })
        } else {
          // Shape 3: $: (path1, path2)  — multi-path watch
          exprs.forEach((e) => {
            const p = memberPath(e)
            if (p)
              watchPaths.push({
                path: p,
                soft: p.includes('?.'),
                debugName,
                nodeStart: node.start,
                nodeEnd: node.end
              })
          })
        }
        continue
      }

      // Shape 4: $: path  or  $: identifier  — single path watch
      const p = memberPath(expr) || (expr.type === 'Identifier' ? expr.name : null)
      if (p) {
        watchPaths.push({
          path: p,
          soft: p.includes('?.'),
          debugName,
          nodeStart: node.start,
          nodeEnd: node.end
        })
        continue
      }

      // Shape 5: $: myVar = expr  — writable derived assignment.
      // Declares myVar as a writable signal whose value re-derives from expr
      // whenever its deps change, but can also be overridden manually.
      // myVar must not already be declared with let/const/var — the $: label
      // IS the declaration.
      if (
        expr.type === 'AssignmentExpression' &&
        expr.operator === '=' &&
        expr.left.type === 'Identifier'
      ) {
        const name = expr.left.name
        const rhsRaw = raw.slice(expr.right.start, expr.right.end)
        if (vars[name]) {
          errors.push(
            `'$: ${name} = ...' — '${name}' is already declared. ` +
            `Remove the existing let/const/var declaration.`
          )
        } else {
          vars[name] = {
            name,
            kind: 'let',
            initRaw: rhsRaw,
            initNode: expr.right,
            deps: [],
            isExport: false,
            isDerived: false,    // pass 2 will detect deps and set this
            isAsync: false,
            isProp: false,
            isWritableDerived: true,  // flag for emitter to use createWritableSignal
            nodeStart: node.start,
            nodeEnd: node.end
          }
        }
        continue
      }

      // Anything else (call expression, assignment, template literal, etc.)
      // is a $: auto-tracked side effect expression. Dependencies are detected
      // from the reactive variables referenced in the expression body.
      // The effect re-runs whenever any referenced reactive variable changes.
      effects.push({
        type: 'expression',
        raw: raw.slice(body.start, body.end),
        debugName
      })
    }
  }

  // ── Pass 2: detect deps and async ──────────────────────────────────────────
  const reactiveSet = new Set(
    Object.values(vars)
      .filter((v) => v.kind !== 'var')
      .map((v) => v.name)
  )
  // Also include imported names that have $: path watches — they are treated as
  // reactive proxy roots. A const that references them (e.g. `const style = themeNew`)
  // must be detected as derived so it gets a createMemo wrapper, not a static const.
  watchPaths.forEach((p) => {
    const root = p.path.replace(/\?\./g, '.').split('.')[0]
    if (!vars[root]) reactiveSet.add(root)  // only add imports, not local lets
  })
  for (const v of Object.values(vars)) {
    // Synthetic vars from pattern expansion have no initNode — parse initRaw instead.
    if (!v.initNode && v._syntheticInit) {
      try {
        const syntheticAst = acorn.parseExpressionAt(v._syntheticInit, 0, { ecmaVersion: 'latest' })
        v.deps = [...collectRefs(syntheticAst)].filter((r) => reactiveSet.has(r) && r !== v.name)
        v.isDerived = v.deps.length > 0
      } catch (_) {
        // unparseable synthetic — leave deps empty
      }
      continue
    }
    if (!v.initNode) continue
    const isAwait = v.initNode.type === 'AwaitExpression'
    if (isAwait) {
      v.isAsync = true
      v.deps = [...collectRefs(v.initNode.argument)].filter(
        (r) => reactiveSet.has(r) && r !== v.name
      )
    } else {
      v.deps = [...collectRefs(v.initNode)].filter((r) => reactiveSet.has(r) && r !== v.name)
    }
    v.isDerived = v.deps.length > 0
  }

  // ── Pass 3: annotate handlers and effects ──────────────────────────────────
  // effects use createEffect which auto-tracks deps at runtime — no pre-annotation needed.
  watchHandlers.forEach((h) => {
    h.reactiveDeps = h.deps.filter((d) => reactiveSet.has(d.split('.')[0]))
  })
  watchGroups.forEach((g) => {
    g.entries.forEach((entry) => {
      entry.reactiveDeps = entry.deps.filter((d) => reactiveSet.has(d.split('.')[0]))
    })
  })

  // ── Pass 4: cycle detection ────────────────────────────────────────────────
  const reported = new Set()
  const hasCycle = (name, visited = new Set(), path = []) => {
    if (visited.has(name)) {
      const key = [...path, name].sort().join('|')
      if (!reported.has(key)) {
        reported.add(key)
        errors.push(`Circular dependency: ${[...path, name].join(' → ')}`)
      }
      return
    }
    visited.add(name)
    for (const dep of vars[name]?.deps || []) hasCycle(dep, new Set(visited), [...path, name])
  }
  // ── Pass 5: $context usage validation ────────────────────────────────────
  // $context.key = expr and let/const/var x = $context.key are only valid at
  // the top level of the script block. Usage inside functions is a compiler
  // error — the compiler won't detect or wire it there.
  const findContextInBody = (node) => {
    if (!node || typeof node !== 'object') return
    if (n?.type === 'Identifier' && n.name === '$context') return true
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) { if (child.some(findContextInBody)) return true }
      else if (child && typeof child === 'object') { if (findContextInBody(child)) return true }
    }
    return false
  }
  const walkFnsForContext = (node) => {
    if (!node || typeof node !== 'object') return
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      // Walk this function's body for any $context identifier.
      const check = (n) => {
        if (!n || typeof n !== 'object') return false
        if (n.type === 'Identifier' && n.name === '$context') return true
        for (const key of Object.keys(n)) {
          if (key === 'type' || key === 'start' || key === 'end') continue
          const child = n[key]
          if (Array.isArray(child) && child.some(check)) return true
          if (child && typeof child === 'object' && check(child)) return true
        }
        return false
      }
      if (check(node.body)) {
        errors.push(
          `'$context' used inside a function or block. ` +
          `Context provides and consumes must be at the top level of the script block.`
        )
      }
      return // don't recurse further — inner functions reported independently
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) child.forEach(walkFnsForContext)
      else if (child && typeof child === 'object') walkFnsForContext(child)
    }
  }
  ast.body.forEach(walkFnsForContext)

  Object.keys(vars).forEach((n) => hasCycle(n))

  return {
    vars,
    watchPaths,
    watchHandlers,
    watchGroups,
    postCallHooks,
    effects,
    imports,
    errors,
    warnings,
    contextProvides,
    reactiveNames: [...reactiveSet],
    passthroughDeclStarts
  }
}

// ─── 5. CSS ────────────────────────────────────────────────────────────────────

// ─── CSS SCOPER ───────────────────────────────────────────────────────────────
//
// Proper tokenizer-based CSS scoper. Handles:
//   - Nested CSS rules (CSS Nesting spec)  p { &:hover {} }
//   - @layer, @container, @supports, @media — scopes rules inside, not the at-rule
//   - @keyframes, @font-face, @property — left entirely unscoped
//   - :global(selector) — strips wrapper, emits selector unscoped
//   - :global { ... } — entire block emitted unscoped
//   - :is(), :where(), :has() — commas inside () never split as selector lists
//   - Strings and comments — never confused with selectors
//   - & nesting reference — preserved, parent selector prepended in output
//
// Algorithm:
//   Walk characters tracking: string state, comment state, paren depth, brace
//   depth, and the current "selector accumulator". When we encounter `{` at
//   paren-depth 0 we have a complete selector or at-rule prelude. Push the
//   selector onto the nesting stack, scope it, emit. When we encounter `}` pop
//   the stack.
//
// Output is a single string of scoped CSS ready for injection.

// At-rules whose entire block content is NOT CSS rules — skip scoping inside.
const _OPAQUE_ATRULES = new Set([
  'keyframes', '-webkit-keyframes', '-moz-keyframes',
  'font-face', 'property', 'counter-style', 'font-palette-values',
  'page',
])

// At-rules that wrap CSS rules — scope inside them.
const _TRANSPARENT_ATRULES = new Set([
  'media', 'supports', 'layer', 'container', 'scope',
  'starting-style', 'document',
])

/**
 * Split a CSS selector list by commas, respecting nested parens.
 * "h1, :is(a, b), h3" → ["h1", ":is(a, b)", "h3"]
 */
function _splitSelectors(s) {
  const parts = []
  let depth = 0, cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(' || c === '[') { depth++; cur += c }
    else if (c === ')' || c === ']') { depth--; cur += c }
    else if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = '' }
    else cur += c
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/**
 * Scope a single selector token against the given component cssId.
 * Handles :global(), :global blocks signal (caller handles block form).
 */
function _scopeSelector(sel, cssId) {
  if (!sel) return sel

  // :global(inner) — strip wrapper, emit inner unscoped
  if (sel.includes(':global(')) {
    return sel.replace(/:global\(([^)]*)\)/g, '$1').trim()
  }

  // Already scoped
  if (sel.includes(`.${cssId}`)) return sel

  // & nesting ref — parent selector handles scoping, just keep &
  if (sel.startsWith('&')) return sel

  // Document-root selectors: :root, html, body — these target ancestors of any
  // component element, so prepending a scoped class like `.hash :root` creates
  // an impossible selector (:root can never be a descendant of .hash).
  // Emit them unscoped, exactly like :global would.
  const trimSel = sel.trim()
  if (
    trimSel === ':root' ||
    trimSel.startsWith(':root[') ||
    trimSel.startsWith(':root:') ||
    trimSel === 'html' ||
    trimSel.startsWith('html[') ||
    trimSel.startsWith('html:') ||
    trimSel === 'body' ||
    trimSel.startsWith('body ') ||
    trimSel.startsWith('body.')
  ) return sel

  return `.${cssId} ${sel}`
}

/**
 * Scope a full selector list string (may contain commas).
 * Returns the scoped selector list.
 * Returns null if this is a :global { } block opener (caller handles).
 */
function _scopeSelectorList(raw, cssId) {
  const trimmed = raw.trim()

  // :global { } block — entire block is unscoped, signal with null
  if (trimmed === ':global') return null

  const parts = _splitSelectors(trimmed)
  return parts.map(s => _scopeSelector(s, cssId)).join(', ')
}

/**
 * Core CSS tokenizer and scoper.
 * Single-pass, character-by-character. `readToken()` is the only reader —
 * advances `i` up to but NOT including the terminator char. The main loop
 * always consumes the terminator itself with `i++` after branching on it.
 */
export function scopeCSS(css, cssId) {
  let i = 0
  const len = css.length
  let out = ''

  // Stack entries: { type: 'rule'|'atrule'|'opaque'|'global', scoped: string|null }
  const stack = []

  function readComment() {
    const start = i; i += 2
    while (i < len - 1) {
      if (css[i] === '*' && css[i+1] === '/') { i += 2; break }
      i++
    }
    return css.slice(start, i)
  }

  function readString(q) {
    const start = i; i++
    while (i < len) {
      if (css[i] === '\\') { i += 2; continue }
      if (css[i] === q) { i++; break }
      i++
    }
    return css.slice(start, i)
  }

  // Read text until a terminator at paren-depth 0: '{', '}', ';'
  // Does NOT consume the terminator. Returns { text, term } where term is
  // the char at css[i] (or null if EOF).
  function readToken() {
    let text = ''
    let pd = 0  // paren depth
    while (i < len) {
      if (css[i] === '/' && css[i+1] === '*') { text += readComment(); continue }
      if (css[i] === '"' || css[i] === "'") { text += readString(css[i]); continue }
      const c = css[i]
      if (c === '(' || c === '[') { pd++; text += c; i++; continue }
      if ((c === ')' || c === ']') && pd > 0) { pd--; text += c; i++; continue }
      if (pd > 0) { text += c; i++; continue }
      if (c === '{' || c === '}' || c === ';') return { text, term: c }
      text += c; i++
    }
    return { text, term: null }
  }

  function readOpaqueBlock() {
    // i is right after the opening '{'. Read until matching '}'.
    let depth = 1, text = ''
    while (i < len && depth > 0) {
      if (css[i] === '/' && css[i+1] === '*') { text += readComment(); continue }
      if (css[i] === '"' || css[i] === "'") { text += readString(css[i]); continue }
      const c = css[i++]
      if (c === '{') { depth++; text += c }
      else if (c === '}') { depth--; if (depth > 0) text += c }
      else text += c
    }
    return text
  }

  function readGlobalBlock() {
    // Same as opaque but returns the raw unscoped text (no wrapping braces)
    return readOpaqueBlock()
  }

  // Main loop — always reads one full token + terminator per iteration
  while (i < len) {
    const { text, term } = readToken()
    const prelude = text.trim()

    if (term === null) {
      if (prelude) out += prelude
      break
    }

    if (term === ';') {
      out += text + ';'
      i++ // consume ';'
      continue
    }

    if (term === '}') {
      // Closing a block
      if (prelude) out += text  // trailing content before }
      i++ // consume '}'
      const frame = stack.pop()
      if (frame) {
        out += '}'
        if (frame.type === 'atrule' || frame.type === 'rule' || frame.type === 'inner') {
          // normal close
        }
      } else {
        // unmatched } — emit anyway
        out += '}'
      }
      continue
    }

    // term === '{' — opening a block
    i++ // consume '{'

    // Strip comments from prelude before scoping, but preserve them in output
    const commentPattern = /\/\*[\s\S]*?\*\//g
    const comments = []
    const cleanPrelude = prelude.replace(commentPattern, m => { comments.push(m); return '' }).trim()
    const commentStr = comments.join(' ')

    if (cleanPrelude.startsWith('@')) {
      const atName = cleanPrelude.slice(1).split(/[\s(]/)[0].toLowerCase()
      if (_OPAQUE_ATRULES.has(atName)) {
        const inner = readOpaqueBlock()
        out += (commentStr ? commentStr + ' ' : '') + cleanPrelude + ' {' + inner + '}'
      } else {
        out += (commentStr ? commentStr + ' ' : '') + cleanPrelude + ' {'
        stack.push({ type: 'atrule', scoped: null })
      }
      continue
    }

    if (cleanPrelude === ':global') {
      const inner = readGlobalBlock()
      out += inner
      continue
    }

    if (!cleanPrelude) {
      out += (commentStr ? commentStr + ' ' : '') + '{'
      stack.push({ type: 'inner', scoped: null })
      continue
    }

    // Regular selector — find parent frame for & expansion
    const parentFrame = stack.findLast ? stack.findLast(f => f.type === 'rule') : [...stack].reverse().find(f => f.type === 'rule')
    const parentScoped = parentFrame?.scoped ?? null

    const scoped = _scopeSelectorList(cleanPrelude, cssId)

    if (scoped === null) {
      const inner = readGlobalBlock()
      out += inner
      continue
    }

    // Handle & expansion if we have a parent scoped selector
    let finalScoped = scoped
    if (parentScoped && cleanPrelude.includes('&')) {
      finalScoped = _splitSelectors(scoped)
        .map(s => s.includes('&') ? s.replace(/&/g, parentScoped) : s)
        .join(', ')
    }

    out += (commentStr ? commentStr + ' ' : '') + finalScoped + ' {'
    stack.push({ type: 'rule', scoped: finalScoped })
  }

  return out
}

export function processCSS(ctx) {
  const { styleNodes, config } = ctx
  const cssId = config.cssGenId ? config.cssGenId() : genId()
  ctx.css = {
    id: cssId,
    result: null,
    _rules: [],
    _externalClasses: new Set(),
    passingClass: false,
    active() {
      return styleNodes.length > 0
    },
    getContent() {
      return this._rules.join('\n')
    },
    containsExternal() {
      return this._externalClasses.size > 0
    },
    isExternalClass(n) {
      return this._externalClasses.has(n)
    },
    markAsExternal(n) {
      this._externalClasses.add(n)
    },
    getClassMap() {
      return { classMap: {}, metaClass: {}, main: null }
    },
    resolveAsNode(classSet, [prefix, suffix]) {
      const id = this.id
      return xNode('css-class', { classSet, prefix, suffix, id }, (ctx, n) => {
        ctx.write(`${n.prefix}${[...n.classSet].join(' ')} ${n.id}${n.suffix}`)
      })
    },
    resolve(cls) {
      return cls.local ? `${cls.local} ${cssId}` : cssId
    },
    process() {
      if (!styleNodes.length) return
      const raw = styleNodes.map((n) => n.content).join('\n')
      this._rules.push(scopeCSS(raw, cssId))
    }
  }
}

// ─── 6. BUILDER ───────────────────────────────────────────────────────────────

export function buildRuntime() {
  const ctx = this

  // $delegate is emitted at module scope after the component function
  ctx.module.head.push(xNode('$events-noop', () => {}))

  ctx.module.head.push(
    xNode('$emit', (w) => {
      if (ctx.inuse.$emit) w.writeLine('const $emit = $runtime.makeEmitter($option);')
    })
  )

  ctx.module.head.push(
    xNode('$context-decl', (w) => {
      if (ctx.inuse.$context) w.writeLine('const $context = $runtime.$context;')
    })
  )

  // ── $.transition / $.entrance — Mesa animation namespace ─────────────────
  // $ is a thin compile-time namespace. $.transition(fn) and $.entrance(opts)
  // resolve to $runtime.transition and $runtime.entrance at the module level,
  // not per-component, so they're always accessible.
  ctx.module.head.push(
    xNode('$mesa-decl', (w) => {
      if (ctx.inuse.$mesa) {
        w.writeLine('const $ = { transition: $runtime.transition, entrance: $runtime.entrance, fade: $runtime.fade, slide: $runtime.slide, fly: $runtime.fly };')
      }
    })
  )

  // ── $context — string-keyed provide/consume ───────────────────────────────
  // contextProvide and contextRead are used at component init time.
  // Injected as locals so they're available in the component factory scope.
  ctx.module.head.push(
    xNode('$context-fns', (w) => {
      if (ctx.inuse.$contextFns) {
        w.writeLine('const $ctxProvide = $runtime.contextProvide;')
        w.writeLine('const $ctxRead    = $runtime.contextRead;')
      }
    })
  )

  // ── Declare Mesa builtins as local variables ─────────────────────────────
  // Makes $onMount, $onDestroy, $onCleanup available anywhere in the factory.
  ctx.module.head.push(
    xNode('$builtins-decl', (w) => {
      w.writeLine('const $onMount   = $runtime.$onMount;')
      w.writeLine('const $onDestroy = $runtime.$onDestroy;')
      w.writeLine('const $onCleanup = $runtime.$onCleanup;')
      if (ctx.inuse.$mounted) w.writeLine('const $mounted   = $runtime.$onMounted;')
      if (ctx.inuse.$inspect && ctx.config.debug !== false) w.writeLine('const $inspect   = $runtime.$inspect;')
    })
  )

  // ── $props — all props passed to this component (including undeclared) ───
  ctx.module.head.push(
    xNode('$props-decl', (w) => {
      if (ctx.inuse.$props) w.writeLine('const $props = $option.props ?? {};')
    })
  )

  // ── $attributes — non-prop attributes (class, style, events, attachments) ─
  // At the runtime level these live in $option.props alongside declared props.
  // Filtering out declared exports is a build-time concern; for runtime use
  // (spread to child component or DOM element) $option.props is correct.
  ctx.module.head.push(
    xNode('$attributes-decl', (w) => {
      if (ctx.inuse.$attributes) w.writeLine('const $attributes = $option.props ?? {};')
    })
  )

  const runtime = xNode.block({ scope: true })
  ctx.module.body.push(runtime)

  // ── <mesa:mounted> — gate entire template behind mount promise ────────────
  // If present, the mounted node is removed from the DOM body and the remaining
  // content is wrapped as a makeBlock content block passed to mountedBlock().
  const _mountedIdx = (ctx.DOM.body || []).findIndex(
    n => n.type === 'node' && n.name === 'mesa' && n.elArg === 'mounted'
  )
  if (_mountedIdx >= 0) {
    const mountedNode = ctx.DOM.body[_mountedIdx]

    // onerror attr — rewrite through accessors/setters so reactive vars work
    const onerrorAttr = (mountedNode.attributes || []).find(a => a.name === 'onerror')
    const onerrorExpr = onerrorAttr?.value
      ? rewriteExpr(unwrapExp(onerrorAttr.value), ctx.accessors, ctx.setters)
      : 'null'

    // mount={expr} — sync or async condition. If the resolved value is falsy,
    // the content block is never shown (no pending, no failed — just blank).
    // Can be used without a $mounted(fn) call for pure sync gating:
    //   <mesa:mounted mount={hero} />  →  show template only if hero is truthy
    const mountAttr = (mountedNode.attributes || []).find(a => a.name === 'mount')
    const mountExpr = mountAttr?.value
      ? rewriteExpr(unwrapExp(mountAttr.value), ctx.accessors, ctx.setters)
      : null

    // Static elimination: if mount={expr} is a statically-detectable falsy value
    // (literal false/0/'' or a non-exported local const with falsy literal init),
    // skip the entire mountedBlock — don't compile the template at all.
    const _FALSY_LITERALS = new Set(['false', '0', "''", '""', '``', 'null', 'undefined'])
    const _rawMountExpr = mountAttr?.value ? unwrapExp(mountAttr.value).trim() : null
    const _isStaticallyFalsy = _rawMountExpr && (() => {
      if (_FALSY_LITERALS.has(_rawMountExpr)) return true
      const v = ctx.analysis.vars?.[_rawMountExpr]
      // Only eliminate if it's a non-exported local const with falsy literal init
      return v && v.kind === 'const' && !v.isProp && !v.isDerived &&
             _FALSY_LITERALS.has(v.initRaw?.trim())
    })()

    if (_isStaticallyFalsy) {
      // Template is statically dead — emit nothing (not even a mountedBlock call)
      ctx.analysis.warnings.push(
        `<mesa:mounted mount={${_rawMountExpr}}> — expression is statically false. ` +
        `Template omitted from build output.`
      )
      return
    }

    // Co-located snippets (inside wrapping form body)
    const colocatedSnippets = (mountedNode.body || []).filter(n => n.type === 'snippet')
    const colocatedNames = new Set(colocatedSnippets.map(s => s.name))
    const hasPendingLocal = colocatedNames.has('pending')
    const hasFailedLocal  = colocatedNames.has('failed')

    // Build content body: full DOM minus the mounted node itself.
    // Co-located snippets are merged in, overriding global snippets of same name.
    const contentBody = (ctx.DOM.body || []).filter((n, i) => {
      if (i === _mountedIdx) return false // remove the mounted node
      // Remove global snippet if co-located overrides it
      if (n.type === 'snippet' && colocatedNames.has(n.name)) return false
      return true
    }).concat(colocatedSnippets) // append co-located snippets at end

    // Global snippets (in the content body after filtering)
    const finalSnippets = contentBody.filter(n => n.type === 'snippet')
    const hasPendingGlobal = !hasPendingLocal && finalSnippets.some(s => s.name === 'pending')
    const hasFailedGlobal  = !hasFailedLocal  && finalSnippets.some(s => s.name === 'failed')

    const pendingRef = (hasPendingLocal || hasPendingGlobal)
      ? '(__anchor) => $$snippet_pending(__anchor)'
      : 'null'
    const failedRef = (hasFailedLocal || hasFailedGlobal)
      ? '(__anchor, $$err) => $$snippet_failed(__anchor, $$err)'
      : 'null'

    // mountedVar — variable name of the $mounted() call (e.g. 'mounting')
    const mountedVar = ctx.analysis.mountedVar

    // Determine the promise expression:
    //   - $mounted(fn) present → use the promise variable
    //   - mount={expr} only → wrap expr in Promise.resolve() for one-shot sync gate
    //   - neither → warn and use Promise.resolve() (always shows)
    let promiseExpr
    if (mountedVar) {
      promiseExpr = mountExpr
        ? `${mountedVar}.then(v => (v && (${mountExpr})))`  // async AND sync condition
        : mountedVar
    } else if (mountExpr) {
      promiseExpr = `Promise.resolve(${mountExpr})`         // sync-only gate
    } else {
      ctx.warning({ message: 'Warning: <mesa:mounted> requires a $mounted(fn) call or mount={expr} attribute.' })
      promiseExpr = 'Promise.resolve(true)'
    }

    // Hoist snippets to runtime (outer) scope so mountedBlock can reference them
    // before the content block is mounted. Snippets must be defined at component
    // scope, not inside the makeBlock callback.
    const snippetsToHoist = contentBody.filter(n => n.type === 'snippet')
    const contentBodyNoSnippets = contentBody.filter(n => n.type !== 'snippet')

    snippetsToHoist.forEach(s => {
      runtime.push(ctx.makeSnippet(s))
    })

    // Build the content block from the filtered DOM body (no snippets — already hoisted)
    const contentDOM = { ...ctx.DOM, body: contentBodyNoSnippets }
    const contentBB = ctx.buildBlock(contentDOM, {
      inline: false,
      allowSingleBlock: false,
    })

    // Emit: mountedBlock(anchor, () => promise, pendingBlock, contentBlock, failedBlock, onerror)
    // If the promise resolves to a falsy value, contentBlock is suppressed.
    runtime.push(xNode('mounted:block', {
      block: contentBB.block,
      promiseExpr,
      pendingRef,
      failedRef,
      onerrorExpr
    }, (w, nd) => {
      w.write(true, `$runtime.mountedBlock(__anchor, () => ${nd.promiseExpr}, `)
      w.write(`${nd.pendingRef}, `)
      w.add(nd.block)
      w.write(`, ${nd.failedRef}`)
      if (nd.onerrorExpr !== 'null') w.write(`, ${nd.onerrorExpr}`)
      w.writeLine(');')
    }))

    runtime.push(
      xNode('addStyle', (w) => {
        if (!ctx.css.active()) return
        const style = ctx.css.getContent()
        if (!style) return
        if (typeof ctx.config.css === 'function') ctx.config.css(style, ctx.config.path, ctx, w)
        else if (ctx.config.css)
          w.writeLine(`$runtime.addStyles('${ctx.css.id}', \`${Q(style)}\`);`)
        else ctx.css.result = style
      })
    )
    return
  }

  const bb = ctx.buildBlock(ctx.DOM, {
    inline: true,
    allowSingleBlock: true,
    template: { name: '$parentElement', cloneNode: true }
  })

  if (bb.singleBlock) {
    runtime.push(
      xNode('attach-single', { block: bb.singleBlock, reference: bb.reference }, (w, n) => {
        if (n.reference) {
          // Component singleBlock — reference is the instVar ($$inst_0).
          // Emit as: const $$inst_0 = Component(...); then get $dom from it.
          w.add(n.block)
          w.writeLine(`let $parentElement = ${n.reference}.$dom;`)
        } else {
          w.write(true, 'let $parentElement = ')
          w.add(n.block)
          w.write('.$dom;')
        }
      })
    )
  } else {
    runtime.push(bb.template)
    runtime.push(bb.source)
  }

  runtime.push(
    xNode('addStyle', (w) => {
      if (!ctx.css.active()) return
      const style = ctx.css.getContent()
      if (!style) return
      if (typeof ctx.config.css === 'function') ctx.config.css(style, ctx.config.path, ctx, w)
      else if (ctx.config.css)
        w.writeLine(`$runtime.addStyles('${ctx.css.id}', \`${Q(style)}\`);`)
      else ctx.css.result = style
    })
  )

  runtime.push(
    xNode('return-dom', (w) => {
      w.writeLine('$runtime.append(__anchor, $parentElement);')
    })
  )
}

export function buildBlock(data, option = {}) {
  const ctx = this
  const rootTemplate = xNode.node({ inline: true })
  let rootSVG = false
  let requireFragment = option.template?.requireFragment || false
  const binds = xNode.block()
  const result = {}
  const inuseBefore = Object.assign({}, ctx.inuse)

  if (!option.parentElement) option.parentElement = '$parentElement'
  if (option.each?.blockPrefix) binds.push(option.each.blockPrefix)

  if (option.allowSingleBlock) {
    const visibleNodes = data.body.filter((n) => {
      if (n.type === 'comment' && !ctx.config.preserveComments) return false
      return true
    })
    if (visibleNodes.length === 1) {
      const n = visibleNodes[0]
      // Components must go through the full buildBlock path to get an anchor
      // comment in the template. Skip the singleBlock short-circuit for them.
      if (n.type === 'node' && n.name.match(/^[A-Z]/)) {
        // fall through to normal build path
      } else if (n.type === 'node') {
        // non-component single node — old singleBlock path intact
      }
    }
  }

  const go = (data, isRoot, tpl) => {
    let body = data.body.filter((n) => {
      if (['script', 'style', 'slot'].includes(n.type)) return false
      if (n.type === 'comment' && !ctx.config.preserveComments) return false
      if (n.type === 'fragment') {
        const f = ctx.makeFragment?.(n)
        if (f) binds.push(f)
        return false
      }
      // Extract snippets — compile them as hoisted local functions, exclude from template
      if (n.type === 'snippet') {
        ctx.localSnippetNames.add(n.name)
        // Also expose the snippet function in ctx.accessors so template *expressions*
        // (not just {@render}) can reference it by its original name.
        // e.g. {provideSlot('sidebar', sidebar)} → provideSlot('sidebar', $$snippet_sidebar)
        // Guard: only if ctx.accessors exists (set by emitScript) and the name isn't
        // already claimed by a prop/let/const accessor — those take precedence.
        if (ctx.accessors && ctx.accessors[n.name] === undefined) {
          ctx.accessors[n.name] = `$$snippet_${n.name}`
        }
        binds.push(ctx.makeSnippet(n))
        return false
      }
      return true
    })

    for (let i = 1; i < body.length; ) {
      if (body[i].type === 'text' && body[i - 1].type === 'text') {
        body[i - 1].value += body[i].value
        body.splice(i, 1)
      } else i++
    }

    if (isRoot) {
      let svg = false,
        other = false
      body.some((node) => {
        if (node.type !== 'node') return
        if (svgElements[node.name]) svg = true
        else other = true
      })
      if (svg && !other) rootSVG = true
    }

    let labelRequest = null

    const requireLabel = (final, noParent) => {
      if (labelRequest) {
        if (labelRequest.final) {
          labelRequest.set(tpl.push(xNode.nodeComment({ label: true, value: '' })))
        } else {
          if (final) labelRequest.final = true
          if (noParent) labelRequest.noParent = true
          return labelRequest
        }
      }
      labelRequest = {
        name: null,
        node: null,
        final,
        noParent,
        set(n) {
          labelRequest.name = n.bindName()
          labelRequest.node = n
          labelRequest = null
        },
        resolve() {
          if (!labelRequest.node) {
            if (labelRequest.noParent)
              labelRequest.set(tpl.push(xNode.nodeComment({ label: true, value: '' })))
            else if (isRoot) {
              labelRequest.name = tpl._boundName = option.parentElement
              labelRequest = null
            } else {
              labelRequest.name = tpl.bindName()
              labelRequest = null
            }
          }
        }
      }
      return labelRequest
    }

    body.forEach((n) => {
      if (n.type === 'text') {
        if (n.value.includes('{')) {
          const pe = ctx.parseText(n.value)
          ctx.detectDependency(pe)
          let textNode
          if (pe.staticText != null) {
            textNode = tpl.push(pe.staticText)
          } else {
            textNode = tpl.push(' ')
            // Use rewriteTextResult so reactive variable references are read through signals.
            const exp = ctx.accessors ? rewriteTextResult(pe, ctx.accessors) : pe.result
            binds.push(
              xNode('bindText', { el: textNode.bindName(), exp }, (w, nd) => {
                w.writeLine(`$runtime.bindText(${nd.el}, () => (${nd.exp}));`)
              })
            )
          }
          labelRequest?.set(textNode)
        } else {
          const _sn = tpl.push(n.value); labelRequest?.set(_sn)
        }
      } else if (n.type === 'node') {
        if (n.name === 'mesa') {
          if (n.elArg === 'boundary') {
            if (isRoot) requireFragment = true

            // Get all async-derived vars — boundary watches all $async state objects
            const asyncVars = Object.values(ctx.analysis.vars || {}).filter(v => v.isAsync)
            if (!asyncVars.length) {
              ctx.analysis.warnings.push('<mesa:boundary> has no async-derived variables to watch. Content will show immediately.')
            }

            // Co-located snippets inside <mesa:boundary> body
            const bodySnippets = (n.body || []).filter(nd => nd.type === 'snippet')
            const hasPendingLocal = bodySnippets.some(s => s.name === 'pending')
            const hasFailedLocal  = bodySnippets.some(s => s.name === 'failed')

            // Global snippets in top-level DOM body (fallback)
            const globalSnippets = (ctx.DOM.body || []).filter(nd => nd.type === 'snippet')
            const hasPendingGlobal = !hasPendingLocal && globalSnippets.some(s => s.name === 'pending')
            const hasFailedGlobal  = !hasFailedLocal  && globalSnippets.some(s => s.name === 'failed')

            // Compile co-located snippets into the outer (component) scope
            // so boundaryBlock can reference $$snippet_pending/failed as closures.
            // Guard against duplicates — two boundaries with the same co-located
            // snippet name would both try to emit `const $$snippet_pending = ...`.
            if (!ctx._hoistedBoundarySnippets) ctx._hoistedBoundarySnippets = new Set()
            bodySnippets.forEach(s => {
              if (ctx._hoistedBoundarySnippets.has(s.name)) {
                ctx.analysis.warnings.push(
                  `<mesa:boundary>: snippet '${s.name}' is already defined by another boundary. ` +
                  `Define it once as a global snippet outside all boundaries instead.`
                )
                return
              }
              ctx._hoistedBoundarySnippets.add(s.name)
              ctx.localSnippetNames.add(s.name)
              if (ctx.accessors && ctx.accessors[s.name] === undefined) {
                ctx.accessors[s.name] = `$$snippet_${s.name}`
              }
              binds.push(ctx.makeSnippet(s))
            })

            // Content = non-snippet children of <mesa:boundary>
            const contentBody = (n.body || []).filter(nd => nd.type !== 'snippet')
            const contentBlock = ctx.buildBlock({ body: contentBody }, { inline: false })

            const label = requireLabel(true, isRoot)

            const statesExpr = asyncVars.length
              ? `[${asyncVars.map(v => `$$async_${v.name}`).join(', ')}]`
              : '[]'

            const pendingRef = (hasPendingLocal || hasPendingGlobal)
              ? '(__anchor) => $$snippet_pending(__anchor)'
              : 'null'
            const failedRef = (hasFailedLocal || hasFailedGlobal)
              ? '(__anchor, $$err) => $$snippet_failed(__anchor, $$err)'
              : 'null'

            binds.push(xNode('boundary:bind',
              { label, statesExpr, block: contentBlock.block, pendingRef, failedRef },
              (w, nd) => {
                w.write(true, `$runtime.boundaryBlock(${nd.label.name}, () => (${nd.statesExpr}), `)
                w.add(nd.block)
                w.write(`, ${nd.pendingRef}`)
                w.write(`, ${nd.failedRef}`)
                w.writeLine(');')
              }
            ))
          } else if (n.elArg === 'window' || n.elArg === 'document' || n.elArg === 'body') {
            // <mesa:window> / <mesa:document> / <mesa:body>
            // on:event — add listener to the global target, cleaned up on destroy.
            // bind:prop — window-only property bindings (scrollY, innerWidth etc.)
            // These are self-closing — children are silently ignored otherwise.
            const target = n.elArg   // 'window' | 'document' | 'body'

            // Enforce self-closing: children inside these are always a mistake.
            const realChildren = (n.body || []).filter(
              c => !(c.type === 'text' && !c.value.trim())
            )
            if (realChildren.length) {
              ctx.analysis.errors.push(
                `<mesa:${target}> is self-closing and cannot have children. ` +
                `Use <mesa:${target} on:event={handler} /> (self-closing syntax).`
              )
            }
            n.attributes.forEach((p) => {
              if (p._skip) return
              const pname = p.name

              if (pname[0] === '@' || pname.startsWith('on:')) {
                const { directive, modifiers } = parseModifiers(pname)
                const event = directive.startsWith('on:') ? directive.slice(3) : directive.slice(1)
                const rawHand = p.value ? unwrapExp(p.value) : '() => {}'
                let handler = ctx.accessors ? rewriteExpr(rawHand, ctx.accessors, ctx.setters) : rawHand

                const guardMods = modifiers.filter(m =>
                  ['preventDefault','stopPropagation','self','trusted'].includes(m.name))
                if (guardMods.length) {
                  const guards = guardMods.map((g) => {
                    if (g.name === 'preventDefault')  return '$$e.preventDefault();'
                    if (g.name === 'stopPropagation') return '$$e.stopPropagation();'
                    if (g.name === 'self')    return 'if ($$e.target !== $$e.currentTarget) return;'
                    if (g.name === 'trusted') return 'if (!$$e.isTrusted) return;'
                  }).join(' ')
                  handler = `($$e) => { ${guards} (${handler})($$e); }`
                }

                binds.push(xNode('globalEvent', { target, event, handler }, (w, nd) => {
                  w.writeLine(`$runtime.addGlobalEvent('${nd.target}', '${nd.event}', ${nd.handler});`)
                }))
                return
              }

              // bind:prop — window properties only
              if (pname.startsWith('bind:')) {
                if (target !== 'window') {
                  ctx.analysis.errors.push(
                    `bind: is only supported on mesa:window, not mesa:${target}`
                  )
                  return
                }
                const prop = pname.slice(5)
                const varName = p.value ? unwrapExp(p.value) : prop
                const setter = ctx.setters?.[varName]
                if (!setter) {
                  ctx.analysis.errors.push(
                    `mesa:window bind:${prop}={${varName}} — '${varName}' must be a top-level let variable`
                  )
                  return
                }
                binds.push(xNode('windowBind', { prop, setter }, (w, nd) => {
                  w.writeLine(`$runtime.bindWindow('${nd.prop}', ${nd.setter});`)
                }))
              }
            })
            if (isRoot) requireFragment = true
          } else if (n.elArg === 'portal') {
            // <mesa:portal to={expr}>children</mesa:portal>
            // Renders children into a different DOM node (e.g. document.body).
            // Removes them on destroy. Fully reactive — if `to` changes, portal moves.
            if (isRoot) requireFragment = true
            const toProp = n.attributes.find((a) => a.name === 'to')
            const toRaw = toProp?.value ? unwrapExp(toProp.value) : 'document.body'
            const toExp = ctx.accessors ? rewriteExpr(toRaw, ctx.accessors) : toRaw
            ctx.detectDependency(toRaw)
            const portalBlock = ctx.buildBlock(n, { inline: true })
            binds.push(xNode('portal', { block: portalBlock, toExp }, (w, nd) => {
              if (nd.block.source) {
                w.write(true, `$runtime.portal(() => (${nd.toExp}), $runtime.makeBlock(`)
                w.add(nd.block.template)
                w.write(', ($parentElement) => {', true)
                w.indent++
                w.add(nd.block.source)
                w.indent--
                w.write(true, '}));', true)
              } else {
                w.write(true, `$runtime.portal(() => (${nd.toExp}), $runtime.makeBlock(`)
                w.add(nd.block.template)
                w.write('));', true)
              }
            }))
          } else if (n.elArg === 'head') {
            // <mesa:head> — render children into document.head, remove on destroy.
            // Does NOT set requireFragment because head content is not inserted into
            // the page's DOM template — it goes to document.head via addToHead().
            // Setting requireFragment here caused the page's $tpl0 to become a fragment
            // template, which broke child() traversal for single-root pages.
            //
            // Special case: <style> children are extracted and injected as raw style
            // elements — they must not go through the CSS scoper (buildBlock strips them).
            const styleChildren = (n.body ?? []).filter(c => c.type === 'style')
            const nonStyleChildren = (n.body ?? []).filter(c => c.type !== 'style')
            const nonStyleNode = { ...n, body: nonStyleChildren }

            // Emit raw <style> injections for each <style> child
            for (const styleNode of styleChildren) {
              // style nodes store their CSS in .content
              const cssText = (styleNode.content ?? '').trim()
              if (cssText) {
                binds.push(xNode('headStyle', { cssText }, (w, nd) => {
                  const escaped = nd.cssText.replace(/`/g, '\\`').replace(/\\${/g, '\\${')
                  w.write(true, `$runtime.addToHead((() => { const s = document.createElement('style'); s.textContent = \`${escaped}\`; return s; })());`, true)
                }))
              }
            }

            // Handle non-style children normally
            if (nonStyleChildren.length > 0) {
              const headBlock = ctx.buildBlock(nonStyleNode, { inline: true })
              binds.push(xNode('headBlock', { block: headBlock }, (w, nd) => {
                if (nd.block.source) {
                  w.write(true, '$runtime.addToHead($runtime.makeBlock(')
                  w.add(nd.block.template)
                  w.write(', ($parentElement) => {', true)
                  w.indent++
                  w.add(nd.block.source)
                  w.indent--
                  w.write(true, '})());', true)
                } else {
                  // nd.block.template is a $runtime.template(...) factory — call it to get DOM
                  w.write(true, '$runtime.addToHead(')
                  w.add(nd.block.template)
                  w.write('());', true)
                }
              }))
            }
          }
          return
        }

        if (n.name === 'component' || n.name.match(/^[A-Z]/)) {
          if (isRoot) requireFragment = true
          // Always push an anchor comment for component invocations — both at root
          // level (where it's the fragment anchor) and inside element templates
          // (where it becomes a comment node inside the element for append() to use).
          // Without this, non-root components resolve to the parent *element* as
          // anchor, making append(el, dom) = el.before(dom) a no-op on detached nodes.
          if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
          const label = requireLabel(true, true)  // noParent=true so resolve() also pushes if needed
          const component = ctx.makeComponent(n)
          binds.push(insertComponent(component, label))
          return
        }

        if (n.name === 'slot') {
          if (isRoot) requireFragment = true
          // Slot name comes from: <slot:name> (elArg) or <slot name="x"> (attribute)
          const nameAttr = n.attributes?.find(a => a.name === 'name')
          const slotName = n.elArg || nameAttr?.value?.replace(/^['"]|['"]$/g, '') || 'default'
          // Remove the name attribute so it doesn't appear in DOM output
          if (nameAttr) n.attributes = n.attributes.filter(a => a.name !== 'name')
          const slot = ctx.attachSlot(slotName, n)
          binds.push(
            xNode('attach-slot', { label: requireLabel(), slot }, (w, nd) => {
              w.write(
                true,
                nd.label.node
                  ? `$runtime.insertBlock(${nd.label.name}, `
                  : `$runtime.addBlock(${nd.label.name}, `
              )
              w.add(nd.slot)
              w.write(');', true)
            })
          )
          return
        }

        const el = xNode.node({ name: n.name })
        tpl.push(el)
        labelRequest?.set(el)
        n.attributes.forEach((p) => {
          if (p._skip) return

          // {…expr} spread — emit spreadAttributes(el, () => expr) at runtime
          if (p.name.startsWith('{...') && p.name.endsWith('}')) {
            const rawExpr = p.name.slice(1, -1)   // strip outer { }
            const spreadExpr = rawExpr.slice(3)   // strip leading ...
            const exp = ctx.accessors ? rewriteExpr(spreadExpr, ctx.accessors) : spreadExpr
            ctx.detectDependency(spreadExpr)
            binds.push(
              xNode('spreadAttributes', { el: el.bindName(), exp }, (w, nd) => {
                w.writeLine(`$runtime.spreadAttributes(${nd.el}, () => (${nd.exp}));`)
              })
            )
            return
          }

          const b = ctx.bindProp(p, n, el)
          if (b?.bind) binds.push(b.bind)
        })
        n.classes.forEach((c) => el.class.add(c))
        el.voidTag = n.voidTag
        if (!n.closedTag) go(n, false, el)
      } else if (n.type === 'each') {
        if (isRoot) requireFragment = true
        if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
        binds.push(ctx.makeEachBlock(n, { label: requireLabel(true, true) }).source)
      } else if (n.type === 'virtual-each') {
        // virtual-each is special: $$virtualEach() treats its anchor as the scroll
        // container element (calls parent.appendChild directly). Keep original behavior —
        // pass the parent element rather than a comment anchor.
        if (isRoot) {
          requireFragment = true
          if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
        }
        binds.push(ctx.makeVirtualEachBlock(n, { label: requireLabel(true, isRoot) }))
      } else if (n.type === 'if') {
        if (isRoot) requireFragment = true
        if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
        binds.push(ctx.makeifBlock(n, requireLabel(true, true)))
      } else if (n.type === 'key') {
        if (isRoot) requireFragment = true
        if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
        binds.push(ctx.makeKeyBlock(n, requireLabel(true, true)))
      } else if (n.type === 'await') {
        if (isRoot) requireFragment = true
        if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
        binds.push(ctx.makeAwaitBlock(n, requireLabel(true, true)))
      } else if (n.type === 'systag') {
        if (n.value.startsWith('@render ')) {
          if (isRoot) requireFragment = true
          if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
          binds.push(ctx.makeRenderTag(n, requireLabel(true, true)))
        } else if (n.value.startsWith('@html ')) {
          // {@html expr} — sets innerHTML of a placeholder text node's parent.
          // We insert a comment anchor in the template and use setInnerHTML at runtime.
          if (isRoot) requireFragment = true
          if (!tpl.getLast()) tpl.push(xNode.nodeComment({ label: true }))
          const rawExpr = n.value.slice('@html '.length).trim()
          const exp = ctx.accessors ? rewriteExpr(rawExpr, ctx.accessors) : rawExpr
          ctx.detectDependency(rawExpr)
          const label = requireLabel(true, true)
          binds.push(xNode('html-tag', { label, exp }, (w, nd) => {
            w.writeLine(`$runtime.createEffect(() => { $runtime.setInnerHTML(${nd.label.name}, ${nd.exp}); });`)
          }))
        } else if (n.value.startsWith('@const ')) {
          // {@const name = expr} — block-scoped derived constant.
          // If the expression is reactive (reads signals), wraps in createMemo so
          // the value stays current even when only the signal changes.
          // If purely derived from block-local vars (e.g. each item properties), plain const.
          // Usage: {@const total = price * qty}
          const constExpr = n.value.slice('@const '.length).trim()
          const eqIdx = constExpr.indexOf('=')
          if (eqIdx === -1) {
            ctx.analysis.errors.push(`{@const}: expected assignment form: {@const name = expr}`)
          } else {
            const constName = constExpr.slice(0, eqIdx).trim()
            const constVal  = constExpr.slice(eqIdx + 1).trim()
            const rewritten = ctx.accessors ? rewriteExpr(constVal, ctx.accessors) : constVal
            ctx.detectDependency(constVal)
            // Check if the rewritten expression contains any signal reads.
            // If so, wrap in createMemo so the const stays reactive when signals change.
            const isReactive = rewritten !== constVal  // rewriteExpr changed something
            const memoName = `$$_const_${constName}`
            if (isReactive) {
              // Register as an accessor so template reads call the memo getter
              if (ctx.accessors) ctx.accessors[constName] = `${memoName}()`
              binds.push(xNode('constTag', { constName, memoName, rewritten, isReactive }, (w, nd) => {
                w.writeLine(`const ${nd.memoName} = $runtime.createMemo(() => ${nd.rewritten});`)
                w.writeLine(`const ${nd.constName} = ${nd.memoName}();`)
              }))
            } else {
              binds.push(xNode('constTag', { constName, rewritten, isReactive }, (w, nd) => {
                w.writeLine(`const ${nd.constName} = ${nd.rewritten};`)
              }))
            }
          }
        }
        // other @directives fall through silently
      } else if (n.type === 'comment') {
        const _cn = tpl.push(n.content); labelRequest?.set(_cn)
      }
    })

    labelRequest?.resolve()
  }

  go(data, true, rootTemplate)

  let innerBlock = null
  if (binds.body.length) {
    innerBlock = xNode.block()
    if (!option.oneElement) {
      innerBlock.push(
        xNode('bindNodes', { tpl: rootTemplate, root: option.parentElement }, (w, n) => {
          // Pass 1: mark which subtrees contain bindings.
          const mark = (node) => {
            let binding = !!node._boundName
            ;(node.children || [])
              .slice()
              .reverse()
              .forEach((child) => {
                if (mark(child)) {
                  binding = true
                  node._innerBinding = true
                }
              })
            return binding
          }
          mark(n.tpl)

          // Pass 2: emit explicit let-statements for each bound node.
          //
          // Since compact mode strips inter-element whitespace from the template
          // HTML, each xNode child index maps 1-to-1 to a DOM sibling index —
          // there are no surprise whitespace text nodes between elements.
          // We advance using .firstChild / .nextSibling only as needed, deriving
          // each node's expression from the nearest preceding reference at the
          // same level. Intermediate (unbound) elements with inner bindings get
          // a cheap $$t temp variable so their children have a stable anchor.
          //
          // This completely replaces the old path-string + refer() approach.
          // Benefits: readable compiled output, no ^ climb-back, immune to the
          // whitespace desync that caused refer() to return null elements.

          const stmts = []
          let tempIdx = 0

          const walkEmit = (node, parentExpr) => {
            let cursor = null    // JS expression for the last referenced sibling
            let cursorIdx = -1  // xNode sibling index of cursor

            ;(node.children || []).forEach((child, idx) => {
              if (!child._boundName && !child._innerBinding) return

              // Build the JS expression to reach this DOM node.
              let expr
              if (cursor === null) {
                // No prior sibling reference — descend from parent then step right.
                expr = `${parentExpr}.firstChild`
                for (let k = 0; k < idx; k++) expr += '.nextSibling'
              } else {
                // Advance from the last known position.
                const steps = idx - cursorIdx
                expr = cursor
                for (let k = 0; k < steps; k++) expr += '.nextSibling'
              }

              if (child._boundName) {
                stmts.push(`let ${child._boundName} = ${expr};`)
                cursor = child._boundName
                cursorIdx = idx
              }

              if (child._innerBinding) {
                // Need a stable anchor to descend into this node's children.
                // Reuse the bound name if available; otherwise mint a temp.
                let anchor
                if (child._boundName) {
                  anchor = child._boundName
                } else {
                  anchor = `$$t${tempIdx++}`
                  stmts.push(`let ${anchor} = ${expr};`)
                  cursor = anchor
                  cursorIdx = idx
                }
                walkEmit(child, anchor)
              }
            })
          }

          const single = n.tpl.children.length === 1 && !requireFragment
          if (single) {
            const topNode = n.tpl.children[0]
            // The root IS the single element — no firstChild needed for it.
            if (topNode._boundName) stmts.push(`let ${topNode._boundName} = ${n.root};`)
            if (topNode._innerBinding) walkEmit(topNode, topNode._boundName ?? n.root)
          } else {
            // Multi-root fragment: walk the template's children directly.
            walkEmit(n.tpl, n.root)
          }

          stmts.forEach((s) => w.writeLine(s))
        })
      )
    }
    innerBlock.push(binds)
    if (option.inline) result.source = innerBlock
  } else {
    result.name = '$runtime.noop'
    result.source = null
  }

  if (!option.inline) {
    const template = xNode.template({ body: rootTemplate, svg: rootSVG, requireFragment })
    if (option.template) Object.assign(template, option.template)
    else template.inline = true

    result.block = xNode(
      'block',
      {
        $wait: [innerBlock],
        innerBlock,
        tpl: template,
        each: option.each,
        parentElement: option.parentElement
      },
      (w, n) => {
        w.write('$runtime.makeBlock(')
        w.add(n.tpl)
        if (!w.isEmpty(n.innerBlock)) {
          if (n.each) {
            w.write(`, ($parentElement, ${n.each.itemName}`)
            if (n.each.indexName) w.write(`, ${n.each.indexName}`)
            w.write(') => {', true)
          } else {
            w.write(`, ($parentElement) => {`, true)
          }
          w.indent++
          w.add(n.innerBlock)
          if (n.each?.rebind) {
            w.write(true, 'return ')
            w.add(n.each.rebind)
            w.write(';', true)
          }
          w.indent--
          w.write(true, '}')
        }
        w.write(')')
      }
    )
  } else {
    result.template = xNode.template({ body: rootTemplate, svg: rootSVG, requireFragment })
    if (option.template) Object.assign(result.template, option.template)
    else result.template.inline = true
  }

  result.inuse = {}
  for (const k in ctx.inuse) result.inuse[k] = ctx.inuse[k] - (inuseBefore[k] || 0)
  return result
}

function insertComponent(component, label) {
  return xNode(
    'insert-component',
    { makeBind: component.makeBind, label },
    (w, n) => {
      // n.label.name is the comment node from DOM traversal — used as the anchor.
      const anchorName = n.label.name
      w.add(n.makeBind(anchorName))
    }
  )
}

// ─── 7. PARTS ─────────────────────────────────────────────────────────────────

export function makeifBlock(data, label) {
  const getBlock = (b) => {
    if (b.singleBlock)
      return xNode('make-block', { block: b.singleBlock }, (w, n) => {
        w.write('() => ')
        w.add(n.block)
      })
    return b.block
  }

  const parts = []
  data.parts.forEach((part) => {
    const rx = part.value.match(/^(#if|:elif|:else\s+if)\s(.*)$/s)
    const rawExp = rx?.[2]?.trim()
    assert(rawExp, 'Wrong binding: ' + part.value)
    // Rewrite condition expression so reactive lets read through signals.
    const exp = this.accessors ? rewriteExpr(rawExp, this.accessors) : rawExp
    this.detectDependency(exp)
    parts.push({ exp, block: getBlock(this.buildBlock(part, { allowSingleBlock: true })) })
  })
  const elseBlock = data.elsePart
    ? getBlock(this.buildBlock({ body: data.elsePart }, { allowSingleBlock: true }))
    : null

  return xNode('if:bind', { label, parts, elseBlock }, (w, n) => {
    w.write(true, `$runtime.ifBlock(${n.label.name}, `)
    if (n.parts.length === 1) {
      w.write(
        n.elseBlock
          ? `() => (${n.parts[0].exp}) ? 0 : 1`
          : `() => (${n.parts[0].exp}) ? 0 : null`
      )
      w.indent++
    } else {
      w.write('() => {')
      w.indent++
      n.parts.forEach((p, i) => w.write(true, `if(${p.exp}) return ${i};`))
      if (n.elseBlock) w.write(true, `return ${n.parts.length};`)
      w.write(true, '}')
    }
    const allParts = n.elseBlock ? [...n.parts, { block: n.elseBlock }] : n.parts
    w.write(', [')
    allParts.forEach((p, i) => {
      if (i) w.write(', ')
      w.add(p.block)
    })
    w.write(']')
    w.indent--
    w.write(true)
    if (!n.label.node) w.write(', true')
    w.write(');', true)
  })
}

export function makeKeyBlock(data, label) {
  const rx = data.value.match(/^#key\s+(.+)$/s)
  assert(rx, 'Wrong #key expression: ' + data.value)
  const rawExp = rx[1].trim()
  const exp = this.accessors ? rewriteExpr(rawExp, this.accessors) : rawExp
  this.detectDependency(exp)
  const inner = this.buildBlock(data, { inline: true })

  return xNode('key:bind', { label, exp, block: inner }, (w, n) => {
    w.write(true, `$runtime.keyBlock(${n.label.name}, () => (${n.exp}), `)
    if (n.block.source) {
      w.write('$runtime.makeBlock(')
      w.add(n.block.template)
      w.write(', ($parentElement) => {', true)
      w.indent++
      w.add(n.block.source)
      w.indent--
      w.write(true, '})')
    } else {
      w.write('$runtime.makeBlock(')
      w.add(n.block.template)
      w.write(')')
    }
    if (!n.label.node) w.write(', true')
    w.write(');', true)
  })
}

// ─── {#snippet name(args)} / {@render name(args)} ─────────────────────────────

/**
 * makeSnippet — compile {#snippet name(args)}...{/snippet} to a local function.
 *
 * The snippet compiles to:
 *   const $$snippet_name = (__anchor, arg1, arg2) => {
 *     const $parentElement = $tpl_N()
 *     ... bindings ...
 *     __anchor.before($parentElement)
 *   }
 *
 * The snippet closes over reactive variables from the outer component scope.
 * Each {@render name(expr)} call mounts a fresh instance before its anchor.
 */
export function makeSnippet(data) {
  const ctx = this
  const { name, rawArgs, body } = data

  // Parse arg names (comma-separated identifiers)
  const argNames = rawArgs ? rawArgs.split(',').map(a => a.trim()).filter(Boolean) : []

  // Build as non-inline — produces result.block which is a makeBlock(tpl, fn) expression.
  // Each {@render} call invokes the block factory to get a fresh cloned DOM fragment.
  const block = ctx.buildBlock({ body }, { inline: false })

  return xNode('snippet-def', { name, argNames, block }, (w, n) => {
    const argList = ['__anchor', ...n.argNames].join(', ')
    // The block is a makeBlock(...) expression — we wrap it in a function.
    // Args are passed as plain values; reactive outer vars close over their signal getters.
    w.writeLine(`const $$snippet_${n.name} = (${argList}) => {`)
    w.indent++
    w.write(true, 'const $$frag = (')
    w.add(n.block.block)
    w.writeLine(')();')    // call makeBlock factory to get a fresh clone
    w.writeLine('__anchor.before($$frag.$dom ?? $$frag);')
    w.indent--
    w.writeLine('};')
  })
}

/**
 * makeRenderTag — compile {@render name(args)} to a snippet call.
 *
 * Resolution order:
 *   1. Local {#snippet name} → $$snippet_name(anchor, args)
 *   2. Declared variable (export let / let / const) holding a snippet function
 *      → const $$v = get($$sig_name); if ($$v) $$v(anchor, args)
 *   3. Optional-chained form name?.() → treat as (2) unconditionally
 */
export function makeRenderTag(data, label) {
  const ctx = this
  // Strip "@render " prefix
  const expr = data.value.slice('@render '.length).trim()

  // Parse: name(args) or name?.(args) or just name
  const callMatch = expr.match(/^(\w+)\s*(\??\.)?\s*\((.*)\)$/s)
  const snippetName = callMatch ? callMatch[1] : expr.replace(/\??\.\(\)$/, '').trim()
  const isOptional = expr.includes('?.')
  const rawCallArgs = callMatch ? callMatch[3].trim() : ''

  // Rewrite any reactive variable reads in the args
  const callArgs = rawCallArgs
    ? (ctx.accessors ? rewriteExpr(rawCallArgs, ctx.accessors) : rawCallArgs)
    : ''

  ctx.detectDependency(callArgs || expr)

  // Route: local snippet vs variable-held snippet
  const isLocalSnippet = ctx.localSnippetNames.has(snippetName)
  const varAccessor = !isLocalSnippet && ctx.accessors?.[snippetName]

  return xNode('render-tag', { label, snippetName, callArgs, isLocalSnippet, varAccessor, isOptional }, (w, n) => {
    if (n.isLocalSnippet) {
      // Local {#snippet} — call directly
      const allArgs = n.callArgs ? `${n.label.name}, ${n.callArgs}` : n.label.name
      w.writeLine(`$$snippet_${n.snippetName}(${allArgs});`)
    } else if (n.varAccessor) {
      // Prop or variable holding a snippet function — read the signal, then call
      const getter = n.varAccessor.endsWith('()') ? n.varAccessor : `${n.varAccessor}`
      const allArgs = n.callArgs ? `${n.label.name}, ${n.callArgs}` : n.label.name
      if (n.isOptional) {
        w.writeLine(`{ const $$sf = ${getter}; if ($$sf) $$sf(${allArgs}); }`)
      } else {
        w.writeLine(`{ const $$sf = ${getter}; $$sf(${allArgs}); }`)
      }
    } else {
      // Unknown name — assume local snippet (will fail at runtime if wrong)
      const allArgs = n.callArgs ? `${n.label.name}, ${n.callArgs}` : n.label.name
      w.writeLine(`$$snippet_${n.snippetName}?.(${allArgs});`)
    }
  })
}

export function makeEachBlock(data, option) {
  this.require('rootCD')

  const rx = data.value.match(/^#each\s+(.+)\s+as\s+(.+)$/s)
  assert(rx, `Wrong #each expression '${data.value}'`)
  const arrayName = rx[1]
  let right = rx[2]
  let keyName = null,
    keyFunction = null

  // Extract the key expression from the trailing (...) — supports nested parens
  // e.g. `item (item.id)` or `item (item.name + fn(item))`
  const keyRx = right.match(/^(.*?)\s*\((.+)\)\s*$/s)
  if (keyRx) {
    // Verify the parens are balanced — the outer () must wrap the entire key
    const candidate = keyRx[2]
    let depth = 0
    let valid = true
    for (const ch of candidate) {
      if (ch === '(') depth++
      if (ch === ')') { depth--; if (depth < 0) { valid = false; break } }
    }
    if (valid && depth === 0) {
      right = keyRx[1]
      keyName = candidate
    }
  }
  right = right.trim()

  // Detect destructuring pattern: [a, b] or {name, id}
  const isDestructure = right.startsWith('[') || right.startsWith('{')

  let itemName, indexName = null, destructurePattern = null

  if (isDestructure) {
    // Split off optional index: [a, b], idx  or  {name}, idx
    // The pattern itself may contain commas, so we find the pattern end first
    let depth = 0, patEnd = 0
    const open = right[0], close = open === '[' ? ']' : '}'
    for (let ci = 0; ci < right.length; ci++) {
      if (right[ci] === open) depth++
      else if (right[ci] === close) { depth--; if (depth === 0) { patEnd = ci + 1; break } }
    }
    destructurePattern = right.slice(0, patEnd).trim()
    // Everything after the pattern (strip leading comma/whitespace)
    const afterPat = right.slice(patEnd).trim()
    indexName = afterPat.startsWith(',') ? afterPat.slice(1).trim() || null : null
    // Use a synthetic item name; the destructure happens inside makeItem
    itemName = '$$item'
  } else {
    const rx2 = right.trim().split(/\s*,\s*/)
    assert(rx2.length <= 2, `Wrong #each expression '${data.value}'`)
    itemName = rx2[0]
    indexName = rx2[1] || null
  }

  if (keyName) {
    if (!isDestructure && keyName === itemName) {
      keyFunction = 'noop'
    } else {
      // For destructure: key expression runs after the pattern is applied.
      // We emit: ($$item, $index) => { const [a,b]=$$item; return keyExpr }
      const keyLink = isDestructure ? {} : { [itemName]: '$$item' }
      if (indexName) keyLink[indexName] = '$index'
      const keyExp0 = replaceKeyword(keyName, (n) => keyLink[n] ?? n)
      const keyExp = this.accessors ? rewriteExpr(keyExp0, this.accessors) : keyExp0
      if (isDestructure) {
        keyFunction = xNode('key-function', { exp: keyExp, pat: destructurePattern }, (w, n) => {
          w.write(`($$item, $index) => { const ${n.pat} = $$item; return ${n.exp}; }`)
        })
      } else {
        keyFunction = xNode('key-function', { exp: keyExp }, (w, n) => {
          w.write(`($$item, $index) => ${n.exp}`)
        })
      }
    }
  }

  // Rebind: called by runtime when signal value updates so pattern vars stay live.
  // For destructure patterns we rebuild the destructure assignment.
  // For plain item/index: the runtime always calls setItem/setIndex — no custom rebind needed.
  const rebind = isDestructure
    ? xNode('rebind-destruct', { pat: destructurePattern, indexName }, (w, n) => {
        if (n.indexName)
          w.write(`(_$$item, _${n.indexName}) => { const ${n.pat} = _$$item; ${n.indexName}=_${n.indexName}; }`)
        else
          w.write(`(_$$item) => { const ${n.pat} = _$$item; }`)
      })
    : null

  // Temporarily register item/index as signal-getter accessors so template
  // expressions inside the each block get rewritten correctly.
  const prevAccessors = this.accessors ? { ...this.accessors } : null
  if (this.accessors) {
    if (isDestructure) {
      // Extract all identifiers from the destructure pattern and register them
      // as passthrough (they're plain let vars inside makeItem, not signals)
      const patVars = [...destructurePattern.matchAll(/\b([a-zA-Z_$][\w$]*)\b/g)]
        .map(m => m[1])
        .filter(n => n !== 'undefined' && n !== 'null')
      patVars.forEach(n => { this.accessors[n] = n })  // passthrough — no signal wrapping
      this.accessors['$$item'] = '$$item()'
    } else {
      this.accessors[itemName] = `${itemName}()`
    }
    if (indexName) this.accessors[indexName] = `${indexName}()`
  }

  // For destructure: tell buildBlock the itemName in the block fn is $$item
  // and that the pattern vars are destructured from it at the top of the block
  const blockEachOpts = isDestructure
    ? { rebind, itemName: '$$item', indexName,
        blockPrefix: xNode('destruct-prefix', { pat: destructurePattern }, (w, n) => {
          w.writeLine(`const ${n.pat} = $$item();`)
        })
      }
    : { rebind, itemName, indexName }

  const nodeItems = trimEmptyNodes(data.mainBlock)

  const block = this.buildBlock(
    { body: nodeItems.length ? nodeItems : [data.mainBlock[0]] },
    { allowSingleBlock: !false, each: blockEachOpts }
  )

  if (prevAccessors) this.accessors = prevAccessors

  let elseBlock = null
  if (data.elseBlock) {
    const eb = this.buildBlock({ body: data.elseBlock }, { allowSingleBlock: false })
    elseBlock = eb.block
  }

  // Rewrite array expression so reactive lets read through signals.
  const rewrittenArray = this.accessors ? rewriteExpr(arrayName, this.accessors) : arrayName

  const source = xNode(
    'each',
    {
      keyFunction,
      block: block.block,
      elseBlock,
      label: option.label,
      onlyChild: option.onlyChild,
      arrayExpr: rewrittenArray
    },
    (w, n) => {
      const el = n.onlyChild ? n.label : n.label.name
      // mode=1: anchor is the container element itself (append children into it)
      // mode=0: anchor is a comment node (insert before it)
      // onlyChild: the each IS the only child of an element passed directly
      const mode = n.onlyChild ? 1 : !n.label.node ? 1 : 0
      w.writeLine(`$runtime.$$eachBlock(${el}, ${mode}, () => (${n.arrayExpr}),`)
      w.indent++
      w.write(true)
      if (n.keyFunction === 'noop') w.write('$runtime.noop')
      else if (n.keyFunction) w.add(n.keyFunction)
      else w.write('$runtime.eachDefaultKey')
      w.write(',')
      w.add(n.block)
      if (n.elseBlock) {
        w.write(', ')
        w.add(n.elseBlock)
      }
      w.indent--
      w.write(true, ');', true)
    }
  )

  this.detectDependency(arrayName)
  return { source }
}

export function makeVirtualEachBlock(data, option) {
  // {#virtual each arr as item (key)} — same as makeEachBlock but emits $$virtualEach.
  const ctx = this
  const rx = data.value.match(/^#each\s+(.+)\s+as\s+(.+)$/s)
  assert(rx, `Wrong #virtual each expression '${data.value}'`)
  const arrayName = rx[1].trim()

  // Parse asStr: strip trailing (key), then split item/index
  let right = rx[2].trim()
  let keyFunctionStr = 'null'
  const keyRx = right.match(/^(.*?)\s*\((.+)\)\s*$/s)
  if (keyRx) {
    const candidate = keyRx[2]
    let depth = 0; let valid = true
    for (const ch of candidate) {
      if (ch === '(') depth++
      if (ch === ')') { depth--; if (depth < 0) { valid = false; break } }
    }
    if (valid && depth === 0) right = keyRx[1].trim()
  }
  const parts   = right.split(/\s*,\s*/)
  const itemName  = parts[0].trim()
  const indexName = parts[1]?.trim() || null

  if (keyRx) {
    const keyExp = ctx.accessors ? rewriteExpr(keyRx[2], ctx.accessors) : keyRx[2]
    keyFunctionStr = `(${itemName}) => ${keyExp}`
  }

  const prevAccessors = ctx.accessors ? { ...ctx.accessors } : null
  // Register item (and optional index) as getter-style accessors — same as makeEachBlock
  if (ctx.accessors) {
    ctx.accessors[itemName] = `${itemName}()`
    if (indexName) ctx.accessors[indexName] = `${indexName}()`
  }

  const nodeItems = trimEmptyNodes(data.mainBlock)
  const block = ctx.buildBlock(
    { body: nodeItems.length ? nodeItems : data.mainBlock },
    { allowSingleBlock: true, each: { itemName, indexName } }
  )

  if (prevAccessors) ctx.accessors = prevAccessors

  const arrayExpr = ctx.accessors ? rewriteExpr(arrayName, ctx.accessors) : arrayName
  ctx.detectDependency(arrayName)

  return xNode('virtual-each',
    { label: option.label, arrayExpr, keyFunctionStr, block: block.block },
    (w, n) => {
      w.write(true, `$runtime.$$virtualEach(${n.label.name}, () => (${n.arrayExpr}), `)
      w.write(`${n.keyFunctionStr},`)
      w.add(n.block)
      w.writeLine(');')
    }
  )
}

export function makeAwaitBlock(data, label) {
  const rx = data.value.match(/^#await\s+(.+)$/s)
  assert(rx, 'Wrong #await expression')
  const rawExp = rx[1].trim()
  const exp = this.accessors ? rewriteExpr(rawExp, this.accessors) : rawExp
  this.detectDependency(rawExp)

  const pendingBlock = data.parts.main?.length
    ? this.buildBlock({ body: data.parts.main }, { allowSingleBlock: false }).block
    : null

  const thenValue = data.parts.thenValue?.match(/^:then\s*(.*)/s)?.[1]?.trim() || null
  const thenBlock = data.parts.then?.length
    ? this.buildBlock(
        { body: data.parts.then },
        { allowSingleBlock: false, extraArguments: thenValue ? [thenValue] : [] }
      ).block
    : null

  const catchValue = data.parts.catchValue?.match(/^:catch\s*(.*)/s)?.[1]?.trim() || null
  const catchBlock = data.parts.catch?.length
    ? this.buildBlock(
        { body: data.parts.catch },
        { allowSingleBlock: false, extraArguments: catchValue ? [catchValue] : [] }
      ).block
    : null

  return xNode(
    'await:bind',
    { label, exp, pendingBlock, thenBlock, catchBlock, thenValue, catchValue },
    (w, n) => {
      w.writeLine(`$runtime.awaitBlock(${n.label.name}, () => (${n.exp}),`)
      w.indent++
      // pendingBlock — no value passed, keep $parentElement convention (used by makeBlock)
      const pendingArgs = '($parentElement) => '
      // thenBlock/catchBlock — awaitBlock calls these as thenBlock(value), catchBlock(err)
      // so the first param IS the resolved/rejected value, not $parentElement.
      // Drop the leading $parentElement to correctly bind the value name.
      const thenArgs  = (val) => val ? `(${val}) => `  : '() => '
      const catchArgs = (val) => val ? `(${val}) => `  : '() => '
      w.write(true)
      n.pendingBlock
        ? (w.write(pendingArgs), w.add(n.pendingBlock))
        : w.write('null')
      w.write(',')
      w.write(true)
      n.thenBlock  ? (w.write(thenArgs(n.thenValue)),  w.add(n.thenBlock))  : w.write('null')
      w.write(',')
      w.write(true)
      n.catchBlock ? (w.write(catchArgs(n.catchValue)), w.add(n.catchBlock)) : w.write('null')
      w.indent--
      w.writeLine(');')
    }
  )
}

export function attachSlot(name, node) {
  const defaultBlock = node.body?.length
    ? this.buildBlock({ body: node.body }, { inline: true })
    : null
  return xNode('slot', { name, defaultBlock }, (w, n) => {
    // __block is the 3rd arg to the component fn — the slots object from caller.
    // { default: makeBlock(...), sidebar: makeBlock(...) }
    w.write(`$runtime.attachNamedSlot(__block, '${n.name}', `)
    if (n.defaultBlock) {
      w.write('$runtime.makeBlock(')
      w.add(n.defaultBlock.template)
      w.write(')')
    } else w.write('null')
    w.write(')')
  })
}

export function makeComponent(node, option = {}) {
  const ctx = this
  // If the component name is a reactive variable (derived const, let signal, etc.),
  // the call must go through its accessor to get the current component function value.
  // e.g. `const Component = entry?.component` → accessor = '$runtime.get(Component)'
  //       call site becomes: $runtime.get(Component)(anchor, props)
  const rawName = option.self ? '$$selfComponent' : node.name
  const accessor = !option.self && ctx.accessors?.[rawName]
  const componentName = (accessor && accessor !== rawName) ? accessor : rawName
  const allProps = [],
    reactiveProps = []
  const slotBlocks = [],
    attachments = []

  // ── on:event on a component is a compiler error ────────────────────────────
  // Use onclick={fn} / oninput={fn} etc. — plain callback props.
  node.attributes
    .filter((a) => (a.name[0] === '@' || a.name.startsWith('on:')) && a.type !== 'attach' && a.name !== '@attach')
    .forEach((prop) => {
      const event = prop.name.startsWith('on:') ? prop.name.slice(3) : prop.name.slice(1)
      ctx.analysis.errors.push(
        `on:${event} is not valid on a component. Use onclick={fn} (a plain callback prop) instead.`
      )
    })

  // ── Attachments ───────────────────────────────────────────────────────────
  node.attributes
    .filter((a) => a.type === 'attach' || a.name === '@attach')
    .forEach((prop) => {
      const rawExp = prop.value
      const exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
      ctx.detectDependency(rawExp)
      attachments.push(exp)
    })

  // ── bind:this — capture component instance into a let variable ───────────
  const bindThisProp = node.attributes.find((a) => a.name === 'bind:this')
  const bindThisVar = bindThisProp?.value ? unwrapExp(bindThisProp.value) : null
  const bindThisSetter = bindThisVar ? ctx.setters?.[bindThisVar] : null

  // ── Props — everything else (including onclick, oninput as plain props) ───
  // client:* attributes are build-time island directives — not runtime props.
  // {…spread} attributes are collected separately and merged via Object.assign.
  const spreadProps = []
  node.attributes
    .filter((a) => a.name[0] !== '@' && !a.name.startsWith('on:') && !a.name.startsWith('client:') && a.name !== 'this' && a.type !== 'attach' && a.name !== 'bind:this')
    .forEach((prop) => {
      if (prop.name[0] === '#') return // reference capture — handled below

      // {…expr} spread prop
      if (prop.name.startsWith('{...') && prop.name.endsWith('}')) {
        const rawExpr = prop.name.slice(1, -1)   // strip outer { }
        const spreadExpr = rawExpr.slice(3)       // strip leading ...
        const exp = ctx.accessors ? rewriteExpr(spreadExpr, ctx.accessors) : spreadExpr
        ctx.detectDependency(spreadExpr)
        spreadProps.push(exp)
        return
      }

      const ip = ctx.inspectProp(prop)
      // `class` is a reserved word — auto-rename to `$class` so the child
      // can use `export let $class = ''` or rely on the auto-declare.
      const propName = ip.name === 'class' ? '$class' : ip.name
      allProps.push({ name: propName, value: ip.value, isStatic: ip.static })
      // Non-static props need a $push effect to stay live when deps change.
      if (!ip.static) reactiveProps.push({ name: propName, value: ip.value })
    })

  // ── Slots ─────────────────────────────────────────────────────────────────
  // Split child content by slot= attribute into named slot blocks.
  // Elements/nodes with slot="name" → named slots.
  // Everything else → default slot.
  if (node.body?.length) {
    // Separate named slots from default content
    const namedSlotMap = {}  // slotName → [nodes]
    const defaultNodes = []

    for (const child of node.body) {
      // Check for slot= attribute on element nodes (Mesa AST uses type='node')
      const slotAttr = child.type === 'node' &&
        child.attributes?.find(a => a.name === 'slot')
      if (slotAttr) {
        const slotName = slotAttr.value?.replace(/^['"]|['"]$/g, '') || 'default'
        // Remove the slot= attribute from the node before building block
        child.attributes = child.attributes.filter(a => a.name !== 'slot')
        if (!namedSlotMap[slotName]) namedSlotMap[slotName] = []
        namedSlotMap[slotName].push(child)
      } else {
        defaultNodes.push(child)
      }
    }

    // Also check for <mesa:slot name="X"> wrappers (Sierra syntax)
    // These are handled by slot-rewrite.js in Sierra, but handle here too for purity

    // Emit named slot blocks
    for (const [slotName, nodes] of Object.entries(namedSlotMap)) {
      const trimmed = trimEmptyNodes(nodes)
      if (trimmed.length) {
        const block = ctx.buildBlock({ body: trimmed }, { inline: true })
        const name = slotName
        slotBlocks.push(
          xNode('named-slot', { block, name }, (w, n) => {
            w.write(true, `'${n.name}': $runtime.makeBlock(`)
            w.add(n.block.template)
            if (n.block.source) {
              w.write(', ($parentElement) => {')
              w.indent++
              w.add(n.block.source)
              w.indent--
              w.write(true, '}')
            }
            w.write(')')
          })
        )
      }
    }

    // Emit default slot block
    const trimmedDefault = trimEmptyNodes(defaultNodes)
    if (trimmedDefault.length) {
      const block = ctx.buildBlock({ body: trimmedDefault }, { inline: true })
      slotBlocks.push(
        xNode('default-slot', { block }, (w, n) => {
          w.write(true, 'default: $runtime.makeBlock(')
          w.add(n.block.template)
          if (n.block.source) {
            w.write(', ($parentElement) => {')
            w.indent++
            w.add(n.block.source)
            w.indent--
            w.write(true, '}')
          }
          w.write(')')
        })
      )
    }
  }

  // Build props object expression (static init)
  const buildPropsObj = (props, spreads) => {
    if (!props.length && !spreads.length) return '{}'
    if (spreads.length) {
      const staticObj = props.length ? `{${props.map(p => `${p.name}: ${p.value}`).join(', ')}}` : '{}'
      const parts = ['{}', ...spreads.map(s => `(${s})`), staticObj]
      return `Object.assign(${parts.join(', ')})`
    }
    return `{${props.map(p => `${p.name}: ${p.value}`).join(', ')}}`
  }

  const hasSlots    = slotBlocks.length > 0
  const hasReactive = reactiveProps.length > 0
  const hasSpreads  = spreadProps.length > 0
  const hasBindThis = !!bindThisSetter

  // makeBind(anchorName) — called by insertComponent with the template anchor var
  const makeBind = (anchorName) => xNode(
    'component',
    { anchorName, componentName, allProps, reactiveProps, spreadProps,
      slots: slotBlocks, bindThisSetter, hasSlots, hasReactive, hasSpreads, hasBindThis },
    (w, n) => {
      const propsObj = buildPropsObj(n.allProps, n.hasSpreads ? n.spreadProps : [])

      // Call: ComponentFn(anchor, props, slotsObj | null)
      if (!n.hasSlots) {
        w.writeLine(`${n.componentName}(${n.anchorName}, ${propsObj}, null);`)
      } else {
        w.write(true, `${n.componentName}(${n.anchorName}, ${propsObj}, {`)
        w.indent++
        n.slots.forEach((s, i) => { if (i) w.write(','); w.add(s) })
        w.indent--
        w.writeLine('});')
      }

      // Register anchor so pushProps can find the child's prop registry
      if (n.hasReactive || n.hasSpreads) {
        w.writeLine(`$runtime.registerComponentAnchor(${n.anchorName});`)
      }

      // bind:this
      if (n.hasBindThis) {
        w.writeLine(`${n.bindThisSetter}(${n.anchorName});`)
      }

      // Reactive prop sync: push new values whenever deps change
      if (n.hasReactive || n.hasSpreads) {
        const pushObj = buildPropsObj(n.reactiveProps, n.hasSpreads ? n.spreadProps : [])
        w.writeLine(`$runtime.createEffect(() => { $runtime.pushProps(${n.anchorName}, ${pushObj}); });`)
      }
    }
  )

  return { makeBind, reference: null }
}

export function bindProp(prop, node, element) {
  const ctx = this
  // Normalize bare HTML event attributes (onclick, onmouseenter, oninput…)
  // to Mesa's on: form so they go through the event delegation system.
  // Only applies to DOM elements — components use onclick= as a prop.
  const _rawName = prop.name
  if (/^on[a-z]/.test(_rawName) && !_rawName.startsWith('on:')) {
    prop = { ...prop, name: 'on:' + _rawName.slice(2) }
  }
  const name = prop.name

  // {@attach expr} — element-level lifecycle function
  // The expression is evaluated in a reactive effect — reruns when deps change.
  // The attachment function receives the DOM node and may return a cleanup fn.
  if (prop.type === 'attach' || name === '@attach') {
    const rawExp = prop.value
    const exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
    this.detectDependency(rawExp)
    return {
      bind: xNode('attach', { el: element.bindName(), exp }, (w, n) => {
        w.writeLine(`$runtime.attach(${n.el}, () => (${n.exp}));`)
      })
    }
  }

  // bind:group={arr} — checkbox/radio group binding.
  // For checkboxes: arr is an array signal; the element's value is added/removed on change.
  // For radios: arr is a scalar signal; set to the element's value on change.
  // The element's `value` static attribute is read at compile time for the check expression.
  if (name === 'bind:group') {
    const varName = prop.value ? unwrapExp(prop.value) : null
    if (!varName) {
      ctx.analysis.errors.push('bind:group requires a variable: bind:group={myArr}')
      return null
    }
    const setter = ctx.setters?.[varName]
    const getter = ctx.accessors?.[varName]
    if (!setter || !getter) {
      ctx.analysis.errors.push(`bind:group={${varName}} — '${varName}' must be a top-level let variable`)
      return null
    }
    // Read the static value attribute from sibling attributes
    const valAttr = node.attributes.find((a) => a.name === 'value')
    const valExp = valAttr?.value
      ? (valAttr.type === 'exp' ? unwrapExp(valAttr.raw) : `'${valAttr.value}'`)
      : 'el.value'
    const rewrittenVal = ctx.accessors ? rewriteExpr(valExp, ctx.accessors) : valExp
    return {
      bind: xNode('bindGroup', { el: element.bindName(), getter, setter, valExp: rewrittenVal }, (w, n) => {
        w.writeLine(`$runtime.bindGroup(${n.el}, () => ${n.getter}, ${n.setter}, () => (${n.valExp}));`)
      })
    }
  }

  // bind:this={varName} — capture the raw DOM element reference into a reactive var
  if (name === 'bind:this') {
    const varName = prop.value ? unwrapExp(prop.value) : null
    if (!varName) {
      ctx.analysis.errors.push('bind:this requires a variable: bind:this={myRef}')
      return null
    }
    const setter = ctx.setters?.[varName]
    if (!setter) {
      ctx.analysis.errors.push(`bind:this={${varName}} — '${varName}' must be a top-level let variable`)
      return null
    }
    return {
      bind: xNode('bindThis', { el: element.bindName(), setter }, (w, n) => {
        w.writeLine(`${n.setter}(${n.el});`)
      })
    }
  }

  // bind:attr  or  :attr  — two-way binding on a DOM element
  if (name.startsWith('bind:') || name[0] === ':') {
    const { directive, modifiers } = parseModifiers(name)
    const attr = directive.startsWith('bind:') ? directive.slice(5) : directive.slice(1)
    const varName = prop.value ? unwrapExp(prop.value) : attr
    const varEntry = ctx.analysis?.vars?.[varName]

    // Rule 22 — bind: is only valid on export let props.
    if (varEntry?.isProp && varEntry.kind !== 'let') {
      const keyword = varEntry.kind
      const reason = keyword === 'const'
        ? 'immutable prop — component cannot reassign it'
        : 'non-reactive prop — snapshot at mount, ignores parent updates'
      ctx.analysis.errors.push(
        `bind:${attr}={${varName}} — cannot two-way bind \`export ${keyword} ${varName}\` (${reason}). Use \`export let\` for two-way binding.`
      )
      return null
    }

    let getter, setter

    if (varEntry && varEntry.kind === 'let') {
      getter = `() => $runtime.get($$sig_${varName})`
      setter = `$$set_${varName}`
    } else {
      const rw = ctx.accessors ? rewriteExpr(varName, ctx.accessors) : varName
      getter = `() => (${rw})`
      setter = `($$v) => { ${varName} = $$v; }`
    }

    // bind:value|mask({"pattern"}) or bind:value|mask({reactiveExpr})
    const maskMod = attr === 'value' && modifiers.find(m => m.name === 'mask')
    if (maskMod) {
      if (!maskMod.arg) {
        ctx.analysis.errors.push(
          `bind:value|mask requires a pattern argument — e.g. bind:value|mask({"99/99/9999"})={value}`
        )
        return null
      }
      // {expr} wrapping — strip braces to get inner expression
      const isWrapped = maskMod.arg.startsWith('{') && maskMod.arg.endsWith('}')
      const innerExpr = isWrapped ? maskMod.arg.slice(1, -1).trim() : maskMod.arg
      const maskExpr  = isWrapped ? rewriteExpr(innerExpr, ctx.accessors) : maskMod.arg

      // Only wrap in createEffect if the inner expression is a known reactive variable
      const innerIsReactive = isWrapped && !!ctx.accessors?.[innerExpr]

      if (innerIsReactive) {
        return {
          bind: xNode('bindMask-reactive', { el: element.bindName(), getter, setter, maskExpr }, (w, n) => {
            w.writeLine(`$runtime.createEffect(() => { $runtime.bindMask(${n.el}, ${n.getter}, ${n.setter}, ${n.maskExpr}); });`)
          })
        }
      }
      return {
        bind: xNode('bindMask', { el: element.bindName(), getter, setter, maskExpr }, (w, n) => {
          w.writeLine(`$runtime.bindMask(${n.el}, ${n.getter}, ${n.setter}, ${n.maskExpr});`)
        })
      }
    }

    return {
      bind: xNode('bindInput', { el: element.bindName(), getter, setter, attr }, (w, n) => {
        w.writeLine(`$runtime.bindInput(${n.el}, '${n.attr}', ${n.getter}, ${n.setter});`)
      })
    }
  }

  // on:event|mod1|mod2(arg)  or  @event  (modifiers optional)
  if (name[0] === '@' || name.startsWith('on:')) {
    const { directive, modifiers } = parseModifiers(name)
    const event = directive.startsWith('on:') ? directive.slice(3) : directive.slice(1)
    const rawHand = prop.value ? unwrapExp(prop.value) : '() => {}'
    // Scan raw handler for $emit / $props / $attributes / $context / $.transition usage.
    ctx.detectDependency(rawHand)
    let handler = ctx.accessors ? rewriteExpr(rawHand, ctx.accessors, ctx.setters) : rawHand

    // Separate compile-time modifiers from runtime ones
    const listenerOpts = {}   // once, passive, capture → addEventListener options
    const wrapMods = []       // debounce, throttle → wrap handler at runtime
    const guardMods = []      // preventDefault, stopPropagation, self, trusted → inline guards

    for (const mod of modifiers) {
      switch (mod.name) {
        case 'once':    listenerOpts.once    = true; break
        case 'passive': listenerOpts.passive = true; break
        case 'capture': listenerOpts.capture = true; break
        case 'preventDefault':
        case 'stopPropagation':
        case 'self':
        case 'trusted':
          guardMods.push(mod.name); break
        case 'debounce':
        case 'throttle':
          wrapMods.push(mod); break
        default:
          ctx.analysis.errors.push(
            `Unknown event modifier '${mod.name}' on '${event}'. ` +
            `Valid: once, passive, capture, preventDefault, stopPropagation, self, trusted, debounce, throttle`
          )
      }
    }

    // Apply compile-time guard wrappers (preventDefault etc.)
    // Build the guard body then wrap: ($$e) => { guards...; handler($$e) }
    if (guardMods.length) {
      const guards = guardMods.map((g) => {
        if (g === 'preventDefault')  return '$$e.preventDefault();'
        if (g === 'stopPropagation') return '$$e.stopPropagation();'
        if (g === 'self')    return 'if ($$e.target !== $$e.currentTarget) return;'
        if (g === 'trusted') return 'if (!$$e.isTrusted) return;'
      }).join(' ')
      handler = `($$e) => { ${guards} (${handler})($$e); }`
    }

    // Apply runtime wrappers (debounce, throttle)
    for (const mod of wrapMods) {
      let msArg
      if (!mod.arg) {
        ctx.analysis.errors.push(`'${mod.name}' modifier requires a duration: |${mod.name}(300)`)
        continue
      }
      // Reactive arg: {expr} → pass as getter () => expr
      if (mod.arg.startsWith('{') && mod.arg.endsWith('}')) {
        const inner = mod.arg.slice(1, -1).trim()
        const rewritten = ctx.accessors ? rewriteExpr(inner, ctx.accessors) : inner
        ctx.detectDependency(inner)
        msArg = `() => (${rewritten})`
      } else {
        msArg = mod.arg
      }
      handler = `$runtime.${mod.name}(${handler}, ${msArg})`
    }

    const hasListenerOpts = Object.keys(listenerOpts).length > 0
    const optsStr = hasListenerOpts
      ? `, { ${Object.entries(listenerOpts).map(([k, v]) => `${k}: ${v}`).join(', ')} }`
      : ''

    // Delegate bubbling events with no special options to a single root listener.
    const canDelegate = !hasListenerOpts && wrapMods.length === 0 && !NON_DELEGATED_EVENTS.has(event)

    if (canDelegate) {
      ctx.delegatedEvents.add(event)
      return {
        bind: xNode('bindEventDelegated', { el: element.bindName(), event, handler }, (w, n) => {
          w.writeLine(`${n.el}.__${n.event} = ${n.handler};`)
        })
      }
    }

    return {
      bind: xNode('bindEvent', { el: element.bindName(), event, handler, optsStr }, (w, n) => {
        w.writeLine(`$runtime.addEvent(${n.el}, '${n.event}', ${n.handler}${n.optsStr});`)
      })
    }
  }

  // class:name={expr}
  if (name.startsWith('class:')) {
    const className = name.slice(6)
    const rawExp = prop.value ? unwrapExp(prop.value) : className
    const exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
    this.detectDependency(rawExp)
    return {
      bind: xNode('bindClass', { el: element.bindName(), className, exp }, (w, n) => {
        w.writeLine(`$runtime.bindClass(${n.el}, () => !!(${n.exp}), '${n.className}');`)
      })
    }
  }

  // style:prop={expr}
  if (name.startsWith('style:')) {
    const styleProp = name.slice(6)

    // Determine the expression for the style value.
    // Three cases:
    //   style:display          — no value, use CSS property name as boolean toggle
    //   style:color={expr}     — pure expression, unwrap directly
    //   style:font-size="{n}px" — mixed template literal, parse and rewrite
    let exp
    if (!prop.value) {
      // style:display — shorthand, toggles the property by its camelCase name
      exp = toCamelCase(styleProp)
    } else if (prop.type === 'exp' || (prop.value.startsWith('{') && prop.value.endsWith('}'))) {
      // Pure expression: style:color={expr}
      const rawExp = unwrapExp(prop.value)
      exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
      this.detectDependency(rawExp)
    } else {
      // Mixed template literal: style:font-size="{size}px"
      const pe = parseText(prop.value)
      exp = ctx.accessors ? rewriteTextResult(pe, ctx.accessors) : pe.result
      this.detectDependency(pe)
    }

    return {
      bind: xNode('bindStyle', { el: element.bindName(), styleProp, exp }, (w, n) => {
        w.writeLine(`$runtime.bindStyle(${n.el}, '${n.styleProp}', () => (${n.exp}));`)
      })
    }
  }

  // Dynamic attribute — expression or template-literal value
  if (prop.value && (prop.value.includes('{') || prop.type === 'exp')) {
    let exp
    if (prop.type === 'exp') {
      const rawExp = unwrapExp(prop.raw)
      exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
      this.detectDependency(rawExp)
    } else {
      const pe = parseText(prop.value)
      this.detectDependency(pe)
      exp = ctx.accessors ? rewriteTextResult(pe, ctx.accessors) : pe.result
    }
    return {
      bind: xNode('bindAttribute', { el: element.bindName(), name, exp }, (w, n) => {
        w.writeLine(`$runtime.bindAttribute(${n.el}, '${n.name}', () => (${n.exp}));`)
      })
    }
  }

  // Static attribute — goes straight into template HTML.
  element.attributes.push({ name: prop.name, value: prop.value })
  return null
}

export function inspectProp(prop) {
  const ctx = this
  let { name, value, type } = prop
  if (!value) return { name, value: name, static: true, mod: {} }
  if (type === 'exp') {
    const rawExp = unwrapExp(prop.raw)
    this.detectDependency(rawExp)
    const exp = ctx.accessors ? rewriteExpr(rawExp, ctx.accessors) : rawExp
    return { name, value: exp, static: false, mod: {} }
  }
  if (prop.value.includes('{')) {
    const pe = this.parseText(prop.value)
    this.detectDependency(pe)
    const result = ctx.accessors ? rewriteTextResult(pe, ctx.accessors) : pe.result
    return { name, value: result, static: false, mod: {} }
  }
  return { name, value: `\`${Q(value)}\``, static: true, mod: {} }
}

// ─── 8. EMITTER ───────────────────────────────────────────────────────────────
//
// Converts analyzeScript() results into xNode IR.
//
// The central contract with @frontierjs/mesa-runtime:
//
//   export let qty = 1    →  createSignal + makeExternalProperty
//   let count = 0         →  createSignal   ctx.accessors.count = '$$sig_count()'
//   const double = c * 2  →  createMemo     ctx.accessors.double = 'double()'
//   const MAX = 100       →  plain const    ctx.accessors.MAX unchanged
//   var snap = count      →  untrack read   no entry in accessors
//   const x = await fn(d) →  asyncDerived + makeAsyncState
//   $: dep, handler       →  createEffect with untrack wrapper
//   $: obj.path           →  watchProxy + watchPath + createEffect subscription
//   $_name: dep, handler  →  same as above, debugName stored for tooling
//
// NOT allowed (compiler errors):
//   $: { block }          →  use $: dep, () => { block }
//   $: expression         →  use $: dep, () => expression
//   $watch: / $effect:    →  removed; use $: or $_name:
//   $anyname:             →  reserved; only $: and $_name: are valid
//
// ctx.accessors is built here and then consumed by:
//   - rewriteTextResult (template text nodes)
//   - rewriteExpr (attribute/class/style/event expressions, #if conditions, #each arrays)
//   - inspectProp (component prop values)
//   - rewriteAssignments (script function bodies re-emitted at the end)

// Walk the parsed DOM body to check if $class is referenced in any attribute
// (either via auto-expanded bind:class/class shorthand, or explicit class={$class})
function _domUsesClass(body) {
  if (!body) return false
  for (const node of body) {
    if (node.type === 'node') {
      const attrs = node.attributes || []
      for (const attr of attrs) {
        if (attr.$classAuto) return true
        if (attr.value === '{$class}' || attr.value === '$class') return true
      }
      if (_domUsesClass(node.body)) return true
    } else if (node.type === 'if' || node.type === 'each' || node.type === 'key') {
      const parts = node.parts || [node]
      for (const p of parts) if (_domUsesClass(p.body)) return true
      if (_domUsesClass(node.elsePart)) return true
      if (_domUsesClass(node.elseBlock)) return true
    } else if (node.type === 'snippet') {
      if (_domUsesClass(node.body)) return true
    }
  }
  return false
}


// ─── External reactivity diagnostic ──────────────────────────────────────────
// A template read of an imported signal is only reactive if the name appears in
// the `externalSignals` map the consuming build passes. That map is
// hand-maintained and lives in a different package from the signals it
// describes, and a miss fails silently: the expression reads nothing reactive,
// so it is hoisted out of the render block and the signal object — always
// truthy — is rendered once and never updated.
//
// See EXTERNAL_REACTIVITY.md for the full failure matrix.
//
// This pass reports the high-confidence cases only: an identifier imported from
// a module that HAS an externalSignals entry, but which the entry doesn't cover.
// If the module isn't described at all we say nothing, because we genuinely
// can't tell a signal from a constant.

/** Pull expression source strings out of the template AST. */
function _collectTemplateExpressions(body, out = []) {
  if (!body || typeof body !== 'object') return out
  const nodes = Array.isArray(body) ? body : [body]
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue

    if (node.type === 'text' && typeof node.value === 'string') {
      for (const m of node.value.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
        const inner = m[1].trim()
        if (inner && !/^[#/:@]/.test(inner)) out.push(inner)
      }
    }

    for (const attr of Array.isArray(node.attributes) ? node.attributes : []) {
      if (!attr || attr.type !== 'exp' || typeof attr.value !== 'string') continue

      // Skip attributes whose value is expected to BE a function rather than a
      // value to render: event handlers and directives. `on:click={toggleTheme}`
      // reads an imported function as a value, which is correct and common —
      // warning on it would make the diagnostic noisy enough to turn off.
      const an = attr.name ?? ''
      if (/^on[:A-Za-z]/.test(an) || /^(use|attach|transition|in|out|animate|bind):/.test(an)) continue

      const inner = attr.value.replace(/^\{|\}$/g, '').trim()
      if (inner) out.push(inner)
    }

    // Block headers: "#if expr", "#each expr as x", "#key expr", ":else if expr".
    // `parts` is not always an array — some node types carry an object here, so
    // this must be guarded rather than spread.
    for (const part of Array.isArray(node.parts) ? node.parts : []) {
      if (!part || typeof part !== 'object') continue
      if (typeof part.value === 'string') {
        const m = part.value.match(/^[#:/](?:if|else if|key|await)\s+([\s\S]+)$/)
        if (m) out.push(m[1].trim())
      }
      _collectTemplateExpressions(part.body, out)
    }
    if (typeof node.value === 'string' && (node.type === 'each' || node.type === 'key' || node.type === 'await')) {
      const m = node.value.match(/^[#:/](?:each|key|await)\s+([\s\S]+?)(?:\s+as\s+[\s\S]+)?$/)
      if (m) out.push(m[1].trim())
    }

    _collectTemplateExpressions(node.body,      out)
    _collectTemplateExpressions(node.mainBlock, out)
    _collectTemplateExpressions(node.elsePart,  out)
    _collectTemplateExpressions(node.elseBlock, out)
  }
  return out
}

/**
 * Free identifiers read as VALUES in an expression.
 * Skips callee position (`fn(x)` — being called, not read), member property
 * names, and object keys.
 *
 * Returns Map<rootName, { member, paths }> where `member` is the first property
 * accessed (or null for a bare read) and `paths` is the set of full dotted
 * paths read off that root — `page.params.id` yields 'page.params.id'.
 * Computed access (`a[b]`) stops the path, since the key isn't static.
 */
function _valueReads(exprSrc) {
  let ast
  try { ast = acorn.parseExpressionAt(exprSrc, 0, { ecmaVersion: 'latest' }) }
  catch { return new Map() }

  const reads = new Map()

  // Walk up from an identifier through non-computed member access to build the
  // full static path: `page.params.id` → 'page.params.id'.
  const pathFrom = (idNode, chain) => {
    let path = idNode.name
    let depth = -1
    for (let i = chain.length - 1; i >= 0; i--) {
      const { parent, key } = chain[i]
      if (!parent || parent.type !== 'MemberExpression' || key !== 'object') break
      if (parent.computed || parent.property?.type !== 'Identifier') break
      path += '.' + parent.property.name
      depth = i
    }

    // If the member expression we ended on is itself being called —
    // `{cfg.fmt('x')}` — this is a method invocation, not a value read.
    if (depth >= 0) {
      const outer = chain[depth - 1]
      if (outer?.parent?.type === 'CallExpression' && outer.key === 'callee') return null
    }
    return path
  }

  const walk = (n, parent, key, chain) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(c => walk(c, parent, key, chain)); return }
    if (typeof n.type !== 'string') return

    if (n.type === 'Identifier') {
      const isCallee   = parent?.type === 'CallExpression' && key === 'callee'
      const isProperty = parent?.type === 'MemberExpression' && key === 'property' && !parent.computed
      const isKey      = parent?.type === 'Property' && key === 'key' && !parent.computed
      if (!isCallee && !isProperty && !isKey) {
        const member = parent?.type === 'MemberExpression' && key === 'object' && !parent.computed
          ? parent.property?.name ?? null
          : null
        const entry = reads.get(n.name) ?? { member: null, paths: new Set() }
        if (entry.member === null && member) entry.member = member
        const path = pathFrom(n, [...chain, { parent, key }])
        if (path !== null) entry.paths.add(path)
        reads.set(n.name, entry)
      }
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'raw') continue
      walk(n[k], n, k, [...chain, { parent, key }])
    }
  }
  walk(ast, null, null, [])
  return reads
}

/**
 * Warn about template reads of imported names that externalSignals doesn't
 * cover, for modules it otherwise describes.
 */
function _checkExternalReactivity(ctx, imports) {
  if (!ctx.DOM) return
  // externalSignals drives the signal tier; the path-watch tier works without it.
  const declared = ctx.config?.externalSignals ?? null

  // localName → { source, importedName, isNamespace }
  const bindings = new Map()
  for (const imp of imports) {
    const source = imp.source?.value
    if (!source) continue
    for (const spec of imp.specifiers ?? []) {
      bindings.set(spec.local.name, {
        source,
        importedName: spec.imported?.name ?? spec.local.name,
        isNamespace:  spec.type === 'ImportNamespaceSpecifier',
      })
    }
  }
  if (!bindings.size) return

  // Paths declared with `$:` in this file. A watch on a prefix counts as
  // covering everything under it: `$: page` covers `page.params.id`, and
  // `$: page.params` covers it too. Deliberately lenient — a deeper read under
  // a watched prefix is a surgical-granularity question, not a wiring bug.
  const watched = (ctx.analysis.watchPaths ?? []).map(w => w.path)
  const isWatched = (path) =>
    watched.some(w => path === w || path.startsWith(w + '.') || w.startsWith(path + '.'))

  const strict = ctx.config?.externalReactivityHints === 'strict'

  const seen = new Set()
  for (const expr of _collectTemplateExpressions(ctx.DOM.body)) {
    for (const [name, read] of _valueReads(expr)) {
      const member = read.member
      const b = bindings.get(name)
      if (!b) continue

      // ── Path-watch tier ───────────────────────────────────────────────────
      // Imported object read via member access in a template. Reactive only if
      // a `$:` declaration covers the path (§4.1). Two confidence levels:
      //
      //   default — this file already watches SOMETHING on this import, so the
      //             intent is clearly reactive and an uncovered path is an
      //             oversight.
      //   strict  — any uncovered member read. Noisy against plain imported
      //             config objects, so opt-in via
      //             `externalReactivityHints: 'strict'`. Useful while migrating
      //             external state from signals to plain objects.
      if (member) {
        // Skip names externalSignals already covers — those are signals, and
        // the accessor rewrite makes them reactive without any `$:`. Without
        // this the path tier double-reports every `{page.path}` in an app that
        // still uses the signal architecture.
        const isDeclaredSignal = declared?.[b.source]?.includes(b.importedName)
        const anyWatchOnThisRoot = watched.some(w => w === name || w.startsWith(name + '.'))
        if (!isDeclaredSignal && (anyWatchOnThisRoot || strict)) {
          for (const path of read.paths) {
            if (path === name) continue           // bare read, handled below
            if (isWatched(path)) continue
            if (seen.has(`p:${path}`)) continue
            seen.add(`p:${path}`)
            ctx.analysis.warnings.push(
              `'${path}' is read in the template but no '$: ${path}' watch covers it. ` +
              `Imported objects are inert — the read compiles to a static value and will ` +
              `not update when '${name}' mutates. Add '$: ${path}' to the script block.`
            )
          }
        }
      }

      const list = declared?.[b.source]
      if (!list) continue          // module not described — can't tell

      if (b.isNamespace) {
        // `import * as j` → `{j.connected}` is never rewritten, even when
        // `connected` is declared.
        if (member && list.includes(member) && !seen.has(`ns:${name}.${member}`)) {
          seen.add(`ns:${name}.${member}`)
          ctx.analysis.warnings.push(
            `'${name}.${member}' will not be reactive: namespace imports are not rewritten. ` +
            `Import it directly — import { ${member} } from '${b.source}'.`
          )
        }
        continue
      }

      if (!list.includes(b.importedName) && !seen.has(name)) {
        seen.add(name)
        ctx.analysis.warnings.push(
          `'${name}' is read in the template but is not declared in externalSignals ` +
          `for '${b.source}'. If it is a signal it will not be reactive — the expression ` +
          `is hoisted as static and the signal object renders as permanently truthy. ` +
          `Add '${b.importedName}' to the externalSignals entry, or ignore this if it is ` +
          `a plain value.`
        )
      }
    }
  }
}

/**
 * Is every top-level statement in this block a bare read?
 *
 * Bare reads are identifiers, member access, literals, and sequences of those.
 * Anything that can have an effect — a call, assignment, update, throw, await,
 * declaration, control flow — makes the block meaningful.
 */
function _isInertBlock(blockNode) {
  if (blockNode.body.length === 0) return true

  const isPureRead = (e) => {
    if (!e) return false
    switch (e.type) {
      case 'Identifier':
      case 'Literal':
      case 'ThisExpression':
        return true
      case 'MemberExpression':
        return isPureRead(e.object) && (e.computed ? isPureRead(e.property) : true)
      case 'ChainExpression':
        return isPureRead(e.expression)
      case 'SequenceExpression':
        return e.expressions.every(isPureRead)
      case 'ParenthesizedExpression':
        return isPureRead(e.expression)
      default:
        return false
    }
  }

  return blockNode.body.every(
    (stmt) => stmt.type === 'ExpressionStatement' && isPureRead(stmt.expression)
  )
}

export function emitScript(ctx) {
  const { vars, watchPaths, watchHandlers, watchGroups, postCallHooks, effects, imports } = ctx.analysis
  const { module: mod, script } = ctx
  const raw = script.source
  const ast = script.ast

  ctx.accessors = {} // varName  →  read expression (may include `()` call suffix)
  ctx.setters = {} // varName  →  signal setter function name

  // ── $class auto-declare ───────────────────────────────────────────────────
  // If the template uses $class (via bind:class, class shorthand, or explicit
  // class={$class}) but the script doesn't declare it, inject an implicit
  // `export let $class = ''` prop so the child needs no boilerplate.
  if (!vars['$class']) {
    const needsClass = _domUsesClass(ctx.DOM.body)
    if (needsClass) {
      vars['$class'] = {
        name: '$class', kind: 'let', isProp: true, isExport: true,
        deps: [], isDerived: false, isAsync: false, isWritableDerived: false,
        init: "''", initNode: null
      }
    }
  }

  // ── 1. Imports (passthrough) ──────────────────────────────────────────────
  imports.forEach((node) => {
    const src = raw.slice(node.start, node.end)
    // Ensure a trailing semicolon so execCompiled and hoistTemplates can
    // reliably detect and strip/skip import lines.
    mod.top.push(xNode.raw(src.trimEnd().endsWith(';') ? src : src + ';'))
  })

  // ── 1.5. External signal accessors ───────────────────────────────────────
  // For named imports from modules listed in config.externalSignals, register
  // each signal name as an accessor expression: `name` → `name.get()`
  //
  // This makes the Mesa compiler treat externally-managed signals (e.g.
  // Sierra router signals) exactly like local derived signals — any template
  // expression using them is rewritten to call .get(), which registers with
  // the reactive _listener and makes the template re-evaluate on changes.
  //
  // config.externalSignals: Record<modulePath, string[]>
  // e.g. { 'sierra/router': ['activeRoute', 'params', 'pendingRoute'] }
  //
  // Signal objects must expose a .get() method that:
  //   1. Returns the current value
  //   2. Registers with Mesa's reactive _listener when called inside an effect
  //      OR calls _listener / notifies subscribers some other way.
  //
  // Sierra signals from router/signals.js use their own pub/sub — .get() does
  // NOT register with Mesa's _listener directly. The bridge is handled by
  // wrapping them in mesa-plugin before compileSource is called (the plugin
  // replaces them with Mesa track() objects) OR by relying on the fact that
  // these expressions live inside Mesa's render()/createEffect() wrappers
  // which re-run on signal notification via the subscribe() bridge.
  if (ctx.config?.externalSignals) {
    for (const imp of imports) {
      const modulePath = imp.source.value
      const signalNames = ctx.config.externalSignals[modulePath]
      if (!signalNames) continue
      for (const spec of imp.specifiers) {
        const localName    = spec.local.name
        const importedName = spec.imported?.name ?? spec.local.name
        if (signalNames.includes(importedName)) {
          // Only register if not already claimed by a watch proxy or local var
          if (ctx.accessors[localName] === undefined) {
            ctx.accessors[localName] = `${localName}.get()`
          }
        }
      }
    }
  }

  _checkExternalReactivity(ctx, imports)

  // ── 2. Watch proxies ──────────────────────────────────────────────────────
  // Two cases:
  //   a) Imported store  — root is an import, proxy is static, one-time setup
  //   b) Local let       — root is a reactive signal, proxy must follow the
  //                        signal; when the signal is replaced the new object
  //                        must be re-proxied and all path signals re-fired.
  //
  // Template reads of `user` → `$$proxy_user` in both cases.

  const importedNames = new Set(imports.flatMap((imp) =>
    imp.specifiers.map((s) => s.local.name)
  ))

  // Paths that need a proxy + watchPath signal. Both `$: obj.path` (a bare
  // watch) and `$: obj.path, handler` (a watch with a body) depend on the same
  // registration — without it the dep compiles to a plain read of an inert
  // object and the handler never fires. Only the bare form was collected here,
  // so `$: cart.total, () => sync()` silently did nothing even though §4.3
  // documents it.
  //
  // Only DOTTED deps are added from handlers. A bare identifier dep (`$: a,
  // () => f()`) is already served by reading its signal, and registering a
  // proxy for it would change its accessor from `$runtime.get($$sig_a)` to
  // `$$proxy_a` — which is the deep-watch opt-in that only the bare `$: a` form
  // should trigger.
  const watchedPaths = [
    ...watchPaths.map((p) => p.path),
    ...watchHandlers.flatMap((wh) => wh.deps.filter((d) => d.includes('.'))),
  ]

  const proxyRoots = new Set(
    watchedPaths.map((path) => path.replace(/\?\.|\./g, '.').split('.')[0])
  )

  // Split into local-let roots and import roots
  const localProxyRoots = new Set(
    [...proxyRoots].filter((r) => vars[r]?.kind === 'let' && !vars[r]?.isProp)
  )
  // importProxyRoots = everything that's not a local let AND not a local const/var
  // Local const/var variables (e.g. `const c = { connected }`) must be excluded here
  // because their proxy needs to be emitted AFTER the variable is declared in mod.code,
  // not in mod.head where the variable doesn't exist yet (TDZ crash).
  const localVarRoots = new Set(
    [...proxyRoots].filter((r) => vars[r] && !vars[r].isProp)
  )
  const importProxyRoots = new Set(
    [...proxyRoots].filter((r) => !localProxyRoots.has(r) && !localVarRoots.has(r))
  )

  // Imported store proxies — static, set up once
  importProxyRoots.forEach((root) => {
    mod.head.push(xNode.raw(`const $$proxy_${root} = $runtime.watchProxy(${root});`))
    ctx.accessors[root] = `$$proxy_${root}`
  })

  // Warn about redundant path watches: if $: obj is declared alongside $: obj.prop,
  // the property watch is completely subsumed and can be removed.
  // Group declared paths by root and check for root+child conflicts.
  {
    const declaredByRoot = {}  // root → Set of dotPaths
    watchPaths.forEach((p) => {
      const norm = p.path.replace(/\?\./g, '.')
      const dotIdx = norm.indexOf('.')
      const root    = dotIdx >= 0 ? norm.slice(0, dotIdx) : norm
      const dotPath = dotIdx >= 0 ? norm.slice(dotIdx + 1) : ''
      if (!declaredByRoot[root]) declaredByRoot[root] = new Set()
      declaredByRoot[root].add(dotPath)
    })
    for (const [root, paths] of Object.entries(declaredByRoot)) {
      if (paths.has('')) {
        // Whole-object watch declared. Any specific dotPath is redundant.
        const redundant = [...paths].filter(p => p !== '')
        redundant.forEach(dotPath => {
          ctx.analysis.warnings.push(
            `'$: ${root}.${dotPath}' is redundant because '$: ${root}' already watches the entire object. ` +
            `Remove '$: ${root}.${dotPath}'.`
          )
        })
      }
    }
  }

  // One watchPath signal per unique (root, dotPath) pair.
  const watchSigVars = []
  const seenPaths = new Set()

  watchedPaths.forEach((rawPath) => {
    const p = { path: rawPath }
    const normalised = p.path.replace(/\?\./g, '.')
    const dotIdx = normalised.indexOf('.')
    const root = dotIdx >= 0 ? normalised.slice(0, dotIdx) : normalised
    const dotPath = dotIdx >= 0 ? normalised.slice(dotIdx + 1) : ''
    const key = `${root}::${dotPath}`
    if (seenPaths.has(key)) return
    seenPaths.add(key)

    const sigVar = dotPath
      ? `$$watch_${root}_${dotPath.replace(/\./g, '_')}`
      : `$$watch_${root}`

    if (importProxyRoots.has(root)) {
      // Static proxy — watchPath against the import directly.
      // For whole-object watches (dotPath === '') also capture the write function
      // so self-assignment `root = root` can be rewritten to force a refresh.
      if (dotPath === '') {
        const fireVar = `$$fire_${root}`
        mod.head.push(xNode.raw(`const [${sigVar}, ${fireVar}] = $runtime.watchPath(${root}, '${dotPath}');`))
        ctx.proxyFireFns = ctx.proxyFireFns || {}
        ctx.proxyFireFns[root] = fireVar
      } else {
        mod.head.push(xNode.raw(`const [${sigVar}] = $runtime.watchPath(${root}, '${dotPath}');`))
      }
      watchSigVars.push(sigVar)
    }
    // Local let roots handled below after signal emission (step 5 runs first for locals,
    // but we collect the path metadata here so step 5 can emit the re-proxy logic).
  })

  if (watchSigVars.length) {
    mod.head.push(
      xNode.raw(
        `$runtime.createEffect(() => { ${watchSigVars.map((s) => `${s}();`).join(' ')} });`
      )
    )
  }

  // For local let roots: register path metadata so step 5 can emit re-proxy logic
  // after the signal is created.
  const localProxyPaths = {}   // root → [{ dotPath, sigVar }]
  watchedPaths.forEach((rawPath) => {
    const p = { path: rawPath }
    const normalised = p.path.replace(/\?\./g, '.')
    const dotIdx = normalised.indexOf('.')
    const root = dotIdx >= 0 ? normalised.slice(0, dotIdx) : normalised
    if (!localProxyRoots.has(root)) return
    const dotPath = dotIdx >= 0 ? normalised.slice(dotIdx + 1) : ''
    const key = `${root}::${dotPath}`
    if (!localProxyPaths[root]) localProxyPaths[root] = []
    if (!localProxyPaths[root].find((e) => e.key === key)) {
      const sigVar = dotPath
        ? `$$watch_${root}_${dotPath.replace(/\./g, '_')}`
        : `$$watch_${root}`
      localProxyPaths[root].push({ key, dotPath, sigVar })
    }
  })

  // For local const/var roots: collect paths so we can emit proxy setup
  // in mod.code after the variable declaration (avoids TDZ crash).
  const localVarProxyPaths = {}  // root → [{ dotPath, sigVar, fireVar }]
  watchedPaths.forEach((rawPath) => {
    const p = { path: rawPath }
    const normalised = p.path.replace(/\?\./g, '.')
    const dotIdx = normalised.indexOf('.')
    const root = dotIdx >= 0 ? normalised.slice(0, dotIdx) : normalised
    if (!localVarRoots.has(root)) return
    const dotPath = dotIdx >= 0 ? normalised.slice(dotIdx + 1) : ''
    const key = `${root}::${dotPath}`
    if (!localVarProxyPaths[root]) localVarProxyPaths[root] = []
    if (!localVarProxyPaths[root].find((e) => e.key === key)) {
      const sigVar  = dotPath ? `$$watch_${root}_${dotPath.replace(/\./g, '_')}` : `$$watch_${root}`
      const fireVar = dotPath ? null : `$$fire_${root}`
      localVarProxyPaths[root].push({ key, dotPath, sigVar, fireVar })
    }
  })

  // Expose localProxyPaths on ctx so step 5 can consume it
  ctx.localProxyPaths = localProxyPaths
  // Expose localVarProxyPaths on ctx so step 5 can emit proxy setup after const/var decls
  ctx.localVarProxyPaths = localVarProxyPaths

  // ── 3. Props (export let) — reactive, two-way bindable ────────────────────
  // Props are declared in mod.head so they're available for dependency sorting.
  // However, if a prop's default expression references reactive vars (signals,
  // memos) those don't exist yet at mod.head time — they're emitted in mod.code.
  // Solution: declare the signal with the parent value (or undefined) in head,
  // then apply the default lazily in code via untrack() after all vars exist.
  const props = Object.values(vars).filter((v) => v.isProp && v.kind === 'let')
  // Collect deferred defaults keyed by var name — emitted in step 5 after topoSort
  const deferredPropDefaults = {}

  props.forEach((v) => {
    const sigR = `$$sig_${v.name}`,
      sigW = `$$set_${v.name}`

    // Detect if the default references any reactive variable — if so it can't
    // be evaluated in mod.head (those vars don't exist yet).
    let hasReactiveDeps = false
    if (v.initRaw && v.initNode) {
      const defaultRefs = [...collectRefs(v.initNode)]
      hasReactiveDeps = defaultRefs.some((r) => ctx.analysis.reactiveNames?.includes(r))
    }

    if (!hasReactiveDeps) {
      // Simple default — safe to inline in head.
      const defaultExpr = v.initRaw ? rewriteExpr(v.initRaw, ctx.accessors) : 'undefined'
      mod.head.push(
        xNode.raw(
          `const ${sigR} = $runtime.track($option.props?.${v.name} !== undefined ? $option.props.${v.name} : ${defaultExpr}, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`
        )
      )
    } else {
      // Reactive default — declare signal with parent value (or undefined) in head.
      // The deferred default is pushed in step 5 after all vars/memos are emitted.
      mod.head.push(
        xNode.raw(
          `const ${sigR} = $runtime.track($option.props?.${v.name}, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`
        )
      )
      deferredPropDefaults[v.name] = { sigW, initRaw: v.initRaw }
    }

    // Register with the component instance so $push/$apply work end-to-end.
    mod.head.push(xNode.raw(`$runtime.makeExternalProperty('${v.name}', ${sigR}, ${sigW});`))
    if (ctx.config?.dev) {
      mod.head.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'prop');`))
    }
    ctx.accessors[v.name] = `$runtime.get(${sigR})`
    ctx.setters[v.name] = sigW
  })

  // export const props — immutable, passed in at mount, compiler-enforced read-only.
  Object.values(vars)
    .filter((v) => v.isProp && v.kind === 'const')
    .forEach((v) => {
      mod.head.push(
        xNode.raw(
          `const ${v.name} = $option.props?.${v.name} !== undefined ? $option.props.${
            v.name
          } : (${v.initRaw ?? 'undefined'});`
        )
      )
      // Static accessor — reads as the plain variable name (no signal wrapper).
    })

  // export var props — snapshot at mount, frozen thereafter, no signal.
  Object.values(vars)
    .filter((v) => v.isProp && v.kind === 'var')
    .forEach((v) => {
      mod.head.push(
        xNode.raw(
          `let ${v.name} = $option.props?.${v.name} !== undefined ? $option.props.${
            v.name
          } : (${v.initRaw ?? 'undefined'});`
        )
      )
    })

  // ── 4. $async container ───────────────────────────────────────────────────
  const asyncVars = Object.values(vars).filter((v) => v.isAsync)
  if (asyncVars.length) {
    mod.code.push(xNode.raw(`const $async = {};`))
  }

  // ── 5. Variables (topologically sorted, props already emitted) ────────────
  const nonPropVars = Object.values(vars).filter((v) => !v.isProp)
  const sorted = topoSort(nonPropVars)

  sorted.forEach((v) => {
    const init = v.initRaw ?? 'undefined'

    if (v.kind === 'var') {
      // Non-reactive sampler — read reactive values at init time without subscribing.
      // Special case: var name = $context.key — snapshot the context value at mount.
      if (v.isContextConsume) {
        mod.code.push(xNode.raw(
          `let ${v.name} = $runtime.untrack(() => { const $$g = $ctxRead('${v.contextKey}'); return $$g ? $$g() : undefined; });`
        ))
        // Not reactive — no accessor entry
      } else {
        const rewrittenInit = rewriteExpr(init, ctx.accessors)
        mod.code.push(xNode.raw(`let ${v.name} = $runtime.untrack(() => (${rewrittenInit}));`))
      }
      // var stays as a plain variable — no accessor entry needed.
    } else if (v.name === ctx.analysis.mountedVar) {
      // $mounted(fn) return value — plain const Promise, never reactive.
      // Apply assignment rewrite so `user = x` inside the async fn becomes `$$set_user(x)`.
      const rewritten = rewriteExpr(rewriteAssignments(init, v.initNode, ctx), ctx.accessors)
      mod.code.push(xNode.raw(`const ${v.name} = ${rewritten};`))
      // No accessor — this is a Promise, not a signal. mountedBlock reads it directly.
    } else if (v.kind === 'const' && v.isContextConsume) {
      // const name = $context.key — read-only derived from context.
      mod.code.push(xNode.raw(
        `const ${v.name} = $runtime.trackDerived(() => { const $g = $ctxRead('${v.contextKey}'); return $g ? $g() : undefined; }, void 0, void 0, __block);`
      ))
      if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${v.name}, '${v.name}', 'derived-context');`))
      ctx.accessors[v.name] = `$runtime.get(${v.name})`
    } else if (v.kind === 'const' && v.isAsync && v.isDerived) {
      // Async derived const — reruns when deps change, cancels in-flight requests.
      // The result is stored as a signal so template bindings re-run when it resolves.
      const sigR = `$$sig_${v.name}`,
        sigW = `$$set_${v.name}`
      mod.code.push(xNode.raw(`const ${sigR} = $runtime.track(undefined, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`))
      ctx.accessors[v.name] = `$runtime.get(${sigR})`
      const stateVar = `$$async_${v.name}`
      mod.code.push(xNode.raw(`const ${stateVar} = $runtime.makeAsyncState();`))
      mod.code.push(xNode.raw(`$async.${v.name} = ${stateVar};`))
      // Dep array: signal function references (strip trailing () to get the fn).
      const depFns = v.deps
        .map((dep) => {
          const acc = ctx.accessors[dep]
          if (!acc) return `() => ${dep}`
          // memo/computed: acc ends with '()' → strip to get the fn reference
          if (acc.endsWith('()')) return acc.slice(0, -2)
          // signal getter: e.g. '$runtime.get($$sig_x)' → wrap in arrow fn
          return `() => ${acc}`
        })
        .join(', ')
      // Use the await argument (not the full await expr) so rewriteExpr can parse it.
      const argRaw =
        v.initNode?.type === 'AwaitExpression'
          ? raw.slice(v.initNode.argument.start, v.initNode.argument.end)
          : init
      const rewrittenArg = rewriteExpr(argRaw, ctx.accessors)
      mod.code.push(
        xNode.raw(
          `$runtime.asyncDerived(() => ${stateVar}, async ($$signal) => (${rewrittenArg}), [${depFns}], ${sigW});`
        )
      )
      if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'async-derived');`))
    } else if (v.kind === 'const' && v.isAsync) {
      // One-shot async const — runs once at init, no reactive deps.
      // Result is also a signal so the template updates when the fetch completes.
      const sigR = `$$sig_${v.name}`,
        sigW = `$$set_${v.name}`
      mod.code.push(xNode.raw(`const ${sigR} = $runtime.track(undefined, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`))
      ctx.accessors[v.name] = `$runtime.get(${sigR})`
      const stateVar = `$$async_${v.name}`
      mod.code.push(xNode.raw(`const ${stateVar} = $runtime.makeAsyncState();`))
      mod.code.push(xNode.raw(`$async.${v.name} = ${stateVar};`))
      const argRaw =
        v.initNode?.type === 'AwaitExpression'
          ? raw.slice(v.initNode.argument.start, v.initNode.argument.end)
          : init
      const rewrittenArg = rewriteExpr(argRaw, ctx.accessors)
      mod.code.push(
        xNode.raw(
          `(async () => { try { ${stateVar}._update('start'); ${sigW}(await (${rewrittenArg})); ${stateVar}._update('done'); } catch($$e) { ${stateVar}._update('error', $$e); } })();`
        )
      )
      if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'async');`))
    } else if (v.kind === 'const' && v.isDerived) {
      // Derived const — createMemo so it recomputes lazily when any dep changes.
      const rewrittenInit = rewriteExpr(init, ctx.accessors)
      mod.code.push(xNode.raw(`const ${v.name} = $runtime.trackDerived(() => (${rewrittenInit}), void 0, void 0, __block);`))
      if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${v.name}, '${v.name}', 'derived');`))
      ctx.accessors[v.name] = `$runtime.get(${v.name})`
    } else if (v.kind === 'const') {
      // Static const — no reactive wrapper, emitted as-is.
      mod.code.push(xNode.raw(`const ${v.name} = ${init};`))
      // No accessor entry — template references the plain name directly.

      // If this const has $: path watches, emit the proxy setup HERE (after the
      // declaration) to avoid TDZ crash. These are simple static proxies — no
      // re-proxy effect needed since const can't be reassigned.
      const varPaths = ctx.localVarProxyPaths?.[v.name]
      if (varPaths?.length) {
        mod.code.push(xNode.raw(`const $$proxy_${v.name} = $runtime.watchProxy(${v.name});`))
        ctx.accessors[v.name] = `$$proxy_${v.name}`
        varPaths.forEach(({ sigVar, fireVar, dotPath }) => {
          if (fireVar) {
            mod.code.push(xNode.raw(`const [${sigVar}, ${fireVar}] = $runtime.watchPath(${v.name}, '${dotPath}');`))
          } else {
            mod.code.push(xNode.raw(`const [${sigVar}] = $runtime.watchPath(${v.name}, '${dotPath}');`))
          }
        })
        const sigVars = varPaths.map(({ sigVar }) => sigVar)
        mod.code.push(xNode.raw(
          `$runtime.createEffect(() => { ${sigVars.map(s => `${s}();`).join(' ')} });`
        ))
      }
    } else if (v.kind === 'let') {
      const sigR = `$$sig_${v.name}`,
        sigW = `$$set_${v.name}`

      if (v.isContextConsume) {
        // let name = $context.key — writable derived seeded from context.
        // Re-derives when the provider's signal changes, but can be locally overridden.
        mod.code.push(xNode.raw(
          `const ${sigR} = $runtime.trackDerived(() => { const $g = $ctxRead('${v.contextKey}'); return $g ? $g() : undefined; }, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`
        ))
        if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'let-context');`))
      } else if (v.isWritableDerived) {
        // $: myVar = expr — writable derived signal.
        // Re-derives when deps change, but can be overridden manually.
        // Uses createWritableSignal so that set() is not a no-op.
        const rewrittenInit = rewriteExpr(init, ctx.accessors)
        mod.code.push(
          xNode.raw(`const [${sigR}, ${sigW}] = $runtime.createWritableSignal(() => (${rewrittenInit}));`)
        )
        if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'writable-derived');`))
      } else {
        // Plain let — snapshot at init, independent thereafter.
        const rewrittenInit = rewriteExpr(init, ctx.accessors)
        mod.code.push(xNode.raw(`const ${sigR} = $runtime.track(${rewrittenInit}, void 0, void 0, __block);\nconst ${sigW} = (v) => $runtime.set(${sigR}, v);`))
        if (ctx.config?.dev) mod.code.push(xNode.raw(`$runtime.__dev?.r(${sigR}, '${v.name}', 'let');`))
      }

      ctx.accessors[v.name] = `$runtime.get(${sigR})`
      ctx.setters[v.name] = sigW

      // Option B — local let with $: path watches.
      // Create standalone signals per path (keyed to variable, not object).
      // localWatchProxy calls readFn() on property access (subscribing the
      // current effect) and fireFn() on mutation (notifying subscribers).
      // When the signal is replaced, re-proxy the new object with the SAME
      // signal pairs so existing subscriptions stay live.
      const paths = ctx.localProxyPaths?.[v.name]
      if (paths?.length) {
        // Standalone signal per watched path — always-notify equality
        const pathDecls = paths.map(({ sigVar, dotPath }) =>
          `const ${sigVar} = $runtime.track(undefined, void 0, void 0, __block, true);\nconst $fire_${v.name}_${sigVar} = () => $runtime.set(${sigVar}, undefined);`
        ).join('\n')
        mod.code.push(xNode.raw(pathDecls))

        // signalMap: dotPath → [readFn, fireFn]
        const signalMapEntries = paths.map(({ sigVar, dotPath }) =>
          `'${dotPath}': [${sigVar}, $fire_${v.name}_${sigVar}]`
        ).join(', ')

        // Mutable proxy variable — re-assigned on signal replacement
        mod.code.push(xNode.raw(
          `let $$proxy_${v.name} = $runtime.localWatchProxy($runtime.get(${sigR}), { ${signalMapEntries} });`
        ))
        ctx.accessors[v.name] = `$$proxy_${v.name}`

        // Register the whole-object fire fn so rewriteAssignments can rewrite
        // self-assignments (`connectedArr = connectedArr`) inside watch+handler
        // bodies and regular functions the same way.
        const wholePath = paths.find(({ dotPath }) => dotPath === '')
        if (wholePath) {
          ctx.proxyFireFns = ctx.proxyFireFns || {}
          ctx.proxyFireFns[v.name] = `$fire_${v.name}_${wholePath.sigVar}`
        }

        // Re-proxy effect: runs when the let signal is replaced.
        const fireCalls = paths.map(({ sigVar }) =>
          `$fire_${v.name}_${sigVar}();`
        ).join(' ')
        mod.code.push(xNode.raw(
          `$runtime.createEffect(() => {` +
          ` const $$obj = $runtime.get(${sigR});` +
          ` $$proxy_${v.name} = $runtime.localWatchProxy($$obj, { ${signalMapEntries} });` +
          ` ${fireCalls}` +
          ` });`
        ))
      }
    }
  })

  // ── 5b. Deferred prop defaults ────────────────────────────────────────────
  // Props whose defaults reference reactive vars are set here, after all
  // vars/memos have been emitted. Wrapped in untrack so reading the default
  // expression doesn't create a subscription on the prop's own signal.
  Object.entries(deferredPropDefaults).forEach(([name, { sigW, initRaw }]) => {
    const defaultExpr = rewriteExpr(initRaw, ctx.accessors)
    mod.code.push(
      xNode.raw(
        `if ($option.props?.${name} === undefined) ${sigW}($runtime.untrack(() => (${defaultExpr})));`
      )
    )
  })

  // ── 5c. Context provides ─────────────────────────────────────────────────
  // $context.key = expr  — emitted after all vars so reactive expressions resolve.
  // Each provide wraps the expression in a getter so consumers auto-subscribe
  // when they call it inside a reactive scope.
  ctx.analysis.contextProvides.forEach(({ key, initRaw }) => {
    const rewritten = rewriteExpr(initRaw, ctx.accessors)
    // If the rewritten expression is a signal read (ends with ()), expose it
    // directly as the getter. Otherwise wrap in a memo so it's reactive.
    const isSigRead = /^\$\$sig_\w+\(\)$/.test(rewritten.trim())
    if (isSigRead) {
      // Plain signal — extract the getter function (strip the ())
      const sigFn = rewritten.trim().slice(0, -2)
      mod.code.push(xNode.raw(`$ctxProvide('${key}', ${sigFn});`))
    } else {
      // Derived expression — wrap in a memo so descendants stay reactive
      const memo = `$$ctxMemo_${key}`
      mod.code.push(xNode.raw(`const ${memo} = $runtime.createMemo(() => (${rewritten}));`))
      mod.code.push(xNode.raw(`$ctxProvide('${key}', ${memo});`))
    }
  })

  // ── 6. $: effects — auto-tracked expression and block side effects ──────────
  // $: expr       — re-runs when any reactive variable read inside it changes
  // $: { block }  — same, multi-statement form
  // Dependencies are tracked automatically at runtime via the reactive graph.
  ctx.analysis.effects.forEach((ef) => {
    const rewritten = rewriteExpr(ef.raw, ctx.accessors)
    if (ef.type === 'expression') {
      mod.code.push(xNode.raw(`$runtime.createEffect(() => { ${rewritten}; }, { user: true });`))
    } else {
      // block — raw already includes the { }
      mod.code.push(xNode.raw(`$runtime.createEffect(() => ${rewritten}, { user: true });`))
    }
  })

  // ── 7. $: watch + handler ─────────────────────────────────────────────────
  // Pattern: read each dep to subscribe, then run the handler untracked so
  // the handler body itself doesn't accidentally add extra subscriptions.
  watchHandlers.forEach((wh, whIdx) => {
    // Each dep needs two expressions:
    //   subscribe — what to read so the effect is notified
    //   value     — what the handler should receive
    // For a local signal these are the same. For a path on a proxied import
    // they are NOT: the watch signal is a bare change notification carrying
    // `undefined`, so the value has to be read off the proxy separately.
    const depInfo = wh.deps
      .map((dep) => {
        const root = dep.split('?.')[0].split('.')[0]
        const acc = ctx.accessors[root]
        if (acc === `$$proxy_${root}`) {
          const dotPath = dep.slice(root.length + 1).replace(/\?\./g, '.')
          const sigVar = dotPath
            ? `$$watch_${root}_${dotPath.replace(/\./g, '_')}`
            : `$$watch_${root}`
          return { subscribe: `${sigVar}()`, value: rewriteExpr(dep, ctx.accessors) }
        }
        if (acc) return { subscribe: acc, value: acc }
        return { subscribe: null, value: dep }
      })
      .filter(Boolean)

    const depReads = depInfo.map((d) => d.subscribe).filter(Boolean).join('; ')

    // rewriteExpr with ctx.setters handles signal assignments (count++, x = v).
    // Additionally pre-process proxy fire self-assignments (`connectedArr = connectedArr`)
    // which rewriteExpr doesn't know about — only when proxyFireFns exist.
    let handlerSrc = wh.handlerRaw
    if (ctx.proxyFireFns && Object.keys(ctx.proxyFireFns).length > 0) {
      let handlerAst
      try {
        handlerAst = acorn.parseExpressionAt(handlerSrc, 0, { ecmaVersion: 'latest' })
      } catch (_) {
        handlerAst = { start: 0, end: handlerSrc.length, type: 'ArrowFunctionExpression' }
      }
      handlerSrc = rewriteAssignments(handlerSrc, handlerAst, ctx)
    }
    const rewrittenHandler = rewriteExpr(handlerSrc, ctx.accessors, ctx.setters)
    const depPart = depReads ? `${depReads}; ` : ''

    // Single dep → the handler receives (value, prev).
    // Multiple deps → arrays: ([a, b], [prevA, prevB]), as Solid's on() does.
    const valueExpr = depInfo.length === 1
      ? depInfo[0].value
      : `[${depInfo.map((d) => d.value).join(', ')}]`

    const prevVar  = `$$prev_wh${whIdx}`
    const firstVar = `$$first_wh${whIdx}`

    // Deferred: the handler does NOT run on mount, only on change.
    //
    // "when X changes, do Y" reads as change-triggered, and firing on mount is
    // both surprising and usually wrong — `$: userId, () => { count = 0 }`
    // resetting on first render is a no-op at best. The eager case is already
    // owned by $onMount, and the "initialise then keep in sync" shape is
    // usually a `const` memo wearing an effect's clothes.
    //
    // Deferring is only possible because the deps are explicit: the effect
    // still reads them on the first run to subscribe, and withholds only the
    // handler. An auto-tracked `$: { }` block cannot do this — it discovers its
    // dependencies BY running, so skipping the body would subscribe to nothing.
    //
    // It also makes `prev` well defined: the first invocation is the first
    // change, so there is always a real previous value rather than undefined.
    const debugComment = wh.debugName ? `/* $_${wh.debugName} */ ` : ''
    mod.code.push(xNode.raw(`let ${prevVar}; let ${firstVar} = true;`))
    mod.code.push(
      xNode.raw(
        `${debugComment}$runtime.createEffect(() => { ${depPart}` +
        `const $$v = ${valueExpr}; ` +
        `if (${firstVar}) { ${firstVar} = false; ${prevVar} = $$v; return; } ` +
        `const $$p = ${prevVar}; ${prevVar} = $$v; ` +
        `return $runtime.untrack(() => (${rewrittenHandler})($$v, $$p)); }, { user: true });`
      )
    )
  })

  // ── 7b-post. $: fn(), handler — post-execution hooks ─────────────────────
  // Wraps a locally-declared function so the handler runs after every call.
  ;(postCallHooks ?? []).forEach((hook) => {
    const { fnName, handlerRaw, isAsync } = hook
    const origVar = `__orig_${fnName}`

    // Parse handler for rewriting — rewriteAssignments needs an AST node
    let handlerAst
    try {
      handlerAst = acorn.parseExpressionAt(handlerRaw, 0, { ecmaVersion: 'latest' })
    } catch (_) {
      handlerAst = { start: 0, end: handlerRaw.length, type: 'ArrowFunctionExpression' }
    }

    const rewrittenHandler = rewriteExpr(
      rewriteAssignments(handlerRaw, handlerAst, ctx),
      ctx.accessors
    )

    if (isAsync) {
      mod.code.push(xNode.raw(
        `const ${origVar} = ${fnName}; ` +
        `${fnName} = async (...__args) => { const __r = await ${origVar}(...__args); (${rewrittenHandler})(); return __r; };`
      ))
    } else {
      mod.code.push(xNode.raw(
        `const ${origVar} = ${fnName}; ` +
        `${fnName} = (...__args) => { const __r = ${origVar}(...__args); (${rewrittenHandler})(); return __r; };`
      ))
    }
  })

  // ── 7b. $: { } ordered watch groups ─────────────────────────────────────────
  // Each group emits a single $runtime.orderedGroup([...entries]) call.
  // Each entry is { deps: [readFn, ...], handler: fn }.
  // The runtime runs entries in declared order, once per flush, batched.
  watchGroups.forEach((group) => {
    const debugComment = group.debugName ? `/* $_${group.debugName} */ ` : ''

    const entryStrings = group.entries.map((entry) => {
      // Resolve dep reads — same logic as step 7
      const depReads = entry.deps
        .map((dep) => {
          const root = dep.split('?.')[0].split('.')[0]
          const acc = ctx.accessors[root]
          if (acc === `$$proxy_${root}`) {
            const dotPath = dep.slice(root.length + 1).replace(/\?\./g, '.')
            const sigVar = dotPath
              ? `$$watch_${root}_${dotPath.replace(/\./g, '_')}`
              : `$$watch_${root}`
            return `${sigVar}`
          }
          // New accessor format: $runtime.get($$sig_x) → extract $$sig_x as fn ref
          if (acc) {
            const getM = acc.match(/^\$runtime\.get\((\S+)\)$/)
            if (getM) return getM[1]  // pass the signal object itself
            if (acc.endsWith('()')) return acc.slice(0, -2)  // memo fn ref
          }
          return null
        })
        .filter(Boolean)

      const rewrittenHandler = rewriteExpr(entry.handlerRaw, ctx.accessors, ctx.setters)
      const depsArray = `[${depReads.join(', ')}]`
      return `{ deps: ${depsArray}, handler: ${rewrittenHandler} }`
    })

    mod.code.push(
      xNode.raw(
        `${debugComment}$runtime.orderedGroup([${entryStrings.join(', ')}]);`
      )
    )
  })
  // Function declarations, class declarations, bare expression statements, etc.
  // These are emitted verbatim with assignment rewrites applied so that any
  // `count = x` inside a function body reaches the signal setter.
  //
  // VariableDeclaration nodes are normally skipped here because signals/memos
  // were already emitted in step 5. Exception: nodes that contain destructuring
  // patterns (passthroughDeclStarts) — those were never registered in vars and
  const contextProvideStarts = new Set(
    (ctx.analysis.contextProvides || []).map(p => p.nodeStart)
  )

  // must be emitted verbatim with their init expressions rewritten through
  // ctx.accessors so reactive variables are read through their signal getters.
  const { passthroughDeclStarts } = ctx.analysis
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') continue // already emitted
    if (node.type === 'ExportNamedDeclaration') continue // props handled above
    if (node.type === 'LabeledStatement') continue // $: forms handled above
    // $context.x = expr — converted to $ctxProvide() calls above, skip raw emit
    if (contextProvideStarts.has(node.start)) continue

    if (node.type === 'VariableDeclaration') {
      // Only emit if this node contains at least one pattern declarator.
      // Regular identifier declarators were already emitted as signals/memos.
      if (!passthroughDeclStarts.has(node.start)) continue

      // Rewrite each declarator's init expression through accessors so reactive
      // variables (e.g. `user` → `$$sig_user()`) are read correctly.
      // We reconstruct the declaration by patching each init in source order.
      const patches = []
      for (const d of node.declarations) {
        if (!d.init) continue
        const initSrc = raw.slice(d.init.start, d.init.end)
        const rewritten = rewriteExpr(initSrc, ctx.accessors)
        if (rewritten !== initSrc) {
          patches.push({ start: d.init.start, end: d.init.end, replacement: rewritten })
        }
      }
      let nodeSrc = raw.slice(node.start, node.end)
      if (patches.length) {
        patches.sort((a, b) => b.start - a.start)
        const offset = node.start
        for (const p of patches) {
          const s = p.start - offset
          const e = p.end - offset
          nodeSrc = nodeSrc.slice(0, s) + p.replacement + nodeSrc.slice(e)
        }
      }
      mod.code.push(xNode.raw(nodeSrc))
      continue
    }

    const nodeSrc = raw.slice(node.start, node.end)

    // $inspect(expr1, expr2, ...) or $inspect(...).with(fn) — top-level call.
    // Transform into a reactive createEffect that reads each arg through its
    // accessor (tracking deps) and passes label + getter array to $runtime.$inspect.
    const _innerInspect = (n) => {
      if (!n || n.type !== 'CallExpression') return null
      if (n.callee?.type === 'Identifier' && n.callee?.name === '$inspect') return { call: n, withFn: null }
      if (n.callee?.type === 'MemberExpression' &&
          n.callee?.property?.name === 'with' &&
          n.callee?.object?.type === 'CallExpression' &&
          n.callee?.object?.callee?.type === 'Identifier' &&
          n.callee?.object?.callee?.name === '$inspect') {
        const withArg = n.arguments[0]
        return {
          call: n.callee.object,
          withFn: withArg ? raw.slice(withArg.start, withArg.end) : null
        }
      }
      return null
    }
    const _inspectMatch = node.type === 'ExpressionStatement' ? _innerInspect(node.expression) : null
    if (_inspectMatch) {
      // In production (debug: false), strip $inspect entirely — emit nothing
      if (ctx.config.debug === false) continue
      const { call: callNode, withFn } = _inspectMatch
      const argSrcs = callNode.arguments.map(a => raw.slice(a.start, a.end))
      const label = argSrcs.join(', ')
      const getters = argSrcs.map(src => {
        const rw = rewriteExpr(src, ctx.accessors)
        return `() => (${rw})`
      }).join(', ')
      const inspectCall = `$inspect({ label: ${JSON.stringify(label)}, getters: [${getters}] })`
      const full = withFn ? `${inspectCall}.with(${withFn})` : inspectCall
      mod.code.push(xNode.raw(`${full};`))
      continue
    }

    const rewritten = rewriteExpr(rewriteAssignments(nodeSrc, node, ctx), ctx.accessors)
    // If the statement contains a *top-level* await (e.g. `x = await fetch(...)`)
    // wrap in an async IIFE so the component function stays synchronous.
    // VariableDeclaration `const x = await y` is already handled separately above.
    //
    // This used to be `/\bawait\b/.test(rewritten)`, which could not tell a
    // top-level await from one nested inside a function body. That meant
    //
    //   async function handleLogin() { await save(); }
    //
    // was wrapped as `(async () => { async function handleLogin() {…} })()`,
    // scoping the declaration inside the IIFE so the template's
    // `onclick={handleLogin}` resolved to nothing —
    // "ReferenceError: handleLogin is not defined" at runtime, with no
    // compile-time warning. Declarations are never top-level awaits, and an
    // await inside a nested function is that function's own business.
    const containsAwait = _hasTopLevelAwait(node)
    if (containsAwait) {
      mod.code.push(xNode.raw(`(async () => { ${rewritten} })()`))
    } else {
      mod.code.push(xNode.raw(rewritten))
    }
  }
}

/**
 * Does this statement contain an await that belongs to the *enclosing* scope?
 *
 * Walks the AST and stops at any boundary that introduces a new `async`
 * context — function declarations, function expressions, arrow functions,
 * class bodies. An await inside one of those is executed by that function, not
 * by the component body, so it never requires the statement to be wrapped.
 *
 * Returns false for FunctionDeclaration / ClassDeclaration outright: a
 * declaration is a binding, and wrapping it in an IIFE would hide the binding
 * from the rest of the component.
 */
function _hasTopLevelAwait(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return false

  const BOUNDARY = new Set([
    'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody',
  ])

  let found = false
  ;(function walk(n) {
    if (found || !n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const c of n) walk(c); return }
    if (typeof n.type !== 'string') return
    if (n.type === 'AwaitExpression') { found = true; return }
    if (n !== node && BOUNDARY.has(n.type)) return   // new async context — not ours
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue
      walk(n[key])
    }
  })(node)

  return found
}

/**
 * Called after emitScript. Ensures ctx.rewriteExpr is available for any
 * late-binding builder passes that need to rewrite expressions.
 */
export function emitTransforms(ctx) {
  // Provide a convenience wrapper so builder code doesn't have to import
  // the standalone function.
  ctx.rewriteExpr = (expr) => rewriteExpr(expr, ctx.accessors)
}

/** Topological sort by dependency order. Deps before dependents. */
function topoSort(vars) {
  const nameMap = Object.fromEntries(vars.map((v) => [v.name, v]))
  const visited = new Set(),
    result = []
  const visit = (v) => {
    if (visited.has(v.name)) return
    visited.add(v.name)
    v.deps.forEach((dep) => {
      if (nameMap[dep]) visit(nameMap[dep])
    })
    result.push(v)
  }
  vars.forEach(visit)
  return result
}


// ─── DOM traversal: child()/sibling()/pop() ───────────────────────────────────
function _domTraversal(code) {
  // Transform all consecutive blocks of let-declarations that walk the DOM.
  // Matches both the outer component block (after $tplN()) and inner makeBlock
  // callbacks (after ($parentElement) =>). The pattern is any run of lines
  // of the form:  (spaces)let varName = expr.firstChild/nextSibling...;
  
  // Extract and transform a block of let traversal lines into child()/sibling()/pop()
  function transformDecls(open, decls) {
    const lines = decls.trimEnd().split('\n')
    const out = []
    const descended = new Set()
    let tmpIdx = 0

    for (const line of lines) {
      const indent = line.match(/^(\s*)/)[1]
      const m = line.match(/^\s*let (\S+) = (.+);\s*$/)
      if (!m) { out.push(line); continue }

      const [, name, expr] = m
      const isTextNode = name.startsWith('el')

      // Y.firstChild.nextSibling — skip first child, get second
      const chainM = expr.match(/^(\S+)\.firstChild\.nextSibling$/)
      if (chainM) {
        const parent = chainM[1]
        const tmp = '$_skip' + (tmpIdx++)
        out.push(indent + 'var ' + tmp + ' = $runtime.child(' + parent + ');')
        descended.add(parent)
        out.push(indent + 'var ' + name + ' = $runtime.sibling(' + tmp + ');')
        continue
      }

      // Y.firstChild
      const fcM = expr.match(/^(\S+)\.firstChild$/)
      if (fcM) {
        const parent = fcM[1]
        descended.add(parent)
        const flag = isTextNode ? ', true' : ''
        out.push(indent + 'var ' + name + ' = $runtime.child(' + parent + flag + ');')
        continue
      }

      // Y.nextSibling
      const nsM = expr.match(/^(\S+)\.nextSibling$/)
      if (nsM) {
        const prev = nsM[1]
        if (descended.has(prev)) {
          out.push(indent + '$runtime.pop(' + prev + ');')
          descended.delete(prev)
        }
        out.push(indent + 'var ' + name + ' = $runtime.sibling(' + prev + ');')
        continue
      }

      out.push(line)
    }

    return open + out.join('\n') + '\n'
  }

  // Match ALL consecutive let-traversal blocks anywhere in the output
  return code.replace(
    /((?:const \$parentElement = \$tpl\d+\(\)|\(\$parentElement\) =>)[^\n]*\n)((?:\s+let [^;\n]+;\n)+)/g,
    (_, open, decls) => transformDecls(open, decls)
  )
}


// ─── render() grouping: collect bindText/bindAttribute into one render block ──
// Converts consecutive:
//   $runtime.bindText(el0, () => expr0);
//   $runtime.bindText(el1, () => expr1);
// Into a single:
//   $runtime.render((__prev) => {
//     var __a = expr0; if (__prev.a !== __a) $runtime.set_text(el0, __prev.a = __a)
//     var __b = expr1; if (__prev.b !== __b) $runtime.set_text(el1, __prev.b = __b)
//   }, { a: ' ', b: ' ' })
//
// bindAttribute calls similarly grouped with set_attribute.
// Static (non-signal) bindings are kept as direct assignments before render().
//
// Key counter for __prev keys: a, b, c, ... z, aa, ab, ...
function indexToKey(i) {
  const alpha = 'abcdefghijklmnopqrstuvwxyz'
  if (i < 26) return alpha[i]
  return alpha[Math.floor(i / 26) - 1] + alpha[i % 26]
}

// Detect whether a binding expression is reactive.
// Reactive if it contains:
//   - $runtime.get(...)       — top-level signal accessor
//   - $$proxy_                — watched path proxy
//   - \bword()                — bare no-arg function call (each-block item/index getter)
//     e.g. item().r, index()  — these are signal getters passed as makeBlock params
function _isReactive(expr) {
  if (expr.includes('$runtime.get') || expr.includes('$$proxy_')) return true
  // Bare no-arg call: identifier immediately followed by () — signal getter pattern.
  // Excludes method chains like Math.floor() (preceded by '.') and $runtime.x().
  if (/(?<![.$])\b[a-z_][a-zA-Z0-9_]*\(\)/.test(expr)) return true
  // External signal .get() calls — the Mesa bridge patches Sierra signals so their
  // .get() becomes Mesa's reactive read function. Matches: identifier.get()
  // but not: $runtime.anything.get() or similar false positives.
  if (/(?<!\$runtime\b[^.]*)\.get\(\)/.test(expr)) return true
  return false
}

function _renderGroup(code) {
  // Match consecutive runs of bindText / bindAttribute lines at ANY indentation level.
  // The regex anchors to line-start (after \n or at string start) and captures the
  // leading whitespace so we can reproduce the correct indent in the output.
  //
  // Each matched line is:
  //   <indent>$runtime.bindText(el, () => expr);\n
  //   <indent>$runtime.bindAttribute(el, 'name', () => expr);\n
  //
  // Consecutive lines must share the same leading indent to be grouped together.
  // We do this in two passes: first split into logical blocks by indent, then transform.

  // Single-pass approach: match any run of bind lines, extract indent from first line.
  const BIND_LINE = /^([ \t]*)\$runtime\.(bindText|bindAttribute)\([^\n]+;\n/m

  // Process iteratively — find the first bind line, collect its group, replace, repeat.
  let result = code
  let safety = 0

  while (safety++ < 1000) {
    // Find the first bindText/bindAttribute line in the remaining code
    const firstM = BIND_LINE.exec(result)
    if (!firstM) break

    const indent = firstM[1]           // leading whitespace of this group
    const groupStart = firstM.index   // start position in the string

    // Build regex that matches consecutive bind lines at the SAME indent
    const escapedIndent = indent.replace(/\t/g, '\\t').replace(/ /g, ' ')
    const groupRe = new RegExp(
      `^(?:${escapedIndent}\\$runtime\\.(?:bindText|bindAttribute)\\([^\\n]+;\\n)+`,
      'm'
    )

    // Find the full group starting at groupStart
    const sub = result.slice(groupStart)
    const groupM = groupRe.exec(sub)
    if (!groupM) break  // shouldn't happen, but guard

    const block = groupM[0]
    const lines = block.trimEnd().split('\n').filter(Boolean)

    const bindings = lines.map(line => {
      const textM = line.match(/\$runtime\.bindText\((\S+),\s*\(\)\s*=>\s*\(?([\s\S]+?)\)?\);\s*$/)
      if (textM) return { type: 'text', el: textM[1], expr: textM[2].trim() }

      const attrM = line.match(/\$runtime\.bindAttribute\((\S+),\s*'([^']+)',\s*\(\)\s*=>\s*\(?([\s\S]+?)\)?\);\s*$/)
      if (attrM) return { type: 'attr', el: attrM[1], name: attrM[2], expr: attrM[3].trim() }

      return { type: 'raw', line }
    })

    const reactive = bindings.filter(b => b.type !== 'raw' && _isReactive(b.expr))
    const statics  = bindings.filter(b => b.type !== 'raw' && !_isReactive(b.expr))
    const raws     = bindings.filter(b => b.type === 'raw')

    const I = indent
    const out = []

    // Static bindings — direct one-time assignment, zero reactive overhead
    for (const b of statics) {
      if (b.type === 'text') {
        out.push(I + b.el + '.nodeValue = ' + b.expr + ';')
      } else {
        out.push(I + '$runtime.set_attribute(' + b.el + ', \'' + b.name + '\', ' + b.expr + ');')
      }
    }

    for (const b of raws) out.push(b.line)

    if (reactive.length > 0) {
      // All reactive bindings in one render() block with __prev dirty-checking
      const init = {}
      const body = []
      reactive.forEach((b, i) => {
        const k = indexToKey(i)
        init[k] = b.type === 'text' ? "' '" : 'null'
        body.push(I + '  var __' + k + ' = ' + b.expr + ';')
        if (b.type === 'text') {
          body.push(I + '  if (__prev.' + k + ' !== __' + k + ') $runtime.set_text(' + b.el + ', __prev.' + k + ' = __' + k + ');')
        } else {
          body.push(I + '  if (__prev.' + k + ' !== __' + k + ') $runtime.set_attribute(' + b.el + ', \'' + b.name + '\', __prev.' + k + ' = __' + k + ');')
        }
      })
      const initStr = Object.entries(init).map(([k, v]) => k + ': ' + v).join(', ')
      out.push(I + '$runtime.render((__prev) => {')
      body.forEach(l => out.push(l))
      out.push(I + '}, { ' + initStr + ' });')
    }

    const replacement = out.join('\n') + '\n'
    result = result.slice(0, groupStart) + replacement + result.slice(groupStart + block.length)
  }

  return result
}


// ─── TEMPLATE HOISTING ────────────────────────────────────────────────────────
//
// Runs on the final compiled string after xBuild is completely done.
// Finds every htmlToFragment / htmlToFragmentClean call, deduplicates by
// template string, declares a module-scope const for each, and replaces
// call sites with the const name (or name.cloneNode(true) for the root).
//
// This avoids fighting xBuild's resolution order — the IR pipeline stays
// unchanged and we do one clean string pass at the very end.
//
// Call site semantics:
//   Named root:  const $parentElement = $runtime.htmlToFragment(`...`, 3);
//                → const $parentElement = $tpl0.cloneNode(true);
//                (bit 1 of option = cloneNode was set for the root)
//   Inline:      $runtime.makeBlock($runtime.htmlToFragment(`...`), fn)
//                → $runtime.makeBlock($tpl1, fn)
//                (makeBlock does its own .cloneNode(true) internally)

function hoistTemplates(code) {
  const seen = new Map() // key → tplName
  const decls = []
  let idx = 0

  const getOrAdd = (tpl, flags) => {
    const key = `${tpl}|${flags}`
    if (!seen.has(key)) {
      const name = `$tpl${idx++}`
      seen.set(key, name)
      // template(html, flags) returns a factory function — call it to clone
      decls.push(`var ${name} = $runtime.template(\`${tpl}\`, ${flags});`)
    }
    return seen.get(key)
  }

  // Pass 1: named root — replace htmlToFragment call + cloneNode → template factory call
  code = code.replace(
    /const \$parentElement = \$runtime\.(htmlToFragment(?:Clean)?)\(`((?:[^`\\]|\\.)*)`,?\s*(\d+)?\);/g,
    (_, fn, tpl, opt) => {
      const optNum = opt ? parseInt(opt, 10) : 0
      const flags = (optNum & 2) ? 1 : 0  // TEMPLATE_FRAGMENT flag if requireFragment
      const name = getOrAdd(tpl, flags)
      return `const $parentElement = ${name}();`  // factory call, no cloneNode
    }
  )

  // Pass 2: inline htmlToFragment calls (makeBlock etc.)
  code = code.replace(
    /\$runtime\.(htmlToFragment(?:Clean)?)\(`((?:[^`\\]|\\.)*)`,?\s*(\d+)?\)/g,
    (_, fn, tpl, opt) => {
      const optNum = opt ? parseInt(opt, 10) : 0
      const flags = (optNum & 2) ? 1 : 0
      return getOrAdd(tpl, flags)
    }
  )

  if (!decls.length) return code

  return code.replace(
    /^((?:import\s+.+?from\s+'[^']+';[ \t]*\n)+)/m,
    `$1${decls.join('\n')}\n`
  )
}

// ─── 9. COMPILER PIPELINE ─────────────────────────────────────────────────────

export const version = '2.0.0'

/**
 * Determine whether a compiled Mesa component is fully static.
 *
 * A static component:
 *  - Has no reactive `let` variables (mutable signals)
 *  - Has no `export let` props (parent can push updates)
 *  - Has no `$:` watch handlers, path watches, or auto-tracked effects
 *  - Has no `$context` provides or consumes
 *  - Has no async derived `const` (would need runtime re-fetching)
 *  - Has no DOM event handlers (on:, @event)
 *  - Has no `{@attach}` lifecycle directives
 *  - Has no `bind:value` / `bind:group` (these require let, caught above)
 *
 * Props via `export const` and `export var` are fine — they are set once
 * at render time and never change.
 *
 * @param {object} analysis  ctx.analysis from analyzeScript
 * @param {object} dom       ctx.DOM from parseHTML
 * @returns {boolean}
 */
export function detectStatic(analysis, dom) {
  if (!analysis) return false

  const vars = Object.values(analysis.vars ?? {})

  // Any reactive let (non-prop) → not static
  if (vars.some((v) => v.kind === 'let' && !v.isProp)) return false

  // export let → parent can push updates → not static
  if (vars.some((v) => v.kind === 'let' && v.isProp)) return false

  // $: watch handlers, path watches, or auto-tracked effects → not static
  if ((analysis.watchHandlers?.length ?? 0) > 0) return false
  if ((analysis.watchPaths?.length   ?? 0) > 0) return false
  if ((analysis.effects?.length      ?? 0) > 0) return false

  // $context provides or consumes → not static
  if ((analysis.contextProvides?.length ?? 0) > 0) return false
  if (vars.some((v) => v.isContextConsume)) return false

  // async derived const → runtime re-fetching needed → not static
  if (vars.some((v) => v.isAsync)) return false

  // DOM-level interactivity — walk template for event handlers and @attach
  if (dom && _domHasInteractivity(dom)) return false

  return true
}

/**
 * Walk the DOM AST and return true if any node has an event handler
 * (on:event, @event) or an {@attach} directive — both require JS at runtime.
 */
function _domHasInteractivity(node) {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(_domHasInteractivity)

  // Check attributes on this node
  if (Array.isArray(node.attributes)) {
    for (const attr of node.attributes) {
      const name = attr.name ?? ''
      if (name.startsWith('on:'))    return true   // on:click etc.
      if (name.startsWith('@'))      return true   // @click shorthand
      if (name === '{@attach}')      return true   // lifecycle attachment
      if (attr.raw?.startsWith('{@attach')) return true
    }
  }

  // Recurse into children and body
  if (_domHasInteractivity(node.children)) return true
  if (_domHasInteractivity(node.body))     return true

  return false
}

export async function compile(source, config = {}) {
  config = Object.assign(
    {
      compact: true,
      css: true,
      debug: true,
      hideLabel: false,
      passClass: true,
      preserveComments: false,
      debugLabel: false,
      autoimport: null,
      plugins: [],
      warning: (w) => console.warn('!', w.message || w)
    },
    config
  )

  const ctx = {
    source,
    config,
    uniqIndex: 0,
    warning: config.warning,

    buildBlock: function (...a) {
      return buildBlock.call(this, ...a)
    },
    makeifBlock: function (...a) {
      return makeifBlock.call(this, ...a)
    },
    makeKeyBlock: function (...a) {
      return makeKeyBlock.call(this, ...a)
    },
    makeSnippet: function (...a) {
      return makeSnippet.call(this, ...a)
    },
    makeRenderTag: function (...a) {
      return makeRenderTag.call(this, ...a)
    },
    makeEachBlock: function (...a) {
      return makeEachBlock.call(this, ...a)
    },
    makeVirtualEachBlock: function (...a) {
      return makeVirtualEachBlock.call(this, ...a)
    },
    makeAwaitBlock: function (...a) {
      return makeAwaitBlock.call(this, ...a)
    },
    attachSlot: function (...a) {
      return attachSlot.call(this, ...a)
    },
    makeComponent: function (...a) {
      return makeComponent.call(this, ...a)
    },
    bindProp: function (...a) {
      return bindProp.call(this, ...a)
    },
    inspectProp: function (...a) {
      return inspectProp.call(this, ...a)
    },
    parseText: function (...a) {
      return parseText(...a)
    },
    makeFragment: null,

    inuse: {},
    delegatedEvents: new Set(),  // event names to wire via root delegation
    localSnippetNames: new Set(), // names of locally-declared {#snippet} blocks

    require(...args) {
      for (const name of args) {
        if (this.inuse[name] == null) this.inuse[name] = 0
        this.inuse[name]++
      }
    },

    detectDependency(data) {
      const check = (name) => {
        if (typeof name === 'string') {
          if (name.includes('$props')) this.require('$props')
          if (name.includes('$attributes')) this.require('$attributes')
          if (name.includes('$emit')) this.require('$emit')
          if (name.includes('$context')) this.require('$context')
          if (name.includes('$.transition') || name.includes('$.entrance') ||
              name.includes('$.fade') || name.includes('$.slide') || name.includes('$.fly')) this.require('$mesa')

          // Warn if a var variable is referenced in the template — var is non-reactive,
          // so the template will render its initial value and never update.
          // Off by default — enable with warnVarTemplate: true in mesa.config.js.
          if (this.config?.warnVarTemplate) {
            const topLevel = name.split(/[.([]/, 1)[0].trim()
            if (topLevel && this.analysis?.vars?.[topLevel]?.kind === 'var') {
              this.warning({
                message: `Warning: '${topLevel}' is a 'var' variable and is non-reactive. ` +
                  `Template binding '${topLevel}' will render its initial value and never update. ` +
                  `Use 'let' or 'const' for reactive template bindings.`
              })
            }
          }
        }
      }
      if (typeof data === 'string') check(data)
      else if (data?.parts)
        data.parts.forEach((p) => {
          if (p.type === 'exp' || p.type === 'js') check(p.value)
        })
    },

    DOM: null,
    script: null,
    analysis: null,
    styleNodes: null,
    css: null,

    // ctx.accessors / ctx.setters are populated by emitScript().
    accessors: null,
    setters: null,

    module: {
      top: xNode.block(),
      head: xNode.block(),
      code: xNode.block(),
      body: xNode.block()
    },
    result: null
  }

  const hook = async (name) => {
    for (const plugin of config.plugins) {
      const fn = plugin[name]
      if (fn) await use_context(ctx, () => fn.call(ctx, ctx))
    }
  }

  // ── Parse HTML ────────────────────────────────────────────────────────────
  await hook('dom:before')
  use_context(ctx, () => {
    ctx.DOM = parseHTML(source)
  })
  await hook('dom')

  ctx.scriptNodes = []
  ctx.scriptModuleNodes = []
  ctx.styleNodes = []
  ctx.DOM.body = ctx.DOM.body.filter((n) => {
    if (n.type === 'script') {
      ctx.scriptNodes.push(n)
      return false
    }
    if (n.type === 'script-module') {
      ctx.scriptModuleNodes.push(n)
      return false
    }
    if (n.type === 'style') {
      ctx.styleNodes.push(n)
      return false
    }
    return true
  })

  assert(ctx.scriptNodes.length <= 1, 'Only one <script> block per component')
  assert(ctx.scriptModuleNodes.length <= 1, 'Only one <script module> block per component')
  await hook('dom:after')

  if (config.compact) compactDOM(ctx.DOM, config.compact === 'full')

  // ── Parse + analyze script ────────────────────────────────────────────────
  await hook('js:before')
  const rawScript = ctx.scriptNodes[0]?.content || ''
  let scriptAST
  try {
    scriptAST = acorn.parse(rawScript, { sourceType: 'module', ecmaVersion: 'latest' })
  } catch (e) {
    scriptAST = { type: 'Program', body: [], sourceType: 'module' }
    ctx.warning({ message: 'Script parse error: ' + e.message })
  }

  ctx.script = { source: rawScript, ast: scriptAST, rootVariables: {}, rootFunctions: {} }
  scriptAST.body.forEach((n) => {
    if (n.type === 'FunctionDeclaration') ctx.script.rootFunctions[n.id.name] = true
    if (n.type === 'VariableDeclaration')
      n.declarations.forEach((d) => {
        if (d.id.name) ctx.script.rootVariables[d.id.name] = true
        if (d.init?.type === 'ArrowFunctionExpression')
          ctx.script.rootFunctions[d.id.name] = true
      })
  })

  ctx.analysis = analyzeScript(rawScript, scriptAST)
  ctx.analysis.errors.forEach((e) => ctx.warning({ message: e }))
  ctx.analysis.warnings.forEach((w) => ctx.warning({ message: `Warning: ${w}` }))

  // Surface parse-time errors (e.g. @attach in text content)
  if (ctx.DOM._parseErrors?.length) {
    ctx.DOM._parseErrors.forEach(e => ctx.analysis.errors.push(e))
  }

  // Detect $ namespace usage in script source AND template — $.transition, $.entrance, $.fade, $.slide, $.fly
  if (rawScript.includes('$.transition') || rawScript.includes('$.entrance') ||
      rawScript.includes('$.fade') || rawScript.includes('$.slide') || rawScript.includes('$.fly') ||
      source.includes('$.transition') || source.includes('$.entrance') ||
      source.includes('$.fade') || source.includes('$.slide') || source.includes('$.fly')) {
    ctx.require('$mesa')
  }

  // Detect $context usage — contextProvide/contextRead injected as locals.
  if (rawScript.includes('$context') || source.includes('$context')) {
    ctx.require('$contextFns')
  }

  // Detect $emit / $props / $attributes in script source.
  // detectDependency only runs during template processing, so script-block
  // usages (e.g. inside functions) need a separate raw-source scan here.
  if (rawScript.includes('$emit'))       ctx.require('$emit')
  if (rawScript.includes('$props'))      ctx.require('$props')
  if (rawScript.includes('$attributes')) ctx.require('$attributes')
  if (rawScript.includes('$inspect') && ctx.config.debug !== false) ctx.require('$inspect')

  // Detect $mounted(fn) — the mount-gate builtin. Enforce single-use.
  // Scans for: const/let/var <name> = $mounted(
  const _mountedMatches = [...rawScript.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\$mounted\s*\(/g)]
  if (_mountedMatches.length > 1) {
    ctx.analysis.errors.push(
      `$mounted() may only be called once per component. Use Promise.all inside a single $mounted for multiple operations.`
    )
  }
  if (_mountedMatches.length >= 1) {
    ctx.analysis.mountedVar = _mountedMatches[0][1]
    ctx.require('$mounted')
  }

  await hook('js:after')

  // ── Detect static component ───────────────────────────────────────────────
  // A component is static when it has no reactive state, no event handlers,
  // no watch/effects, no context, and no async derivations.
  // Static components can be rendered to HTML strings with no JS.
  ctx.isStatic = detectStatic(ctx.analysis, ctx.DOM)

  // ── Collect island components (client:* directives) ───────────────────────
  // Walk the DOM and collect every component tag that carries a client:*
  // attribute. Exposed as ctx.islands for meta-frameworks like Sierra.
  //
  // ctx.islands: Array<{
  //   component: string,          // PascalCase component name e.g. 'Counter'
  //   directive: string,          // 'idle' | 'load' | 'visible' | 'media' | 'static'
  //   media?: string,             // media query string for client:media="(...)"
  //   props: Record<string, any>, // static prop values at the call site
  // }>
  ctx.islands = [];
  (function walkForIslands(nodes) {
    if (!nodes) return
    for (const n of (Array.isArray(nodes) ? nodes : [nodes])) {
      if (!n || typeof n !== 'object') continue
      if (n.type === 'node' && n.name && /^[A-Z]/.test(n.name)) {
        const clientAttr = (n.attributes || []).find(a => a.name?.startsWith('client:'))
        if (clientAttr) {
          const directive = clientAttr.name.slice('client:'.length)
          const entry = { component: n.name, directive }
          if (directive === 'media' && clientAttr.value) {
            entry.media = clientAttr.value.replace(/^["']|["']$/g, '')
          }
          // Collect static string/number/boolean prop values (non-expression attrs)
          const props = {}
          for (const a of (n.attributes || [])) {
            if (a.name.startsWith('client:') || a.name.startsWith('on:') ||
                a.name.startsWith('bind:') || a.name.startsWith('@')) continue
            if (a.type !== 'exp' && a.value != null) props[a.name] = a.value
          }
          if (Object.keys(props).length) entry.props = props
          ctx.islands.push(entry)
        }
      }
      walkForIslands(n.body)
    }
  })(ctx.DOM?.body)

  // ── Process CSS ───────────────────────────────────────────────────────────
  use_context(ctx, () => processCSS(ctx))
  if (ctx.css.active()) ctx.css.process()

  // ── Emit script ───────────────────────────────────────────────────────────
  // Must run BEFORE buildRuntime so ctx.accessors/setters are available when
  // buildBlock processes template expressions.
  use_context(ctx, () => {
    emitScript(ctx)
    emitTransforms(ctx)
  })

  // ── Build runtime (DOM bindings) ──────────────────────────────────────────
  await hook('runtime:before')
  use_context(ctx, () => buildRuntime.call(ctx))
  await hook('runtime')

  // ── Assemble output ───────────────────────────────────────────────────────
  await hook('build:before')
  ctx.result = use_context(ctx, () => {
    // Derive component name from filename: 'Counter.mesa' → 'Counter'
    const _filename = config.filename ?? config.path ?? ''
    const _basename = _filename.split(/[/\\]/).pop() ?? ''
    const _compName = _basename.replace(/\.mesa$/, '').replace(/[^a-zA-Z0-9_$]/g, '_') || 'Component'

    const root = xNode('root', (w) => {
      w.write(true, `import * as $runtime from '@frontierjs/mesa/runtime.js';`)
      w.add(ctx.module.top)
      // <script module> content — emitted at module scope, before component fn
      const moduleScript = ctx.scriptModuleNodes[0]?.content?.trim()
      if (moduleScript) {
        w.write(true, '')
        moduleScript.split('\n').forEach(line => w.write(true, line))
        w.write(true, '')
      }
      // Named function export
      w.write(true, `export default function ${_compName}(__anchor, __props, __block) {`)
      w.indent++
      // In dev builds, pass component name + file so __dev can track instances.
      const _escFilename = (_filename ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      if (config.dev) {
        w.write(true, `$runtime.push_component('${_compName}', '${_escFilename}');`)
      } else {
        w.write(true, '$runtime.push_component();')
      }
      // NOTE: the body is deliberately NOT wrapped in try/finally to balance
      // push/pop_component. A block would make the component's `function`
      // declarations block-scoped in strict mode, which is the class of bug
      // async-decl-scope.test.js exists to prevent. Exception safety is handled
      // in the runtime instead — see _unwindComponents, which restores the
      // stacks from the flush loop and from mount().
      // $option compat shim: props still passed as __props
      w.write(true, 'const $option = { props: __props };')
      // $slots — reactive object indicating which named slots have content.
      // Used as: {#if $slots.sidebar} to conditionally render slot areas.
      w.write(true, 'const $slots = $runtime.makeSlots(__block);')
      w.add(ctx.module.head)
      w.add(ctx.module.code)
      w.add(ctx.module.body)
      w.write(true, '$runtime.pop_component();')
      w.indent--
      w.write(true, '}')
      // delegate call moves to module scope (after function)
      if (ctx.delegatedEvents.size > 0) {
        const names = [...ctx.delegatedEvents].map(e => `'${e}'`).join(', ')
        w.write(true, `$runtime.$$delegate([${names}]);`)
      }
    })
    for (const k in ctx.glob ?? {}) resolveDependencies(ctx.glob[k])
    return _renderGroup(_domTraversal(hoistTemplates(xBuild(root, { warning: config.warning })))).replace(/^const \$\$set_/mg, (m) => '  ' + m)
  })

  await hook('build')
  return ctx
}

function compactDOM(dom, full) {
  const walk = (node) => {
    if (!node.body) return
    node.body = node.body.filter((n) => {
      if (n.type !== 'text') return true
      if (full) n.value = n.value.replace(/\s+/g, ' ')
      else n.value = n.value.replace(/\n\s*/g, '')
      return n.value.length > 0
    })
    node.body.forEach(walk)
  }
  walk(dom)
}

// ─── 10. PLUGIN HOOKS ─────────────────────────────────────────────────────────

// ── Unified entry point ────────────────────────────────────────────────────────
//
// Route to compileMd when the filename ends in .md — otherwise use compile().
// This is the recommended import for any tool that handles both file types.
//
// Usage:
//   import { compileSource } from '@frontierjs/mesa-compiler'
//   const ctx = await compileSource(source, { filename: 'Post.md' })
//   const ctx = await compileSource(source, { filename: 'Counter.mesa' })

let _compileMd = null

async function _getCompileMd() {
  if (!_compileMd) {
    const mod = await import('./compiler-md.js')
    _compileMd = mod.compileMd
  }
  return _compileMd
}

/**
 * Unified compile function — routes to compileMd for .md files, compile() for
 * everything else. Uses config.filename or config.path to determine file type.
 *
 * @param {string} source
 * @param {object} [config]
 * @param {string} [config.filename] — file path (used for routing + error messages)
 * @param {string} [config.path]     — alias for filename (Rollup convention)
 * @returns {Promise<object>} ctx
 */
export async function compileSource(source, config = {}) {
  const filename = config.filename ?? config.path ?? ''
  const isMd = filename.endsWith('.md')
  const hasFrontmatter = source.startsWith('---\n') || source.startsWith('---\r\n')
  if (isMd || hasFrontmatter) {
    const compileMd = await _getCompileMd()
    return compileMd(source, config)
  }
  return compile(source, config)
}

/**
 * Compile a file by path — reads the file and routes based on extension.
 * Convenience wrapper for Node.js build tools.
 *
 * @param {string} filepath — absolute or relative path to a .mesa or .md file
 * @param {object} [config]
 * @returns {Promise<object>} ctx
 */
export async function compileFile(filepath, config = {}) {
  const { readFile } = await import('fs/promises')
  const source = await readFile(filepath, 'utf8')
  return compileSource(source, { ...config, filename: filepath })
}

export function mesaVite(options = {}) {
  const cssCache = new Map()
  const ext = options.extensions || ['.mesa', '.md']
  return {
    name: 'mesa',
    async transform(code, id) {
      if (!ext.some((e) => id.endsWith(e))) return null
      try {
        // compileSource routes .md → compileMd, .mesa → compile
        const ctx = await compileSource(code, { ...options, filename: id, css: false })
        let js = ctx.result
        if (ctx.css?.result) {
          const cssId = id + '.mesa.css'
          cssCache.set(cssId, ctx.css.result)
          js += `\nimport '${cssId}';`
        }
        return { code: js, map: null }
      } catch (e) {
        if (e.details) console.error(e.details)
        this.error(e)
      }
    },
    resolveId(id) {
      return cssCache.has(id) ? id : null
    },
    load(id) {
      return cssCache.get(id) ?? null
    }
  }
}

export function mesaRollup(options = {}) {
  const cssCache = {}
  const ext = options.extensions || ['.mesa', '.md']
  return {
    name: 'mesa',
    async transform(code, id) {
      if (!ext.some((e) => id.endsWith(e))) return null
      try {
        const opts = await loadMesaConfig(id, { ...options, path: id })
        const ctx = await compileSource(code, { ...opts, filename: id })
        let js = ctx.result
        if (ctx.css?.result) {
          const cssId = id.replace(/[^\w.\-]/g, '') + '.css'
          cssCache[cssId] = ctx.css.result
          js += `\nimport '${cssId}';`
        }
        return { code: js }
      } catch (e) {
        if (e.details) console.error(e.details)
        throw e
      }
    },
    resolveId(id) {
      return cssCache[id] ? id : null
    },
    load(id) {
      return cssCache[id] ?? null
    }
  }
}

async function loadMesaConfig(filename, option) {
  const fs = await import('fs')
  const parts = filename.split(/[/\\]/)
  for (let i = parts.length - 1; i > 1; i--) {
    const local = parts.slice(0, i).join('/') + '/mesa.config.js'
    if (fs.existsSync(local)) {
      const confFn = (await import(local)).default
      return typeof confFn === 'function' ? confFn(option, filename) : confFn
    }
  }
  return option
}
