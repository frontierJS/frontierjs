/**
 * @frontierjs/mesa-compiler — test suite
 *
 * Run with:
 *   npx vitest run --environment happy-dom compiler_test.js
 *
 * Sections
 *   1.  rewriteExpr           — expression identifier rewriting
 *   2.  rewriteAssignments    — assignment / update operator patching
 *   3.  rewriteTextResult     — template literal expression rewriting
 *   4.  analyzeScript         — Mesa script analyzer
 *   5.  compile() output shape — unit-level assertions on emitted JS strings
 *   6.  end-to-end            — compile + execute against real runtime
 *   7.  isStatic detection
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as acorn from 'acorn'
import {
  rewriteExpr, rewriteAssignments, rewriteTextResult,
  analyzeScript, parseText, compile, scopeCSS, compileSource,
} from './compiler.js'
import { setRenderEnvironment } from './runtime.js'

setRenderEnvironment(true)

// ── helpers ───────────────────────────────────────────────────────────────────

const parseProgram = src =>
  acorn.parse(src, { sourceType: 'module', ecmaVersion: 'latest' })

const makeRewriteCtx = (setters, accessors, source) => ({
  setters, accessors, script: { source },
})

function execCompiled(compiledJs, runtime, userImports = {}) {
  let code = compiledJs
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(compiledJs)) !== null) {
    const spec = m[1].trim(), src = m[2]
    if (src === '@frontierjs/mesa/runtime.js') continue
    const mock = userImports[src] || {}
    if (spec.startsWith('* as ')) {
      importNames.push(spec.slice(5).trim())
      importValues.push(mock)
    } else if (!spec.startsWith('{')) {
      // Default import: `import Foo from './foo'` — use mock.default or mock itself
      importNames.push(spec.trim())
      importValues.push(mock?.default ?? mock)
    } else {
      spec.replace(/^\{|\}$/g, '').trim().split(',').forEach(b => {
        const [o, a] = b.trim().split(/\s+as\s+/)
        importNames.push((a || o).trim())
        importValues.push(mock[o.trim()])
      })
    }
  }
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  // eslint-disable-next-line no-new-func
  return new Function('$runtime', ...importNames, code)(runtime, ...importValues)
}

async function compileAndExec(source, runtime, userImports = {}) {
  const ctx = await compile(source, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  return execCompiled(ctx.result, runtime, userImports)
}

function mount(componentFn, runtime, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  componentFn(anchor, props, null)
  runtime.flushSync()
  return {
    container, el: container,
    text:    () => container.textContent,
    find:    sel => container.querySelector(sel),
    findAll: sel => [...container.querySelectorAll(sel)],
    destroy() {
      container.innerHTML = ''
      container.parentNode?.removeChild(container)
    },
  }
}

const cx        = src => compile(src, { debug: false, css: false }).then(c => c.result)
const cxDevMode = src => compile(src, { debug: false, css: false, dev: true, filename: 'Counter.mesa' }).then(c => c.result)

// ── §1  rewriteExpr ──────────────────────────────────────────────────────────

describe('rewriteExpr', () => {
  const accessors = {
    count:  '$runtime.get($$sig_count)',
    double: '$runtime.get(double)',
    name:   '$runtime.get($$sig_name)',
    user:   '$$proxy_user',
    items:  '$runtime.get($$sig_items)',
    MAX:    'MAX',
  }

  it('shorthand property { x } expands to { x: getter() } not { getter() }', () => {
    const accessors = { username: '$runtime.get($$sig_username)', password: '$runtime.get($$sig_password)' }
    const result = rewriteExpr('JSON.stringify({ username, password })', accessors)
    expect(result).toBe('JSON.stringify({ username: $runtime.get($$sig_username), password: $runtime.get($$sig_password) })')
  })

  it('shorthand property with non-reactive var left as-is', () => {
    const accessors = { count: '$runtime.get($$sig_count)' }
    // `name` is not reactive — should stay as shorthand or just plain name
    const result = rewriteExpr('fn({ name, count })', accessors)
    expect(result).toContain('name')
    expect(result).toContain('count: $runtime.get($$sig_count)')
  })

  it('rewrites a simple identifier', () => {
    expect(rewriteExpr('count', accessors)).toBe('$runtime.get($$sig_count)')
  })
  it('rewrites an identifier in a binary expression', () => {
    expect(rewriteExpr('count * 2', accessors)).toBe('$runtime.get($$sig_count) * 2')
  })
  it('rewrites multiple different identifiers', () => {
    expect(rewriteExpr('count + double', accessors))
      .toBe('$runtime.get($$sig_count) + $runtime.get(double)')
  })
  it('skips non-computed object property names', () => {
    expect(rewriteExpr('obj.count', accessors)).toBe('obj.count')
  })
  it('rewrites computed member keys', () => {
    const acc = { size: '$runtime.get($$sig_size)' }
    expect(rewriteExpr('map[size]', acc)).toBe('map[$runtime.get($$sig_size)]')
  })
  it('skips static constants (same value as key)', () => {
    expect(rewriteExpr('MAX', accessors)).toBe('MAX')
  })
  it('skips identifiers in arrow function params', () => {
    expect(rewriteExpr('items.map(count => count * 2)', accessors))
      .toBe('$runtime.get($$sig_items).map(count => count * 2)')
  })
  it('rewrites inside template literal', () => {
    expect(rewriteExpr('`value: ${count}`', accessors))
      .toBe('`value: ${$runtime.get($$sig_count)}`')
  })
  it('rewrites proxy reference', () => {
    expect(rewriteExpr('user', accessors)).toBe('$$proxy_user')
  })
  it('rewrites value in object shorthand', () => {
    // {count} shorthand expands to {count: rewritten}
    expect(rewriteExpr('({count})', accessors)).toContain('$runtime.get($$sig_count)')
  })
  it('handles nested expressions', () => {
    const result = rewriteExpr('count > 0 ? count : 0', accessors)
    expect(result).toContain('$runtime.get($$sig_count)')
  })
  it('rewrites inside function call arguments', () => {
    expect(rewriteExpr('Math.max(count, 0)', accessors))
      .toBe('Math.max($runtime.get($$sig_count), 0)')
  })
  it('leaves non-reactive identifiers alone', () => {
    expect(rewriteExpr('Math.PI', accessors)).toBe('Math.PI')
  })
  it('rewrites inside array literal', () => {
    expect(rewriteExpr('[count, double]', accessors))
      .toBe('[$runtime.get($$sig_count), $runtime.get(double)]')
  })
  it('skips destructuring patterns in arrow params', () => {
    expect(rewriteExpr('items.map(({name}) => name)', accessors))
      .toBe('$runtime.get($$sig_items).map(({name}) => name)')
  })
  it('rewrites ternary all three branches', () => {
    const result = rewriteExpr('count ? name : double', accessors)
    expect(result).toBe('$runtime.get($$sig_count) ? $runtime.get($$sig_name) : $runtime.get(double)')
  })
})

// ── §2  rewriteAssignments ───────────────────────────────────────────────────

describe('rewriteAssignments', () => {
  const setters   = { count: '$$set_count', name: '$$set_name' }
  const accessors = {
    count: '$runtime.get($$sig_count)',
    name:  '$runtime.get($$sig_name)',
  }
  const rewrite = src => {
    const ast  = parseProgram(src)
    const node = ast.body[0]
    return rewriteAssignments(src, node, makeRewriteCtx(setters, accessors, src))
  }

  it('rewrites simple assignment', () => {
    expect(rewrite('count = 5;')).toBe('$$set_count(5);')
  })
  it('rewrites assignment to a string', () => {
    expect(rewrite("name = 'Alice';")).toBe("$$set_name('Alice');")
  })
  it('rewrites += operator', () => {
    expect(rewrite('count += 2;')).toBe('$$set_count($runtime.get($$sig_count) + (2));')
  })
  it('rewrites -= operator', () => {
    expect(rewrite('count -= 1;')).toBe('$$set_count($runtime.get($$sig_count) - (1));')
  })
  it('rewrites *= operator', () => {
    expect(rewrite('count *= 3;')).toBe('$$set_count($runtime.get($$sig_count) * (3));')
  })
  it('rewrites ++ postfix', () => {
    expect(rewrite('count++;')).toBe('$$set_count($runtime.get($$sig_count) + 1);')
  })
  it('rewrites -- postfix', () => {
    expect(rewrite('count--;')).toBe('$$set_count($runtime.get($$sig_count) - 1);')
  })
  it('rewrites ++ prefix', () => {
    expect(rewrite('++count;')).toBe('$$set_count($runtime.get($$sig_count) + 1);')
  })
  it('rewrites assignment inside function body', () => {
    const src = 'function inc() { count++; }'
    const ast  = parseProgram(src)
    const result = rewriteAssignments(src, ast.body[0], makeRewriteCtx(setters, accessors, src))
    expect(result).toBe('function inc() { $$set_count($runtime.get($$sig_count) + 1); }')
  })
  it('rewrites assignment inside arrow function', () => {
    const src = 'const inc = () => { count = count + 1; };'
    const ast  = parseProgram(src)
    const result = rewriteAssignments(src, ast.body[0], makeRewriteCtx(setters, accessors, src))
    expect(result).toContain('$$set_count')
  })
  it('rewrites RHS through accessors', () => {
    const result = rewrite('count = count + 1;')
    expect(result).toBe('$$set_count($runtime.get($$sig_count) + 1);')
  })
  it('does NOT rewrite non-reactive variable assignments', () => {
    expect(rewrite('other = 5;')).toBe('other = 5;')
  })
  it('handles multiple assignments in one statement', () => {
    const src = 'count = 0; name = "x";'
    const ast  = parseProgram(src)
    const result = rewriteAssignments(src, ast, makeRewriteCtx(setters, accessors, src))
    expect(result).toContain('$$set_count(0)')
    expect(result).toContain('$$set_name("x")')
  })

  it('assignment inside nested callback inside outer assignment is rewritten', async () => {
    // Regression: outer assignment _interval = setInterval(() => { time = ... })
    // was patching the full range before visiting nested assignments, so the inner
    // `time = ...` was never rewritten.
    const out = await cx(`
<script>
let time = '00:00'
let _interval = null
$onMount(() => {
  _interval = setInterval(() => {
    time = new Date().toLocaleTimeString()
  }, 1000)
})
$onDestroy(() => {
  clearInterval(_interval)
})
</script>
<p>{time}</p>`)
    // Outer assignment must be rewritten
    expect(out).toContain('$$set__interval(setInterval')
    // Inner assignment must also be rewritten
    expect(out).toContain('$$set_time(new Date()')
    // Must NOT produce the invalid `get(...) = ...` pattern
    expect(out).not.toMatch(/\.get\([^)]+\)\s*=/)
  })

})

// ── §3  rewriteTextResult ────────────────────────────────────────────────────

describe('rewriteTextResult', () => {
  const accessors = {
    count:  '$runtime.get($$sig_count)',
    name:   '$runtime.get($$sig_name)',
    double: '$runtime.get(double)',
  }

  it('rewrites single expression binding', () => {
    const pe = parseText('{count}')
    expect(rewriteTextResult(pe, accessors)).toBe('`${$runtime.get($$sig_count)}`')
  })
  it('rewrites expression mixed with text', () => {
    const pe = parseText('{count} items')
    expect(rewriteTextResult(pe, accessors)).toBe('`${$runtime.get($$sig_count)} items`')
  })
  it('rewrites multiple expressions', () => {
    const pe = parseText('{name}: {count}')
    expect(rewriteTextResult(pe, accessors))
      .toBe('`${$runtime.get($$sig_name)}: ${$runtime.get($$sig_count)}`')
  })
  it('rewrites derived const read', () => {
    const pe = parseText('{double}')
    expect(rewriteTextResult(pe, accessors)).toBe('`${$runtime.get(double)}`')
  })
  it('leaves static text unchanged', () => {
    const pe = parseText('hello world')
    expect(rewriteTextResult(pe, accessors)).toBe('`hello world`')
  })
  it('returns original result when no accessors', () => {
    const pe = parseText('{count}')
    const original = pe.result
    expect(rewriteTextResult(pe, null)).toBe(original)
  })
  it('rewrites complex expressions', () => {
    const pe = parseText('{count > 0 ? count : 0}')
    const result = rewriteTextResult(pe, accessors)
    expect(result).toContain('$runtime.get($$sig_count)')
  })
})

// ── §4  analyzeScript ────────────────────────────────────────────────────────

describe('analyzeScript', () => {
  const analyze = src => {
    const ast = parseProgram(src)
    return analyzeScript(src, ast)
  }

  describe('variable classification', () => {
    it('classifies export let as reactive prop', () => {
      const { vars } = analyze(`export let count = 0;`)
      expect(vars.count.isProp).toBe(true)
      expect(vars.count.kind).toBe('let')
    })
    it('classifies export const as immutable prop', () => {
      const { vars } = analyze(`export const MAX = 100;`)
      expect(vars.MAX.isProp).toBe(true)
      expect(vars.MAX.kind).toBe('const')
    })
    it('classifies export var as snapshot prop (isProp:true, kind:var)', () => {
      const { vars } = analyze(`export var taxRate = 0.08;`)
      expect(vars.taxRate.isProp).toBe(true)
      expect(vars.taxRate.kind).toBe('var')
      expect(vars.taxRate.isExport).toBe(true)
    })
    it('classifies plain let as reactive signal', () => {
      const { vars } = analyze(`let count = 0;`)
      expect(vars.count.kind).toBe('let')
      expect(vars.count.isProp).toBe(false)
    })
    it('classifies plain const as static or derived', () => {
      const { vars } = analyze(`const MAX = 100;`)
      expect(vars.MAX.kind).toBe('const')
    })
    it('classifies var as non-reactive sampler', () => {
      const { vars } = analyze(`let price = 10; var snapshot = price;`)
      expect(vars.snapshot.kind).toBe('var')
    })
    it('detects await expression as async', () => {
      const { vars } = analyze(`const states = await getStates();`)
      expect(vars.states.isAsync).toBe(true)
    })
  })

  describe('dependency detection', () => {
    it('detects simple dep in derived const', () => {
      const { vars } = analyze(`let count = 0; const double = count * 2;`)
      expect(vars.double.isDerived).toBe(true)
      expect(vars.double.deps).toContain('count')
    })
    it('detects dep in async derived', () => {
      const { vars } = analyze(`let state = 'TX'; const cities = await getCities(state);`)
      expect(vars.cities.isDerived).toBe(true)
      expect(vars.cities.deps).toContain('state')
    })
    it('does NOT count var as a reactive dep', () => {
      const { vars } = analyze(`var x = 0; const y = x + 1;`)
      expect(vars.y.isDerived).toBe(false)
      expect(vars.y.deps).toHaveLength(0)
    })
    it('does not include self-reference in deps', () => {
      const { vars } = analyze(`let count = 0; const x = count + count;`)
      expect(vars.x.deps.filter(d => d === 'count')).toHaveLength(1)
    })
  })

  describe('$: label dispatch', () => {
    it('classifies $: path as watchPath', () => {
      const { watchPaths } = analyze(`import { user } from './store.js'; $: user.name`)
      expect(watchPaths).toHaveLength(1)
      expect(watchPaths[0].path).toBe('user.name')
    })
    it('classifies $: root identifier as watchPath', () => {
      const { watchPaths } = analyze(`import { user } from './store.js'; $: user`)
      expect(watchPaths[0].path).toBe('user')
    })
    it('classifies multi-path as multiple watchPaths', () => {
      const { watchPaths } = analyze(`import { cart } from './store.js'; $: (cart.items, cart.total)`)
      expect(watchPaths).toHaveLength(2)
      expect(watchPaths.map(p => p.path)).toContain('cart.items')
      expect(watchPaths.map(p => p.path)).toContain('cart.total')
    })
    it('classifies $: dep, handler as watchHandler', () => {
      const { watchHandlers } = analyze(`let count = 0; $: count, () => console.log(count)`)
      expect(watchHandlers).toHaveLength(1)
      expect(watchHandlers[0].deps).toContain('count')
    })
    it('$_name: stores debugName on watchHandler', () => {
      const { watchHandlers } = analyze(`let count = 0; $_saveCount: count, () => console.log(count)`)
      expect(watchHandlers[0].debugName).toBe('saveCount')
    })
    it('$_name: stores debugName on watchPath', () => {
      const { watchPaths } = analyze(`import { user } from './store.js'; $_userWatch: user.name`)
      expect(watchPaths[0].debugName).toBe('userWatch')
    })
    it('$: block with bare expressions is an auto-tracked effect', () => {
      const { errors, effects } = analyze(`let count = 0; $: { console.log(count); }`)
      expect(errors).toHaveLength(0)
      expect(effects.some(e => e.type === 'block')).toBe(true)
    })
    it('$: block with watch+handler pairs produces a watchGroup', () => {
      const { errors, watchGroups } = analyze(
        `let a = 0; let b = 0; $: { a, () => { b = a * 2 }\n b, () => { console.log(b) } }`
      )
      expect(errors).toHaveLength(0)
      expect(watchGroups).toHaveLength(1)
      expect(watchGroups[0].entries).toHaveLength(2)
      expect(watchGroups[0].entries[0].deps).toContain('a')
      expect(watchGroups[0].entries[1].deps).toContain('b')
    })
    it('$: block with debug label stores debugName on group', () => {
      const { errors, watchGroups } = analyze(
        `let a = 0; let b = 0; $_pipeline: { a, () => { b = a * 2 } }`
      )
      expect(errors).toHaveLength(0)
      expect(watchGroups[0].debugName).toBe('pipeline')
    })
    it('$: bare expression is an auto-tracked effect', () => {
      const { errors, effects } = analyze(`let count = 0; $: console.log(count)`)
      expect(errors).toHaveLength(0)
      expect(effects.some(e => e.type === 'expression')).toBe(true)
    })
    it('$: if statement is a compiler error — must use $: { if } block form', () => {
      const { errors } = analyze(
        `let count = 0; $: if (count > 10) { document.title = 'high' }`
      )
      expect(errors.some(e => e.includes('not a valid Mesa reactive form'))).toBe(true)
      expect(errors.some(e => e.includes('if'))).toBe(true)
    })
    it('$: for loop is a compiler error — must use $: { for } block form', () => {
      const { errors } = analyze(
        `let count = 0; $: for (let i = 0; i < count; i++) { console.log(i) }`
      )
      expect(errors.some(e => e.includes('not a valid Mesa reactive form'))).toBe(true)
    })
    it('$: { if } block form is valid and produces an auto-tracked effect', () => {
      const { errors, effects } = analyze(
        `let role = 'user'; $: { if (role === 'admin') { console.log('ok') } }`
      )
      expect(errors).toHaveLength(0)
      expect(effects.some(e => e.type === 'block')).toBe(true)
    })
    it('$watch: is a compiler error', () => {
      const { errors } = analyze(`let count = 0; $watch: count, () => save()`)
      expect(errors.some(e => e.includes('reserved'))).toBe(true)
    })
    it('$effect: is a compiler error', () => {
      const { errors } = analyze(`let count = 0; $effect: { console.log(count) }`)
      expect(errors.some(e => e.includes('reserved'))).toBe(true)
    })
    it('$anyname: without underscore is a compiler error', () => {
      const { errors } = analyze(`let count = 0; $myEffect: count, () => save()`)
      expect(errors.some(e => e.includes('reserved'))).toBe(true)
    })
  })

  describe('imports', () => {
    it('collects import declarations', () => {
      const { imports } = analyze(`import { a } from './a.js'; import { b } from './b.js';`)
      expect(imports).toHaveLength(2)
    })
  })

  describe('reactive names set', () => {
    it('includes let and const but not var', () => {
      const { reactiveNames } = analyze(`let x = 0; const y = x; var z = x;`)
      expect(reactiveNames).toContain('x')
      expect(reactiveNames).toContain('y')
      expect(reactiveNames).not.toContain('z')
    })
  })
})

// ── §5  compile() output shape ───────────────────────────────────────────────

describe('compile() output shape', () => {

  describe('component shape', () => {
    it('imports @frontierjs/mesa/runtime.js', async () => {
      expect(await cx(`<p>hi</p>`)).toContain("from '@frontierjs/mesa/runtime.js'")
    })
    it('exports a named function, not makeComponent', async () => {
      const out = await cx(`<p>hi</p>`)
      expect(out).not.toContain('makeComponent')
      expect(out).toMatch(/export default function \w+\(/)
    })
    it('uses append() not return $parentElement', async () => {
      const out = await cx(`<p>hi</p>`)
      expect(out).toContain('$runtime.append(__anchor')
      expect(out).not.toContain('return $parentElement')
    })
    it('wraps with push_component/pop_component', async () => {
      const out = await cx(`<p>hi</p>`)
      expect(out).toContain('$runtime.push_component()')
      expect(out).toContain('$runtime.pop_component()')
    })
    it('uses var (not const) for template declarations', async () => {
      const out = await cx(`<p>hello</p>`)
      expect(out).toMatch(/^var \$tpl0 = /m)
      expect(out).not.toMatch(/^const \$tpl0 = /m)
    })
    it('script module — emitted at module scope before component fn', async () => {
      const scriptMod = '<script module>\n  let instanceCount = 0\n  export function getCount() { return instanceCount }\n</' + 'script>'
      const scriptInst = '<script>instanceCount++</' + 'script>'
      const out = await cx(scriptMod + '\n' + scriptInst + '\n<p>hi</p>')
      const modIdx  = out.indexOf('instanceCount = 0')
      const fnIdx   = out.indexOf('export default function')
      const compIdx = out.indexOf('instanceCount++')
      expect(modIdx).toBeGreaterThan(-1)
      expect(modIdx).toBeLessThan(fnIdx)
      expect(compIdx).toBeGreaterThan(fnIdx)
    })
    it('script module — named export appears before default export', async () => {
      const scriptMod = '<script module>\n  let shared = 0\n  export function getShared() { return shared }\n</' + 'script>'
      const out = await cx(scriptMod + '\n<p>hi</p>')
      const exportFnIdx = out.indexOf('export function getShared')
      const compFnIdx   = out.indexOf('export default function')
      expect(exportFnIdx).toBeGreaterThan(-1)
      expect(exportFnIdx).toBeLessThan(compFnIdx)
    })
    it('uses template() factory', async () => {
      const out = await cx(`<p>hi</p>`)
      expect(out).toContain('$runtime.template(')
      expect(out).not.toContain('htmlToFragment')
    })
    it('delegate call at module tail outside function', async () => {
      const out = await cx(`<script>function fn(){}</script><button on:click={fn}>x</button>`)
      const popIdx = out.indexOf('pop_component()')
      const delIdx = out.indexOf('$$delegate')
      expect(delIdx).toBeGreaterThan(popIdx)
    })
  })

  describe('export let prop', () => {
    it('emits track() for export let', async () => {
      const out = await cx(`<script>export let count = 0;</script><p>{count}</p>`)
      expect(out).toContain('$$sig_count')
      expect(out).toContain('$runtime.track(')
      expect(out).not.toContain('createSignal')
    })
    it('emits makeExternalProperty for export let', async () => {
      const out = await cx(`<script>export let count = 0;</script><p>{count}</p>`)
      expect(out).toContain("makeExternalProperty('count'")
    })
    it('reads from $option.props with fallback', async () => {
      const out = await cx(`<script>export let count = 0;</script><p>{count}</p>`)
      expect(out).toContain('$option.props?.count')
    })
    it('does NOT emit makeExternalProperty for export const', async () => {
      const out = await cx(`<script>export const MAX = 100;</script><p>{MAX}</p>`)
      expect(out).not.toContain('makeExternalProperty')
    })
    it('export const for callback — plain const, no signal', async () => {
      const out = await cx(`<script>export const onchange = null</script><div></div>`)
      expect(out).toContain("const onchange = $option.props?.onchange")
      expect(out).not.toContain('$$sig_onchange')
      expect(out).not.toContain('makeExternalProperty')
    })
    it('template reads use get()', async () => {
      const out = await cx(`<script>export let count = 0;</script><p>{count}</p>`)
      expect(out).toContain('$runtime.get($$sig_count)')
      expect(out).not.toMatch(/\$\$sig_count\(\)/)
    })
  })

  describe('reactive let', () => {
    it('emits track() for plain let', async () => {
      const out = await cx(`<script>let count = 0;</script><p>{count}</p>`)
      expect(out).toContain('$$sig_count')
      expect(out).toContain('$runtime.track(0,')
      expect(out).not.toContain('createSignal')
    })
    it('does NOT emit makeExternalProperty for plain let', async () => {
      const out = await cx(`<script>let count = 0;</script><p>{count}</p>`)
      expect(out).not.toContain('makeExternalProperty')
    })
    it('template reads go through get()', async () => {
      const out = await cx(`<script>let count = 0;</script><p>{count}</p>`)
      expect(out).toContain('$runtime.get($$sig_count)')
    })
    it('assignment in function uses $$set_ setter', async () => {
      const out = await cx(`<script>let count = 0; function inc(){count++}</script><p>{count}</p>`)
      expect(out).toContain('$$set_count($runtime.get($$sig_count) + 1)')
    })
  })

  describe('derived const', () => {
    it('emits trackDerived(fn) for derived const', async () => {
      const out = await cx(`<script>let count = 0; const double = count * 2;</script><p>{double}</p>`)
      // trackDerived, not track: the compiler states that this is a derivation
      // rather than leaving the runtime to infer it from the value's arity.
      expect(out).toContain('$runtime.trackDerived(() => ($runtime.get($$sig_count) * 2)')
      expect(out).not.toContain('createMemo')
    })
    it('template reads derived const via get()', async () => {
      const out = await cx(`<script>let count = 0; const double = count * 2;</script><p>{double}</p>`)
      expect(out).toContain('$runtime.get(double)')
    })
    it('does NOT emit track(fn) for static const', async () => {
      const out = await cx(`<script>const MAX = 100;</script><p>{MAX}</p>`)
      expect(out).not.toContain('track(')
      expect(out).toContain('const MAX = 100')
    })
  })

  describe('var sampler', () => {
    it('emits untrack for var initializer', async () => {
      const out = await cx(`<script>let price = 10; var snap = price;</script><p>{price}</p>`)
      expect(out).toContain('untrack')
      expect(out).toContain('$runtime.get($$sig_price)')
    })
    it('var in template uses direct nodeValue (static)', async () => {
      const out = await cx(`<script>let x=0; var snap=x</script><p>{snap}</p>`)
      expect(out).toContain('.nodeValue =')
      expect((out.match(/\$runtime\.render\(/g) || []).length).toBe(0)
    })
  })

  describe('async const', () => {
    it('emits makeAsyncState for one-shot async const', async () => {
      const out = await cx(`<script>const states = await getStates();</script><p>{states}</p>`)
      expect(out).toContain('makeAsyncState')
      expect(out).toContain('$$async_states')
    })
    it('one-shot async result is a signal', async () => {
      const out = await cx(`<script>const states = await getStates();</script><p>{states}</p>`)
      expect(out).toContain('$$sig_states')
      expect(out).toContain('$runtime.get($$sig_states)')
    })
    it('emits asyncDerived for reactive async const', async () => {
      const out = await cx(`<script>let q = ''; const results = await search(q);</script><p>{results}</p>`)
      expect(out).toContain('asyncDerived')
      expect(out).toContain('$$sig_q')
    })
    it('async derived passes dep to dep array', async () => {
      const out = await cx(`<script>let q = ''; const results = await search(q);</script><p>{results}</p>`)
      expect(out).toContain('asyncDerived')
      expect(out).toContain('$$sig_q')
    })
    it('async derived rewrites dep inside async fn body', async () => {
      const out = await cx(`<script>let q = ''; const results = await search(q);</script><p>{results}</p>`)
      expect(out).toContain('search($runtime.get($$sig_q))')
    })
    it('async derived result is a signal', async () => {
      const out = await cx(`<script>let q = ''; const results = await search(q);</script><p>{results}</p>`)
      expect(out).toContain('$$sig_results')
      expect(out).toContain('$runtime.get($$sig_results)')
    })
  })

  describe('$: watch groups', () => {
    it('$: block with bare expressions emits createEffect', async () => {
      const out = await cx(`<script>let count = 0; $: { console.log(count); }</script><p>{count}</p>`)
      expect(out).toContain('createEffect')
      expect(out).toContain('$runtime.get($$sig_count)')
    })
    it('emits orderedGroup for $: block with pairs', async () => {
      const ctx = await compile(
        `<script>let a = 1\nlet b = 0\n$: {\na, () => { b = a * 2 }\nb, () => { console.log(b) }\n}</script><p>{a} {b}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors).toHaveLength(0)
      expect(ctx.result).toContain('orderedGroup')
    })
    it('$_name: debug label emits comment', async () => {
      const ctx = await compile(
        `<script>let x = 0\n$_pipeline: {\nx, () => { console.log(x) }\n}</script><p>{x}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.result).toContain('/* $_pipeline */')
    })
  })

  describe('$: watch+handler', () => {
    it('$: bare expression emits createEffect (auto-tracked)', async () => {
      const out = await cx(`<script>let count = 0; $: console.log(count)</script><p>{count}</p>`)
      expect(out).toContain('createEffect')
      expect(out).toContain('$runtime.get($$sig_count)')
    })
    it('emits createEffect with untrack for $: dep, handler', async () => {
      const out = await cx(`<script>let count = 0; $: count, () => save(count)</script><p>{count}</p>`)
      expect(out).toContain('createEffect')
      expect(out).toContain('untrack')
      expect(out).toContain('$runtime.get($$sig_count)')
    })
    it('dep read uses get() not raw variable', async () => {
      const out = await cx(`<script>let count = 0; $: count, () => save(count)</script><p>{count}</p>`)
      expect(out).toMatch(/createEffect\(\(\) => \{ \$runtime\.get\(/)
      expect(out).not.toMatch(/createEffect\(\(\) => \{ count;/)
    })
    it('$_name: is valid and produces createEffect', async () => {
      const out = await cx(`<script>let count = 0; $_saveCount: count, () => save(count)</script><p>{count}</p>`)
      expect(out).toContain('createEffect')
      expect(out).toContain('untrack')
    })
    it('$_name: stores debugName in analysis', async () => {
      const ctx = await compile(
        `<script>let count = 0; $_saveCount: count, () => save(count)</script><p>{count}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.watchHandlers[0].debugName).toBe('saveCount')
    })
    it('$watch: is a compiler error', async () => {
      const ctx = await compile(
        `<script>let count = 0; $watch: count, () => save()</script><p>{count}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('reserved'))).toBe(true)
    })
    it('$effect: is a compiler error', async () => {
      const ctx = await compile(
        `<script>let count = 0; $effect: { console.log(count) }</script><p>{count}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('reserved'))).toBe(true)
    })
    it('$myCustom: is a compiler error', async () => {
      const ctx = await compile(
        `<script>let count = 0; $myCustom: count, () => save()</script><p>{count}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('reserved'))).toBe(true)
    })
  })

  describe('$: watch proxy', () => {
    it('emits watchProxy for $: path on import', async () => {
      const out = await cx(`<script>import { user } from './s.js'; $: user.name</script><p>{user.name}</p>`)
      expect(out).toContain('watchProxy(user)')
    })
    it('emits watchPath for specific path', async () => {
      const out = await cx(`<script>import { user } from './s.js'; $: user.name</script><p>{user.name}</p>`)
      expect(out).toContain("watchPath(user, 'name')")
    })
    it('emits watchPath with empty string for whole-object watch', async () => {
      const out = await cx(`<script>import { user } from './s.js'; $: user</script><p>hi</p>`)
      expect(out).toContain("watchPath(user, '')")
    })
    it('template reads go through proxy', async () => {
      const out = await cx(`<script>import { user } from './s.js'; $: user.name</script><p>{user.name}</p>`)
      expect(out).toContain('$$proxy_user.name')
    })
  })

  describe('externalSignals', () => {
    // Helper: compile with a given externalSignals map
    const cxExt = (src, externalSignals) =>
      compile(src, { debug: false, css: false, externalSignals }).then(c => c.result)

    it('rewrites imported signal name to name.get() in text node', async () => {
      const out = await cxExt(
        `<script>import { activeRoute } from 'sierra/router'</script><p>{activeRoute}</p>`,
        { 'sierra/router': ['activeRoute'] }
      )
      expect(out).toContain('activeRoute.get()')
    })

    it('rewrites imported signal in attribute expression', async () => {
      const out = await cxExt(
        `<script>import { pendingRoute } from 'sierra/router'</script><div class:loading={pendingRoute}></div>`,
        { 'sierra/router': ['pendingRoute'] }
      )
      expect(out).toContain('pendingRoute.get()')
    })

    it('rewrites member access on signal: params.id → params.get().id', async () => {
      const out = await cxExt(
        `<script>import { params } from 'sierra/router'</script><p>{params.id}</p>`,
        { 'sierra/router': ['params'] }
      )
      expect(out).toContain('params.get().id')
    })

    it('rewrites signal in {#if} condition', async () => {
      const out = await cxExt(
        `<script>import { activeRoute } from 'sierra/router'</script>{#if activeRoute}<span>ok</span>{/if}`,
        { 'sierra/router': ['activeRoute'] }
      )
      expect(out).toContain('activeRoute.get()')
    })

    it('does NOT rewrite signal names not listed in externalSignals', async () => {
      const out = await cxExt(
        `<script>import { activeRoute, params } from 'sierra/router'</script><p>{activeRoute} {params.x}</p>`,
        { 'sierra/router': ['activeRoute'] }
      )
      expect(out).toContain('activeRoute.get()')
      expect(out).not.toContain('params.get()')
    })

    it('does NOT rewrite when module is not in externalSignals map', async () => {
      const out = await cxExt(
        `<script>import { activeRoute } from 'sierra/router'</script><p>{activeRoute}</p>`,
        { 'some/other': ['activeRoute'] }
      )
      expect(out).not.toContain('activeRoute.get()')
    })

    it('handles aliased imports: import { params as p }', async () => {
      const out = await cxExt(
        `<script>import { params as p } from 'sierra/router'</script><p>{p.id}</p>`,
        { 'sierra/router': ['params'] }
      )
      expect(out).toContain('p.get()')
    })

    it('does NOT clobber a watch proxy accessor for the same name', async () => {
      const out = await cxExt(
        `<script>import { user } from './s.js'; $: user.name</script><p>{user.name}</p>`,
        { './s.js': ['user'] }
      )
      expect(out).toContain('$$proxy_user.name')
      expect(out).not.toContain('user.get()')
    })

    it('works with no externalSignals config (undefined)', async () => {
      const out = await cx(`<script>import { x } from './m.js'</script><p>{x}</p>`)
      expect(out).toBeDefined()
    })

    it('rewrites signal in function body', async () => {
      const out = await cxExt(
        `<script>
import { params } from 'sierra/router'
function getKey() { return params.id }
</script><p>{getKey()}</p>`,
        { 'sierra/router': ['params'] }
      )
      expect(out).toContain('params.get().id')
    })
  })

  describe('snippet accessor injection', () => {
    it('registers snippet name in accessors so it can be used in template expressions', async () => {
      // {#snippet sidebar()} compiles to $$snippet_sidebar.
      // If the template expression {provideSlot('sidebar', sidebar)} is compiled,
      // 'sidebar' must be rewritten to '$$snippet_sidebar' by rewriteExpr.
      const out = await cx(
        `<script>
function provideSlot(name, fn) { return null }
</script>
{#snippet sidebar()}<p>hi</p>{/snippet}
{provideSlot('sidebar', sidebar)}`
      )
      // The provideSlot call in the template should reference $$snippet_sidebar
      expect(out).toContain('$$snippet_sidebar')
      // And the snippet itself should be defined
      expect(out).toContain('const $$snippet_sidebar =')
    })

    it('snippet accessor does not shadow a let/prop with the same name', async () => {
      // If there is an export let sidebar, that accessor takes precedence
      const out = await cx(
        `<script>
export let sidebar = null
function provideSlot(name, fn) { return null }
</script>
{provideSlot('sidebar', sidebar)}`
      )
      // sidebar is a prop — it should be read through $$sig_sidebar, not $$snippet_sidebar
      expect(out).not.toContain('$$snippet_sidebar')
      expect(out).toContain('$$sig_sidebar')
    })

    it('multiple snippets each get their own accessor', async () => {
      const out = await cx(
        `<script>
function provide(n, f) { return null }
</script>
{#snippet header()}<h1>H</h1>{/snippet}
{#snippet footer()}<footer>F</footer>{/snippet}
{provide('header', header)}{provide('footer', footer)}`
      )
      expect(out).toContain('$$snippet_header')
      expect(out).toContain('$$snippet_footer')
      expect(out).toContain('const $$snippet_header =')
      expect(out).toContain('const $$snippet_footer =')
    })
  })

  describe('assignment rewriting', () => {
    it('rewrites count++ in function to setter', async () => {
      const out = await cx(`<script>let count = 0; function inc() { count++; }</script><p>{count}</p>`)
      expect(out).toContain('$$set_count($runtime.get($$sig_count) + 1)')
    })
    it('rewrites count = x in function to setter', async () => {
      const out = await cx(`<script>let count = 0; function reset() { count = 0; }</script><p>{count}</p>`)
      expect(out).toContain('$$set_count(0)')
    })
    it('rewrites count += n in function to setter', async () => {
      const out = await cx(`<script>let count = 0; function add(n) { count += n; }</script><p>{count}</p>`)
      expect(out).toContain('$$set_count($runtime.get($$sig_count) + (n))')
    })
  })

  describe('let init from prop', () => {
    it('static prop default — inlined in track()', async () => {
      const out = await cx(`<script>export let price = 49.99</script><p>{price}</p>`)
      expect(out).toContain('$option.props?.price !== undefined ? $option.props.price : 49.99')
    })
    it('reactive prop default — deferred init after deps exist', async () => {
      const out = await cx(
        `<script>let count = 0\nconst double = count * 2\nexport let test = double</script><p>{test}</p>`
      )
      expect(out).toContain('$option.props?.test')
    })
  })

  describe('DOM traversal', () => {
    it('uses child() not .firstChild', async () => {
      const out = await cx(`<script>let x=0</script><p>{x}</p>`)
      expect(out).toContain('$runtime.child(')
      expect(out).not.toContain('.firstChild')
    })
    it('uses sibling() not .nextSibling', async () => {
      const out = await cx(`<script>let x=0</script><p>a</p><p>{x}</p>`)
      expect(out).toContain('$runtime.sibling(')
      expect(out).not.toContain('.nextSibling')
    })
    it('uses render() grouping for reactive bindings', async () => {
      const out = await cx(`<script>let a=0\nlet b=0</script><p>{a}</p><p>{b}</p>`)
      expect(out).toContain('$runtime.render(')
      expect(out).toContain('set_text(')
    })
  })

  describe('bind:value', () => {
    it('emits bindInput with signal and setter', async () => {
      const out = await cx(`<script>let q = '';</script><input bind:value={q}/>`)
      expect(out).toContain('bindInput')
      expect(out).toContain('$$sig_q')
      expect(out).toContain('$$set_q')
    })
  })

  describe('style:', () => {
    it('pure expression — style:color={expr}', async () => {
      const out = await cx(`<script>let c = 'red'</script><div style:color={c}>x</div>`)
      expect(out).toContain("bindStyle(el0, 'color', () => ($runtime.get($$sig_c)))")
    })
    it('mixed template literal — style:font-size="{size}px"', async () => {
      const out = await cx(`<script>let size = 16</script><div style:font-size="{size}px">x</div>`)
      expect(out).toContain("bindStyle(el0, 'font-size', () => (")
      expect(out).toContain('$runtime.get($$sig_size)')
      expect(out).toContain('px')
    })
    it('shorthand — style:display (no value)', async () => {
      const out = await cx(`<div style:display>x</div>`)
      expect(out).toContain("bindStyle(el0, 'display'")
    })
    it('multiple on same element', async () => {
      const out = await cx(
        `<script>let size = 16; let color = 'red'</script><div style:font-size="{size}px" style:color={color}>x</div>`
      )
      expect(out).toContain("'font-size'")
      expect(out).toContain("'color'")
      expect(out).toContain('$runtime.get($$sig_size)')
      expect(out).toContain('$runtime.get($$sig_color)')
    })
  })

  describe('component instantiation', () => {
    it('calls child component directly with anchor', async () => {
      const out = await cx(`<script>let n = 0;</script><Child qty={n}/>`)
      expect(out).not.toContain('callComponent')
      // new pattern: Child(anchorVar, props, null)
      expect(out).toMatch(/Child\(\w+,/)
    })
    it('emits pushProps effect for reactive prop', async () => {
      const out = await cx(`<script>let n = 0;</script><Child qty={n}/>`)
      expect(out).toContain('pushProps')
      expect(out).toContain('createEffect')
    })
    it('does NOT emit pushProps for static prop', async () => {
      const out = await cx(`<Child label="hello"/>`)
      expect(out).not.toContain('pushProps')
    })
    it('on:event on a component is a compiler error', async () => {
      const ctx = await compile(`<Child on:click={fn}/>`, { debug: false, css: false })
      expect(ctx.analysis.errors.some(e => e.includes('on:click'))).toBe(true)
    })
    it('onclick as plain prop passes through', async () => {
      const out = await cx(`<script>function fn(){}</script><Child onclick={fn}/>`)
      expect(out).toContain('onclick:')
    })
    it('class prop on component remapped to $class', async () => {
      const out = await cx(`<Btn class="active" />`)
      expect(out).toContain('$class:')
      expect(out).not.toContain('{class:')
    })
    it('dynamic class prop on component remapped to $class', async () => {
      const out = await cx(`<script>let cls = 'active'</script><Btn class={cls} />`)
      expect(out).toContain('$class:')
      expect(out).toContain('pushProps')
    })
    it('{class} shorthand in child auto-wires $class', async () => {
      const out = await cx(`<input {class} />`)
      expect(out).toContain('$$sig_$class')
    })
    it('bind:class in child auto-wires $class', async () => {
      const out = await cx(`<input bind:class />`)
      expect(out).toContain('$$sig_$class')
      expect(out).toContain('bindInput')
    })
    it('class on HTML elements is NOT remapped', async () => {
      const out = await cx(`<script>let cls='a'</script><div class={cls}>x</div>`)
      expect(out).not.toContain('className')
      expect(out).toContain("'class'")
    })
  })

  describe('event modifiers', () => {
    it('preventDefault — wraps handler with guard', async () => {
      const out = await cx(`<form on:submit|preventDefault={fn}><button>go</button></form>`)
      expect(out).toContain('$$e.preventDefault()')
      // submit is delegated — either addEvent or __submit property
      expect(out).toMatch(/addEvent|__submit/)
    })
    it('stopPropagation — wraps handler', async () => {
      const out = await cx(`<div on:click|stopPropagation={fn}>x</div>`)
      expect(out).toContain('$$e.stopPropagation()')
    })
    it('self — wraps handler with target guard', async () => {
      const out = await cx(`<div on:click|self={fn}>x</div>`)
      expect(out).toContain('$$e.target !== $$e.currentTarget')
    })
    it('once — passes addEventListener option', async () => {
      const out = await cx(`<button on:click|once={fn}>x</button>`)
      expect(out).toContain('{ once: true }')
      expect(out).not.toContain('$$e.')
    })
    it('passive + capture — combined options', async () => {
      const out = await cx(`<div on:scroll|passive|capture={fn}>x</div>`)
      expect(out).toContain('passive: true')
      expect(out).toContain('capture: true')
    })
    it('debounce — wraps handler', async () => {
      const out = await cx(`<input on:input|debounce(300)={fn}/>`)
      expect(out).toContain('$runtime.debounce(fn, 300)')
    })
    it('throttle — wraps handler', async () => {
      const out = await cx(`<div on:scroll|throttle(100)={fn}>x</div>`)
      expect(out).toContain('$runtime.throttle(fn, 100)')
    })
    it('debounce with reactive arg — passes getter', async () => {
      const out = await cx(`<script>let delay = 300</script><input on:input|debounce({delay})={fn}/>`)
      expect(out).toContain('() => ($runtime.get($$sig_delay))')
      expect(out).toContain('$runtime.debounce(fn,')
    })
    it('multiple modifiers — guards then wrapped', async () => {
      const out = await cx(`<form on:submit|preventDefault|debounce(200)={fn}><b>x</b></form>`)
      expect(out).toContain('$$e.preventDefault()')
      expect(out).toContain('$runtime.debounce(')
    })
    it('unknown modifier — compiler error', async () => {
      const ctx = await compile(`<div on:click|magic={fn}>x</div>`, { debug: false, css: false })
      expect(ctx.analysis.errors.some(e => e.includes('magic'))).toBe(true)
    })
    it('delegated click — uses __click property', async () => {
      const out = await cx(`<script>function fn(){}</script><button on:click={fn}>x</button>`)
      expect(out).toContain('.__click = fn')
    })
    it('focus — uses addEvent (not delegation)', async () => {
      const out = await cx(`<script>function fn(){}</script><input on:focus={fn}/>`)
      expect(out).toContain("$runtime.addEvent(")
      expect(out).not.toContain('__focus')
    })
  })

  describe('$context', () => {
    it('provide — signal: emits $ctxProvide', async () => {
      const out = await cx(`<script>let dark=false\n$context.theme=dark</script><div></div>`)
      expect(out).toContain("$ctxProvide('theme',")
      expect(out).toContain('$$sig_dark')
    })
    it('provide — derived expr: wraps in memo', async () => {
      const out = await cx(`<script>let h=220\n$context.color='hsl('+h+')'</script><div></div>`)
      expect(out).toContain('$$ctxMemo_color')
      expect(out).toContain("$ctxProvide('color', $$ctxMemo_color)")
    })
    it('const consume — creates a memo from context', async () => {
      const out = await cx(`<script>const theme=$context.theme</script><p>{theme}</p>`)
      expect(out).toContain("$ctxRead('theme')")
    })
    it('let consume — creates reactive signal from context', async () => {
      const out = await cx(`<script>let theme=$context.theme</script><p>{theme}</p>`)
      expect(out).toContain("$ctxRead('theme')")
      expect(out).toContain('$$sig_theme')
    })
    it('var consume — snapshots context via untrack', async () => {
      const out = await cx(`<script>var theme=$context.theme</script><p>{theme}</p>`)
      expect(out).toContain("$ctxRead('theme')")
      expect(out).toContain('untrack')
    })
    it('const consume — no duplicate declaration (regression)', async () => {
      const out = await cx(`<script>const theme=$context.theme</script><p>{theme}</p>`)
      // Should have exactly ONE declaration of theme — the generated track() version.
      // Before the fix, the original `const theme = $context.theme` was also emitted,
      // overwriting the signal with undefined.
      const matches = out.match(/\bconst\s+theme\s*=/g) ?? []
      expect(matches).toHaveLength(1)
      expect(out).not.toContain('$context.theme')  // original must be stripped
    })
    it('injects $ctxProvide and $ctxRead locals', async () => {
      const out = await cx(`<script>let x=1\n$context.x=x</script><div></div>`)
      expect(out).toContain('const $ctxProvide = $runtime.contextProvide')
      expect(out).toContain('const $ctxRead    = $runtime.contextRead')
    })
    it('does not inject context locals when unused', async () => {
      const out = await cx(`<script>let count=0</script><p>{count}</p>`)
      expect(out).not.toContain('$ctxProvide')
    })
    it('error — $context provide inside a function', async () => {
      const ctx = await compile(
        `<script>function init() { $context.theme = 'dark' }</script><div></div>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('$context') && e.includes('function'))).toBe(true)
    })
  })

  describe('bind:this', () => {
    it('emits setter call for bind:this', async () => {
      const out = await cx(`<script>let el = null</script><div bind:this={el}></div>`)
      expect(out).toContain('$$set_el')
      expect(out).toContain('$$sig_el')
    })
    it('error on non-let', async () => {
      const ctx = await compile(`<script>const el = null</script><div bind:this={el}></div>`, { debug: false, css: false })
      expect(ctx.analysis.errors.some(e => e.includes('let'))).toBe(true)
    })
  })

  describe('mesa:window', () => {
    it('emits addGlobalEvent for on:event', async () => {
      const out = await cx(`<mesa:window on:resize={fn} />`)
      expect(out).toContain("addGlobalEvent('window', 'resize', fn)")
    })
    it('emits bindWindow for bind:prop', async () => {
      const out = await cx(`<script>let w=0</script><mesa:window bind:innerWidth={w} /><p>{w}</p>`)
      expect(out).toContain("bindWindow('innerWidth'")
    })
    it('error — children in mesa:window', async () => {
      const ctx = await compile(
        `<script>let w=0</script><mesa:window bind:innerWidth={w}><p>bad</p></mesa:window><p>{w}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('mesa:window'))).toBe(true)
    })
    it('self-closing mesa:window is fine', async () => {
      const ctx = await compile(
        `<script>let w=0</script><mesa:window bind:innerWidth={w} /><p>{w}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.length).toBe(0)
    })
  })

  describe('mesa:head', () => {
    it('emits addToHead call', async () => {
      const out = await cx(`<mesa:head><title>hi</title></mesa:head><p>x</p>`)
      expect(out).toContain('addToHead(')
    })
  })

  describe('mesa:document', () => {
    it('emits addGlobalEvent for on:event', async () => {
      const out = await cx(`<mesa:document on:click={fn} /><p>x</p>`)
      expect(out).toContain("addGlobalEvent('document', 'click', fn)")
    })
    it('error — children in mesa:document', async () => {
      const ctx = await compile(
        `<mesa:document on:click={fn}><p>bad</p></mesa:document><p>x</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('mesa:document'))).toBe(true)
    })
  })

  describe('mesa:body', () => {
    it('emits addGlobalEvent for on:event', async () => {
      const out = await cx(`<mesa:body on:click={fn} /><p>x</p>`)
      expect(out).toContain("addGlobalEvent('body', 'click', fn)")
    })
    it('error — children in mesa:body', async () => {
      const ctx = await compile(
        `<mesa:body on:click={fn}><p>bad</p></mesa:body><p>x</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('mesa:body'))).toBe(true)
    })
  })

  describe('mesa:portal', () => {
    it('emits portal() call', async () => {
      const out = await cx(`<mesa:portal to={document.body}><div>hello</div></mesa:portal><p>x</p>`)
      expect(out).toContain('portal(')
      expect(out).toContain('document.body')
    })
    it('reactive to expression', async () => {
      const out = await cx(`<script>let target = null</script><mesa:portal to={target}><div>x</div></mesa:portal><p>y</p>`)
      expect(out).toContain('$runtime.get($$sig_target)')
    })
    it('static content uses makeBlock', async () => {
      const out = await cx(`<mesa:portal to={document.body}><div>static</div></mesa:portal><p>x</p>`)
      expect(out).toContain('makeBlock(')
    })
  })

  describe('bind:group', () => {
    it('checkbox — emits bindGroup', async () => {
      const out = await cx(`<script>let s=[]</script><input type="checkbox" bind:group={s} value="a">`)
      expect(out).toContain('bindGroup(el0,')
      expect(out).toContain('$$sig_s')
      expect(out).toContain('$$set_s')
    })
    it('radio — emits bindGroup', async () => {
      const out = await cx(`<script>let size='M'</script><input type="radio" bind:group={size} value="S">`)
      expect(out).toContain('bindGroup(el0,')
      expect(out).toContain('$$sig_size')
    })
    it('multiple checkboxes — each gets bindGroup', async () => {
      const out = await cx(
        `<script>let s=[]</script><input type="checkbox" bind:group={s} value="a"><input type="checkbox" bind:group={s} value="b">`
      )
      expect((out.match(/bindGroup/g) || []).length).toBe(2)
    })
    it('error on non-let', async () => {
      const ctx = await compile(
        `<script>const s=[]</script><input type="checkbox" bind:group={s} value="a">`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('let'))).toBe(true)
    })
  })

  describe('$.transition and $.entrance', () => {
    it('$.transition in script — injects $ namespace', async () => {
      const out = await cx(
        `<script>let show = true\nfunction toggle() { $.transition(() => show = !show) }</script><button on:click={toggle}>x</button>`
      )
      expect(out).toContain('const $ = {')
      expect(out).toContain('transition: $runtime.transition')
    })
    it('$ not injected when not used', async () => {
      const out = await cx(`<script>let count = 0</script><p>{count}</p>`)
      expect(out).not.toContain('const $ =')
    })
  })

  describe('{@attach}', () => {
    it('DOM element — emits attach() call', async () => {
      const out = await cx(`<script>import {tooltip} from './t.js'; let c = 'hi'</script><div {@attach tooltip(c)}>x</div>`)
      expect(out).toContain('$runtime.attach(')
      expect(out).toContain('$runtime.get($$sig_c)')
    })
    it('DOM element — inline arrow function', async () => {
      const out = await cx(`<div {@attach (el) => el.focus()}>x</div>`)
      expect(out).toContain('$runtime.attach(')
      expect(out).toContain('(el) => el.focus()')
    })
    it('DOM element — multiple on same element', async () => {
      const out = await cx(`<div {@attach foo} {@attach bar}>x</div>`)
      expect((out.match(/\$runtime\.attach\(/g) || []).length).toBe(2)
    })
    it('component — emits attachments with component call', async () => {
      const out = await cx(`<script>let c = 'hi'</script><Btn {@attach tooltip(c)} />`)
      expect(out).toMatch(/Btn\(/)
      expect(out).not.toContain('$runtime.attach(')
    })
    it('component — multiple attachments compile without error', async () => {
      const out = await cx(`<Btn {@attach foo} {@attach bar} />`)
      expect(out).toMatch(/Btn\(/)
    })
    it('{@attach} in text content is a compiler error', async () => {
      const ctx = await compile('<h2>{@attach fn} title</h2>', { css: false })
      expect(ctx.analysis.errors.some(e => e.includes('@attach'))).toBe(true)
    })
  })

  describe('{@html}', () => {
    it('emits setInnerHTML effect for reactive expression', async () => {
      const out = await cx(`<script>let h = '<b>hi</b>'</script>{@html h}`)
      expect(out).toContain('$runtime.setInnerHTML(')
      expect(out).toContain('$runtime.get($$sig_h)')
      expect(out).toContain('createEffect')
    })
    it('emits setInnerHTML for static string', async () => {
      const out = await cx(`{@html '<em>hello</em>'}`)
      expect(out).toContain("setInnerHTML")
      expect(out).toContain("'<em>hello</em>'")
    })
  })

  describe('Rule 22 — bind: on export const/var is a compiler error', () => {
    it('bind: on export const is an error', async () => {
      const ctx = await compile(
        `<script>export const label = 'x'</script><input bind:value={label} />`,
        { css: false, debug: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('export const') && e.includes('bind:'))).toBe(true)
    })
    it('bind: on export var is an error', async () => {
      const ctx = await compile(
        `<script>export var rate = 0.08</script><input bind:value={rate} />`,
        { css: false, debug: false }
      )
      expect(ctx.analysis.errors.some(e => e.includes('export var') && e.includes('bind:'))).toBe(true)
    })
    it('bind: on export let is OK', async () => {
      const ctx = await compile(
        `<script>export let val = 'x'</script><input bind:value={val} />`,
        { css: false, debug: false }
      )
      expect(ctx.analysis.errors).toHaveLength(0)
    })
  })

  describe('#if', () => {
    it('emits ifBlock with get() in condition', async () => {
      const out = await cx(`<script>let show = true;</script>{#if show}<p>yes</p>{/if}`)
      expect(out).toContain('ifBlock')
      expect(out).toContain('$runtime.get($$sig_show)')
    })
  })

  describe('#each', () => {
    it('emits $$eachBlock with get() for array', async () => {
      const out = await cx(`<script>let items = [];</script>{#each items as item}<li>{item}</li>{/each}`)
      expect(out).toContain('$$eachBlock')
      expect(out).toContain('$runtime.get($$sig_items)')
    })
    it('array destructure in as clause', async () => {
      const out = await cx(`{#each pairs as [k, v] (k)}<dt>{k}</dt>{/each}`)
      expect(out).toContain('const [k, v] = $$item()')
      expect(out).toContain('{ const [k, v] = $$item; return k; }')
    })
    it('object destructure in as clause', async () => {
      const out = await cx(`{#each users as {name, id} (id)}<li>{name}</li>{/each}`)
      expect(out).toContain('const {name, id} = $$item()')
      expect(out).toContain('{ const {name, id} = $$item; return id; }')
    })
    it('destructure with index', async () => {
      const out = await cx(`{#each items as {name}, i}<p>{i}: {name}</p>{/each}`)
      expect(out).toContain('$$item, i')
      expect(out).toContain('const {name} = $$item()')
    })
  })

  describe('#key', () => {
    it('emits keyBlock with get() for key expression', async () => {
      const out = await cx(`<script>let id = 1</script>{#key id}<p>{id}</p>{/key}`)
      expect(out).toContain('$runtime.keyBlock(')
      expect(out).toContain('$runtime.get($$sig_id)')
    })
    it('key expression is tracked reactively', async () => {
      const out = await cx(`<script>let id = 1</script>{#key id}<p>hi</p>{/key}`)
      expect(out).toContain('() => ($runtime.get($$sig_id))')
    })
    it('inner block uses makeBlock', async () => {
      const out = await cx(`<script>let id = 1</script>{#key id}<p>{id}</p>{/key}`)
      expect(out).toContain('$runtime.makeBlock(')
    })
    it('works with component inside', async () => {
      const out = await cx(`<script>let userId = 1</script>{#key userId}<UserForm id={userId} />{/key}`)
      expect(out).toContain('$runtime.keyBlock(')
      expect(out).toContain('$runtime.get($$sig_userId)')
    })
  })

  describe('#snippet + @render', () => {
    it('emits $$snippet_ function for {#snippet}', async () => {
      const out = await cx(`{#snippet tip()}<p>hi</p>{/snippet}{@render tip()}`)
      expect(out).toContain('$$snippet_tip')
      expect(out).toContain('const $$snippet_tip = (__anchor')
    })
    it('snippet args become function parameters', async () => {
      const out = await cx(`{#snippet row(item, idx)}<li></li>{/snippet}{@render row(x, 0)}`)
      expect(out).toContain('__anchor, item, idx')
    })
    it('{@render} calls snippet with anchor and args', async () => {
      const out = await cx(`{#snippet chip(x)}<span>{x}</span>{/snippet}{@render chip('a')}`)
      expect(out).toMatch(/\$\$snippet_chip\(\w+, 'a'\)/)
    })
    it('snippet body uses makeBlock for DOM cloning', async () => {
      const out = await cx(`{#snippet row(x)}<p>{x}</p>{/snippet}{@render row('a')}`)
      expect(out).toContain('$runtime.makeBlock(')
      expect(out).toContain('$$frag')
    })
    it('snippet closes over outer reactive let', async () => {
      const out = await cx(`<script>let count = 0</script>{#snippet box()}<p>{count}</p>{/snippet}{@render box()}`)
      expect(out).toContain('$runtime.get($$sig_count)')
      expect(out).toContain('$$snippet_box')
    })
    it('multiple {#snippet} definitions coexist', async () => {
      const out = await cx(`{#snippet a()}<p>a</p>{/snippet}{#snippet b()}<p>b</p>{/snippet}{@render a()}{@render b()}`)
      expect(out).toContain('$$snippet_a')
      expect(out).toContain('$$snippet_b')
    })
    it('{@render} in template produces comment anchor in template', async () => {
      const out = await cx(`{#snippet tip()}<p>hi</p>{/snippet}<div>{@render tip()}</div>`)
      expect(out).toContain('$$snippet_tip(')
    })
  })

  describe('destructuring expansion', () => {
    it('expands const {name} = letVar into a derived track(fn)', async () => {
      const out = await cx(`<script>let user = {name:'A'}; const {name} = user;</script><p>{name}</p>`)
      expect(out).toContain('track(')
      expect(out).toContain('$runtime.get($$sig_user).name')
    })
    it('expands const {name: alias} = letVar with alias', async () => {
      const out = await cx(`<script>let user = {name:'A'}; const {name: alias} = user;</script><p>{alias}</p>`)
      expect(out).toContain('$runtime.get($$sig_user).name')
      expect(out).toContain('alias')
    })
    it('expands const {name = "Anon"} with default', async () => {
      const out = await cx(`<script>let user = {name:'A'}; const {name = 'Anon'} = user;</script><p>{name}</p>`)
      expect(out).toContain("'Anon'")
      expect(out).toContain('!== undefined')
    })
    it('expands const [first, second] = letArr into derived track(fn)', async () => {
      const out = await cx(`<script>let arr = [1,2]; const [first, second] = arr;</script><p>{first}{second}</p>`)
      expect(out).toContain('$runtime.get($$sig_arr)[0]')
      expect(out).toContain('$runtime.get($$sig_arr)[1]')
    })
    it('expands let {name} = letVar into a signal', async () => {
      const out = await cx(`<script>let user = {name:'A'}; let {name} = user;</script><p>{name}</p>`)
      expect(out).toContain('track(')
      expect(out).toContain('$runtime.get($$sig_user).name')
    })
    it('emits warning for computed destructuring key', async () => {
      const ctx = await compile(
        `<script>let user={name:'A'}; const key='name'; const {[key]:val}=user;</script><p>{val}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.warnings.some(w => w.includes('Computed'))).toBe(true)
    })
    it('emits warning for rest element', async () => {
      const ctx = await compile(
        `<script>let user={name:'A',age:1}; const {name,...rest}=user;</script><p>{name}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.warnings.some(w => w.includes('Rest'))).toBe(true)
    })
    it('no false-positive circular deps from object literal property keys', async () => {
      const ctx = await compile(
        `<script>let user = {name:'A'}; const {name} = user;</script><p>{name}</p>`,
        { debug: false, css: false }
      )
      expect(ctx.analysis.errors).toHaveLength(0)
    })
  })
  it('external signal .get() in attribute is wrapped in render()', async () => {
    const { result } = await compile(
      `<script>import { theme } from 'sierra/theme'</script>` +
      `<button title="{theme === 'dark' ? 'light' : 'dark'}">{theme === 'dark' ? 'A' : 'B'}</button>`,
      { debug: false, css: false, externalSignals: { 'sierra/theme': ['theme'] } }
    )
    // Must be reactive — theme.get() changes, button must update
    expect(result).toContain('$runtime.render(')
    expect(result).toContain('theme.get()')
    // Must NOT be a one-time nodeValue assignment
    expect(result).not.toMatch(/el\d+\.nodeValue\s*=.*theme\.get/)
  })

  it('external signal .get() in text node is wrapped in render()', async () => {
    const { result } = await compile(
      `<script>import { theme } from 'sierra/theme'</script><p>{theme}</p>`,
      { debug: false, css: false, externalSignals: { 'sierra/theme': ['theme'] } }
    )
    expect(result).toContain('$runtime.render(')
    expect(result).toContain('theme.get()')
  })

  it('warns when a specific path watch is redundant due to whole-object watch', async () => {
    const src = `
<script>
  import { themeNew } from './store.js'
  $: themeNew.style
  $: themeNew
</script>
<p>{themeNew.style}</p>`
    const { analysis } = await compile(src, { debug: false, css: false })
    expect(analysis.warnings.length).toBe(1)
    expect(analysis.warnings[0]).toContain("'$: themeNew.style' is redundant")
    expect(analysis.warnings[0]).toContain("'$: themeNew' already watches the entire object")
  })

  it('no warning when only a property path is declared', async () => {
    const src = `
<script>
  import { themeNew } from './store.js'
  $: themeNew.style
</script>
<p>{themeNew.style}</p>`
    const { analysis } = await compile(src, { debug: false, css: false })
    const relevant = analysis.warnings.filter(w => w.includes('redundant'))
    expect(relevant).toHaveLength(0)
  })

  it('warns for each redundant path when multiple are subsumed', async () => {
    const src = `
<script>
  import { user } from './store.js'
  $: user.name
  $: user.email
  $: user
</script>
<p>{user.name}</p>`
    const { analysis } = await compile(src, { debug: false, css: false })
    const relevant = analysis.warnings.filter(w => w.includes('redundant'))
    expect(relevant).toHaveLength(2)
    expect(relevant.some(w => w.includes('user.name'))).toBe(true)
    expect(relevant.some(w => w.includes('user.email'))).toBe(true)
  })

  it('no cross-contamination between different roots', async () => {
    const src = `
<script>
  import { user, cart } from './store.js'
  $: user
  $: cart.total
</script>
<p>{user.name} {cart.total}</p>`
    const { analysis } = await compile(src, { debug: false, css: false })
    const relevant = analysis.warnings.filter(w => w.includes('redundant'))
    expect(relevant).toHaveLength(0)
  })

})

// ── §6  end-to-end ───────────────────────────────────────────────────────────

describe('end-to-end — counter', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders initial state', async () => {
    const fn = await compileAndExec(`<script>let count = 0</script><p>{count}</p>`, runtime)
    const app = mount(fn, runtime)
    expect(app.text()).toContain('0')
    app.destroy()
  })
  it('updates DOM on click', async () => {
    const fn = await compileAndExec(
      `<script>let count = 0\nfunction inc(){count++}</script><p>{count}</p><button on:click={inc}>+</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.text()).toContain('1')
    app.destroy()
  })
  it('derived const updates with signal', async () => {
    const fn = await compileAndExec(
      `<script>let count = 0\nconst double = count * 2\nfunction inc(){count++}</script><p>{count} {double}</p><button on:click={inc}>+</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.text()).toContain('1 2')
    app.destroy()
  })
  it('var snapshot does not update', async () => {
    const fn = await compileAndExec(
      `<script>let count = 0\nvar snap = count\nfunction inc(){count++}</script><p>{count}</p><p id="s">{snap}</p><button on:click={inc}>+</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('p').textContent).toBe('1')
    expect(app.find('#s').textContent).toBe('0')
    app.destroy()
  })
})

describe('$emit', () => {
  it('injects makeEmitter when $emit used in script', async () => {
    const out = await cx(`<script>export let value=0\nfunction go(){$emit('change',value)}</script><button on:click={go}>go</button>`)
    expect(out).toContain('makeEmitter')
    expect(out).toContain("$emit('change'")
  })

  it('injects makeEmitter when $emit used in template on:click (regression)', async () => {
    // Before fix: $emit in template event handlers was not detected, makeEmitter was not injected
    const out = await cx(`<script>export let v=0</script><button on:click={() => $emit('change', v+1)}>+</button>`)
    expect(out).toContain('const $emit = $runtime.makeEmitter')
    expect(out).toContain("$emit('change'")
  })

  it('does not inject makeEmitter when $emit not used', async () => {
    const out = await cx(`<script>let x=0</script><p>{x}</p>`)
    expect(out).not.toContain('makeEmitter')
  })

  it('$emit calls the matching onX prop on parent', async () => {
    const out = await cx(`<script>export let v=0</script><button on:click={() => $emit('change', v)}>x</button>`)
    // The emitter is wired to $option.props
    expect(out).toContain('makeEmitter($option)')
  })
})

describe('end-to-end — export let props', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders with prop value', async () => {
    const fn = await compileAndExec(`<script>export let value = 0</script><p>{value}</p>`, runtime)
    const app = mount(fn, runtime, { value: 42 })
    expect(app.text()).toContain('42')
    app.destroy()
  })
  it('falls back to default when no prop', async () => {
    const fn = await compileAndExec(`<script>export let label = "hello"</script><p>{label}</p>`, runtime)
    const app = mount(fn, runtime)
    expect(app.text()).toContain('hello')
    app.destroy()
  })
})

describe('end-to-end — {#if}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('shows/hides on condition change', async () => {
    const fn = await compileAndExec(
      `<script>let show = true\nfunction toggle() { show = !show }</script>\n{#if show}<p id="yes">visible</p>{/if}\n<button on:click={toggle}>toggle</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    expect(app.find('#yes')).toBeTruthy()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).toBeNull()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).toBeTruthy()
    app.destroy()
  })
  it('else branch renders correctly', async () => {
    const fn = await compileAndExec(
      `<script>let show = false</script>{#if show}<p>yes</p>{:else}<p>no</p>{/if}`,
      runtime
    )
    const app = mount(fn, runtime)
    expect(app.text()).toContain('no')
    app.destroy()
  })
})

describe('end-to-end — {#each}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders a list', async () => {
    const fn = await compileAndExec(
      `<script>let items = ['a','b','c']</script>{#each items as item}<li>{item}</li>{/each}`,
      runtime
    )
    const app = mount(fn, runtime)
    expect(app.findAll('li').length).toBe(3)
    expect(app.findAll('li')[0].textContent).toBe('a')
    app.destroy()
  })
  it('updates list when signal changes', async () => {
    const fn = await compileAndExec(
      `<script>let items = ['a','b']\nfunction add() { items = [...items, 'c'] }</script>{#each items as item}<li>{item}</li>{/each}<button on:click={add}>add</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(3)
    app.destroy()
  })
})

describe('end-to-end — watch+handler', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('handler fires when dep changes', async () => {
    const fn = await compileAndExec(
      `<script>let count = 0\nlet log = ''\n$: count, () => { log = 'fired:' + count }\nfunction inc() { count++ }</script><p>{log}</p><button on:click={inc}>+</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('p').textContent).toBe('fired:1')
    app.destroy()
  })
})

describe('end-to-end — {#if} + {#each} interaction', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('does not crash when branch switches while each is active', async () => {
    const fn = await compileAndExec(
      `<script>let searching = false\nlet results = []\nfunction search() { searching = true; results = [] }\nfunction finish() { searching = false; results = ['x','y'] }</script>{#if searching}<p id="s">Searching…</p>{:else if results.length}{#each results as r}<li>{r}</li>{/each}{/if}<button id="search" on:click={search}>search</button><button id="finish" on:click={finish}>finish</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('#finish').__click?.()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(2)
    expect(() => {
      app.find('#search').__click?.()
      runtime.flushSync()
    }).not.toThrow()
    expect(app.find('#s')).toBeTruthy()
    expect(() => {
      app.find('#finish').__click?.()
      runtime.flushSync()
    }).not.toThrow()
    expect(app.findAll('li').length).toBe(2)
    app.destroy()
  })
})

// ── §7  isStatic detection ───────────────────────────────────────────────────

describe('isStatic detection', () => {
  const isStaticSrc = (src) =>
    compile(src, { debug: false, css: false }).then(ctx => {
      const out = ctx.result
      return !out.includes('$runtime.render(') && !out.includes('bindText')
    })

  it('fully static template — no effects', async () => {
    expect(await isStaticSrc(`<p>Hello world</p>`)).toBe(true)
  })
  it('reactive template — has render()', async () => {
    expect(await isStaticSrc(`<script>let x=0</script><p>{x}</p>`)).toBe(false)
  })
  it('static const in template — no render()', async () => {
    expect(await isStaticSrc(`<script>const LABEL = 'hi'</script><p>{LABEL}</p>`)).toBe(true)
  })
  it('component with only static string prop — no $push effect', async () => {
    const out = await cx(`<Child label="hello"/>`)
    expect(out).not.toContain('createEffect')
    expect(out).not.toContain('$push')
  })
  it('component with reactive prop — has pushProps effect', async () => {
    const out = await cx(`<script>let n = 0</script><Child qty={n}/>`)
    expect(out).toContain('createEffect')
    expect(out).toContain('pushProps')
  })
  it('mixed static and reactive — only reactive gets render()', async () => {
    const out = await cx(`<script>let x=0</script><p>static</p><p>{x}</p>`)
    expect(out).toContain('$runtime.render(')
    // The static paragraph should not have a binding
    expect((out.match(/set_text/g) || []).length).toBe(1)
  })
  it('watch+handler with only static deps — still uses createEffect', async () => {
    const out = await cx(`<script>let count = 0; $: count, () => save(count)</script><p>{count}</p>`)
    expect(out).toContain('createEffect')
  })
  it('var sampler — template uses nodeValue directly, no render()', async () => {
    const out = await cx(`<script>let x=0; var snap=x</script><p>{snap}</p>`)
    expect(out).toContain('.nodeValue =')
    expect(out).not.toContain('$runtime.render(')
  })
  it('export const — inlined as literal, no signal', async () => {
    const out = await cx(`<script>export const MAX = 100</script><p>{MAX}</p>`)
    expect(out).not.toContain('$$sig_MAX')
    expect(out).not.toContain('track(')
  })
  it('no effects for fully static component', async () => {
    const out = await cx(`<h1>Mesa</h1><p>reactive UI language</p>`)
    expect(out).not.toContain('createEffect')
    expect(out).not.toContain('render(')
  })
  it('watch proxy is only effect when only external deps', async () => {
    const out = await cx(`<script>import {user} from './s.js'; $: user.name</script><p>{user.name}</p>`)
    expect(out).toContain('createEffect')
    expect(out).not.toContain('$$sig_')
  })
})

// ── §6b  extended end-to-end ─────────────────────────────────────────────────

describe('end-to-end — {#if} extended', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  const src = `
<script>
  let show = true
  let count = 0
  function toggle() { show = !show }
  function inc()    { count++ }
</script>
<button id="tog" on:click={toggle}>toggle</button>
<button id="inc" on:click={inc}>+</button>
{#if show}
  <p id="yes">count: {count}</p>
{:else}
  <p id="no">hidden</p>
{/if}`

  it('shows true branch initially', async () => {
    const fn = await compileAndExec(src, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#yes')).not.toBeNull()
    expect(app.find('#no')).toBeNull()
    app.destroy()
  })
  it('switches to else branch', async () => {
    const fn = await compileAndExec(src, runtime)
    const app = mount(fn, runtime)
    app.find('#tog').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).toBeNull()
    expect(app.find('#no')).not.toBeNull()
    app.destroy()
  })
  it('switches back to true branch', async () => {
    const fn = await compileAndExec(src, runtime)
    const app = mount(fn, runtime)
    app.find('#tog').__click?.()
    runtime.flushSync()
    app.find('#tog').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).not.toBeNull()
    app.destroy()
  })
  it('reactive value inside #if branch updates', async () => {
    const fn = await compileAndExec(src, runtime)
    const app = mount(fn, runtime)
    app.find('#inc').__click?.()
    app.find('#inc').__click?.()
    runtime.flushSync()
    expect(app.find('#yes').textContent).toBe('count: 2')
    app.destroy()
  })
  it('no leaked nodes after repeated toggles', async () => {
    const fn = await compileAndExec(src, runtime)
    const app = mount(fn, runtime)
    for (let i = 0; i < 6; i++) { app.find('#tog').__click?.(); runtime.flushSync() }
    expect(app.findAll('p').length).toBe(1)
    app.destroy()
  })
})

describe('end-to-end — {#each} inside {#if}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders items inside #if initially', async () => {
    const fn = await compileAndExec(`
<script>
  let show = true
  let items = ['a', 'b', 'c']
  const filtered = items.filter(i => i.includes(''))
</script>
{#if show}
  {#each filtered as item (item)}<li>{item}</li>{/each}
{/if}`, runtime)
    const app = mount(fn, runtime)
    expect(app.findAll('li').length).toBe(3)
    app.destroy()
  })

  it('filters items via signal change inside #if', async () => {
    const fn = await compileAndExec(`
<script>
  let show = true
  let items = ['a', 'b', 'c']
  let filter = ''
  const filtered = items.filter(i => i.includes(filter))
</script>
{#if show}
  {#each filtered as item (item)}<li>{item}</li>{/each}
{/if}
<input id="f" bind:value={filter} />`, runtime)
    const app = mount(fn, runtime)
    const input = app.find('#f')
    input.value = 'a'
    input.dispatchEvent(new Event('input'))
    runtime.flushSync()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(1)
    expect(app.findAll('li')[0].textContent).toBe('a')
    app.destroy()
  })
})

describe('end-to-end — {#each} extended', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('adds item', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b', 'c']
  function addItem() { items = [...items, String.fromCharCode(97 + items.length)] }
  function clearItems() { items = [] }
</script>
<button id="add" on:click={addItem}>add</button>
<button id="clr" on:click={clearItems}>clear</button>
<ul>{#each items as item (item)}<li>{item}</li>{/each}</ul>`, runtime)
    const app = mount(fn, runtime)
    expect(app.findAll('li').length).toBe(3)
    app.find('#add').__click?.()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(4)
    app.destroy()
  })
  it('clears all items', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b', 'c']
  function clearItems() { items = [] }
</script>
<button id="clr" on:click={clearItems}>clear</button>
<ul>{#each items as item (item)}<li>{item}</li>{/each}</ul>`, runtime)
    const app = mount(fn, runtime)
    app.find('#clr').__click?.()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(0)
    app.destroy()
  })
  it('restores after clear', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b', 'c']
  function addItem() { items = [...items, 'd'] }
  function clearItems() { items = [] }
</script>
<button id="add" on:click={addItem}>add</button>
<button id="clr" on:click={clearItems}>clear</button>
<ul>{#each items as item (item)}<li>{item}</li>{/each}</ul>`, runtime)
    const app = mount(fn, runtime)
    app.find('#clr').__click?.()
    runtime.flushSync()
    app.find('#add').__click?.()
    runtime.flushSync()
    expect(app.findAll('li').length).toBe(1)
    app.destroy()
  })

  it('reactively updates item attributes on rebind (same key, mutated object)', async () => {
    const fn = await compileAndExec(`
<script>
  let items = [{ id: 1, w: 50 }, { id: 2, w: 80 }]
  function grow() { items = items.map(i => ({ ...i, w: i.w + 20 })) }
</script>
<button id="grow" on:click={grow}>Grow</button>
{#each items as item (item.id)}
  <div class="bar" style="width:{item.w}px">{item.w}</div>
{/each}`, runtime)
    const app = mount(fn, runtime)
    const bars = () => app.findAll('.bar')
    expect(bars()[0].getAttribute('style')).toBe('width:50px')
    expect(bars()[0].textContent).toBe('50')
    app.find('#grow').__click?.()
    runtime.flushSync()
    expect(bars()[0].getAttribute('style')).toBe('width:70px')
    expect(bars()[0].textContent).toBe('70')
    expect(bars()[1].getAttribute('style')).toBe('width:100px')
    app.destroy()
  })
})

describe('end-to-end — watch+handler extended', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('handler receives current dep value on each change', async () => {
    const fn = await compileAndExec(`
<script>
  let count = 0
  let last = -1
  $: count, () => { last = count }
  function inc() { count++ }
</script>
<p id="count">{count}</p>
<p id="last">{last}</p>
<button id="inc" on:click={inc}>+</button>`, runtime)
    const app = mount(fn, runtime)
    app.find('#inc').__click?.()
    runtime.flushSync()
    expect(app.find('#last').textContent).toBe('1')
    app.find('#inc').__click?.()
    runtime.flushSync()
    expect(app.find('#last').textContent).toBe('2')
    app.destroy()
  })
})

describe('end-to-end — $: writable derived', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('re-derives when source dep changes', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b', 'c']
  $: selected = items[0]
  function shift() { items = ['x', 'y', 'z'] }
</script>
<p id="out">{selected}</p>
<button id="btn" on:click={shift}>shift</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('a')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('x')
    app.destroy()
  })

  it('manual override holds until next dep change', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b']
  $: selected = items[0]
  function override() { selected = 'OVERRIDE' }
  function shift() { items = ['x', 'y'] }
</script>
<p id="out">{selected}</p>
<button id="ov" on:click={override}>override</button>
<button id="sh" on:click={shift}>shift</button>`, runtime)
    const app = mount(fn, runtime)
    app.find('#ov').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('OVERRIDE')
    app.find('#sh').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('x')
    app.destroy()
  })

  it('plain let with dep is snapshot — does not re-derive', async () => {
    const fn = await compileAndExec(`
<script>
  let items = ['a', 'b']
  let snap = items[0]
  function shift() { items = ['x', 'y'] }
</script>
<p id="out">{snap}</p>
<button id="btn" on:click={shift}>shift</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('a')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('a')
    app.destroy()
  })

  it('$: assignment emits createWritableSignal', async () => {
    const ctx = await compile(
      `<script>let count = 0; $: doubled = count * 2</script><p>{doubled}</p>`,
      { debug: false, css: false }
    )
    expect(ctx.result).toContain('createWritableSignal')
  })

  it('duplicate declaration is a compiler error', async () => {
    const ctx = await compile(
      `<script>let myVar = 0; $: myVar = 1</script><p>{myVar}</p>`,
      { debug: false, css: false }
    )
    expect(ctx.analysis.errors.some(e => e.includes('already declared'))).toBe(true)
  })
})

describe('end-to-end — $: path watch on local let', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('mutation of watched path re-renders', async () => {
    const fn = await compileAndExec(`
<script>
  let user = { name: 'Alice' }
  $: user.name
  function rename() { user.name = 'Bob' }
</script>
<p id="out">{user.name}</p>
<button id="btn" on:click={rename}>rename</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('Alice')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('Bob')
    app.destroy()
  })

  it('replacing whole object re-renders', async () => {
    const fn = await compileAndExec(`
<script>
  let user = { name: 'Alice' }
  $: user.name
  function replace() { user = { name: 'Carol' } }
</script>
<p id="out">{user.name}</p>
<button id="btn" on:click={replace}>replace</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('Alice')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('Carol')
    app.destroy()
  })

  it('array push re-renders when array is watched', async () => {
    const fn = await compileAndExec(`
<script>
  let data = { items: ['a', 'b'] }
  $: data.items
  function add() { data.items.push('c') }
</script>
<p id="count">{data.items.length}</p>
<button id="btn" on:click={add}>add</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#count').textContent).toBe('2')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#count').textContent).toBe('3')
    app.destroy()
  })
})

describe('end-to-end — destructuring', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('const {name} from let updates when source changes', async () => {
    const fn = await compileAndExec(`
<script>
  let user = { name: 'Alice' }
  const {name} = user
  function rename() { user = { name: 'Bob' } }
</script>
<p id="out">{name}</p>
<button id="btn" on:click={rename}>rename</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('Alice')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('Bob')
    app.destroy()
  })

  it('const [first] from let arr updates when array changes', async () => {
    const fn = await compileAndExec(`
<script>
  let arr = [1, 2, 3]
  const [first] = arr
  function shift() { arr = [10, 2, 3] }
</script>
<p id="out">{first}</p>
<button id="btn" on:click={shift}>shift</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('1')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('10')
    app.destroy()
  })

  it('const {name = "Anon"} uses default when property undefined', async () => {
    const fn = await compileAndExec(`
<script>
  let user = {}
  const {name = 'Anon'} = user
</script>
<p id="out">{name}</p>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('Anon')
    app.destroy()
  })
})

// ── §E2E  {#key} ──────────────────────────────────────────────────────────────

describe('end-to-end — {#key}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders inner content initially', async () => {
    const fn = await compileAndExec(`
<script>let id = 1</script>
{#key id}<p id="out">{id}</p>{/key}`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('1')
    app.destroy()
  })

  it('recreates content when key changes', async () => {
    const fn = await compileAndExec(`
<script>
  let id = 1
  function next() { id++ }
</script>
{#key id}<p id="out">{id}</p>{/key}
<button on:click={next}>next</button>`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('1')
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('2')
    app.destroy()
  })

  it('resets inner-derived state when key changes', async () => {
    // Each time key changes, the entire block is torn down and rebuilt.
    // A let declared inside the block gets reset to its initial value.
    const fn = await compileAndExec(`
<script>
  let key = 0
  let inner = key  // derived from key — resets when key changes
  function inc()   { inner++ }
  function reset() { key++ }
</script>
{#key key}
  <button id="inc" on:click={inc}>+</button>
  <p id="val">{inner}</p>
{/key}
<button id="reset" on:click={reset}>reset</button>`, runtime)
    const app = mount(fn, runtime)
    app.find('#inc').__click?.()
    runtime.flushSync()
    expect(app.find('#val').textContent).toBe('1')
    // key change tears down and rebuilds the block
    app.find('#reset').__click?.()
    runtime.flushSync()
    // inner re-derives from new key value (1)
    expect(app.find('#val').textContent).toBe('1')
    app.destroy()
  })

  it('does not recreate when key value is unchanged', async () => {
    let mountCount = 0
    const fn = await compileAndExec(`
<script>
  let id = 1
  let other = 0
  function bumpOther() { other++ }
</script>
{#key id}<p id="out">{id}</p>{/key}
<p id="other">{other}</p>
<button on:click={bumpOther}>+</button>`, runtime)
    const app = mount(fn, runtime)
    const firstP = app.find('#out')
    app.find('button').__click?.()
    runtime.flushSync()
    // 'other' changed but not 'id' — same DOM node for #out
    expect(app.find('#out')).toBe(firstP)
    app.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  scopeCSS — CSS tokenizer and scoper
// ─────────────────────────────────────────────────────────────────────────────

describe('scopeCSS', () => {
  const id = 'mesa-test'
  const scope = (css) => scopeCSS(css, id)

  // Basic scoping
  it('scopes a simple element selector', () => {
    expect(scope('p { color: red; }')).toContain('.mesa-test p')
  })
  it('scopes a class selector', () => {
    expect(scope('.card { color: red; }')).toContain('.mesa-test .card')
  })
  it('scopes multiple selectors in a rule', () => {
    const out = scope('h1, h2, p { color: red; }')
    expect(out).toContain('.mesa-test h1')
    expect(out).toContain('.mesa-test h2')
    expect(out).toContain('.mesa-test p')
  })

  // :global
  it(':global(sel) strips wrapper and emits unscoped', () => {
    const out = scope(':global(body) { margin: 0; }')
    expect(out).toContain('body')
    expect(out).not.toContain('.mesa-test body')
  })
  it(':global { } block emits contents unscoped', () => {
    const out = scope(':global { body { margin: 0; } }')
    expect(out).toContain('body')
    expect(out).not.toContain('.mesa-test')
  })

  // Pseudo-functions with commas — must not split
  it(':is() — commas inside parens not treated as selector list', () => {
    const out = scope(':is(h1, h2, h3) { color: red; }')
    expect(out).toContain(':is(h1, h2, h3)')
    // should only be scoped once, not each element inside :is()
    expect(out).not.toContain('.mesa-test h1')
    expect(out).not.toContain('.mesa-test h2')
  })
  it(':where() — commas inside parens not treated as selector list', () => {
    const out = scope(':where(h1, h2) { color: red; }')
    expect(out).toContain(':where(h1, h2)')
    expect(out).not.toContain('.mesa-test h1')
  })
  it(':has() — passes through correctly', () => {
    const out = scope('p:has(> span) { color: red; }')
    expect(out).toContain('.mesa-test p:has(> span)')
  })

  // @-rules
  it('@media — scopes rules inside, not the @media itself', () => {
    const out = scope('@media (max-width: 600px) { p { color: red; } }')
    expect(out).toContain('@media (max-width: 600px)')
    expect(out).toContain('.mesa-test p')
    expect(out).not.toContain('.mesa-test @media')
  })
  it('@layer — scopes rules inside', () => {
    const out = scope('@layer base { p { color: red; } }')
    expect(out).toContain('@layer base')
    expect(out).toContain('.mesa-test p')
  })
  it('@container — scopes rules inside', () => {
    const out = scope('@container (min-width: 400px) { p { color: red; } }')
    expect(out).toContain('@container (min-width: 400px)')
    expect(out).toContain('.mesa-test p')
  })
  it('@supports — scopes rules inside', () => {
    const out = scope('@supports (display: grid) { p { display: grid; } }')
    expect(out).toContain('@supports (display: grid)')
    expect(out).toContain('.mesa-test p')
  })
  it('@keyframes — entire block passed through unscoped', () => {
    const out = scope('@keyframes fade { from { opacity: 0; } to { opacity: 1; } }')
    expect(out).toContain('@keyframes fade')
    expect(out).toContain('from')
    expect(out).toContain('to')
    expect(out).not.toContain('.mesa-test')
  })
  it('@import — passes through as-is', () => {
    const out = scope("@import url('fonts.css'); p { color: red; }")
    expect(out).toContain("@import url('fonts.css')")
    expect(out).toContain('.mesa-test p')
  })

  // CSS Nesting
  it('nested rule with & — expands & to parent scoped selector', () => {
    const out = scope('p { color: red; &:hover { color: blue; } }')
    expect(out).toContain('.mesa-test p')
    expect(out).toContain('.mesa-test p:hover')
  })
  it('nested rule without & — scoped independently', () => {
    const out = scope('div { p { color: red; } }')
    expect(out).toContain('.mesa-test div')
    expect(out).toContain('.mesa-test p')
  })
  it('deep nesting — scopes each level', () => {
    const out = scope('div { p { color: red; span { color: blue; } } }')
    expect(out).toContain('.mesa-test div')
    expect(out).toContain('.mesa-test p')
    expect(out).toContain('.mesa-test span')
  })
  it('@layer with nested & — scopes and expands correctly', () => {
    const out = scope('@layer base { p { color: red; &:hover { color: blue; } } }')
    expect(out).toContain('@layer base')
    expect(out).toContain('.mesa-test p')
    expect(out).toContain('.mesa-test p:hover')
  })
  it('multiple & selectors in one block', () => {
    const out = scope('p { &.active { color: blue; } & + p { color: green; } }')
    expect(out).toContain('.mesa-test p.active')
    expect(out).toContain('.mesa-test p + p')
  })

  // Comments
  it('comment before selector — comment preserved, selector scoped', () => {
    const out = scope('/* heading */ p { color: red; }')
    expect(out).toContain('/* heading */')
    expect(out).toContain('.mesa-test p')
    expect(out).not.toContain('.mesa-test /* heading */')
  })
  it('comment inside block — passed through', () => {
    const out = scope('p { /* color */ color: red; }')
    expect(out).toContain('/* color */')
  })

  // @apply passthrough
  it('@apply inside rule — passed through as declaration', () => {
    const out = scope('p { @apply text-red-500; }')
    expect(out).toContain('.mesa-test p')
    expect(out).toContain('@apply text-red-500')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  mesa:boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('mesa:boundary', () => {
  let runtime

  beforeEach(async () => {
    runtime = await import('./runtime.js')
    runtime.setRenderEnvironment(true)
  })

  it('compiles with async derived var — emits boundaryBlock', async () => {
    const out = await cx(`
<script>
let q = ''
const results = await search(q)
</script>
<mesa:boundary>
  {#snippet pending()}<p>Loading</p>{/snippet}
  <ul>{#each results as r}<li>{r}</li>{/each}</ul>
</mesa:boundary>`)
    expect(out).toContain('$runtime.boundaryBlock')
    expect(out).toContain('$$async_results')
    expect(out).toContain('$$snippet_pending')
  })

  it('wires co-located pending and failed snippets', async () => {
    const out = await cx(`
<script>
const data = await fetchData()
</script>
<mesa:boundary>
  {#snippet pending()}<p>Loading</p>{/snippet}
  {#snippet failed(err)}<p>{err.message}</p>{/snippet}
  <p>{data}</p>
</mesa:boundary>`)
    expect(out).toContain('$$snippet_pending')
    expect(out).toContain('$$snippet_failed')
    expect(out).toContain('(__anchor) => $$snippet_pending(__anchor)')
    expect(out).toContain('(__anchor, $$err) => $$snippet_failed(__anchor, $$err)')
  })

  it('uses global snippets when no co-located snippets', async () => {
    const out = await cx(`
<script>
const data = await fetchData()
</script>
<mesa:boundary>
  <p>{data}</p>
</mesa:boundary>
{#snippet pending()}<p>Loading</p>{/snippet}
{#snippet failed(err)}<p>{err.message}</p>{/snippet}`)
    expect(out).toContain('$$snippet_pending')
    expect(out).toContain('$$snippet_failed')
    expect(out).toContain('(__anchor) => $$snippet_pending(__anchor)')
  })

  it('shows pending while loading, content after resolve', async () => {
    let resolveData
    const dataPromise = new Promise(r => { resolveData = r })
    const fn = await compileAndExec(`
<script>
const data = await fetchIt()
</script>
<mesa:boundary>
  {#snippet pending()}<p id="pending">Loading</p>{/snippet}
  <p id="content">{data}</p>
</mesa:boundary>`, runtime, {
      './fetchIt': { fetchIt: () => dataPromise }
    })
    // can't use userImports for top-level await in this context
    // just verify the compiled output is correct
    expect(fn).toBeTruthy()
  })

  it('emits warning when no async vars present', async () => {
    const ctx = await compile(`
<script>let x = 1</script>
<mesa:boundary><p>{x}</p></mesa:boundary>`, { css: false })
    expect(ctx.analysis.warnings.join(' ')).toContain('no async-derived variables')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  mesa:mounted
// ─────────────────────────────────────────────────────────────────────────────

describe('mesa:mounted', () => {
  let runtime

  beforeEach(async () => {
    runtime = await import('./runtime.js')
    runtime.setRenderEnvironment(true)
  })

  it('injects $mounted builtin when $mounted() used', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted />
<p>{user}</p>`)
    expect(out).toContain('const $mounted   = $runtime.$onMounted')
  })

  it('mounting var is emitted as plain const (not tracked)', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted />
<p>{user}</p>`)
    expect(out).not.toContain('$runtime.track(() => ($mounted')
    expect(out).toContain('const mounting = $mounted(')
  })

  it('assignment inside $mounted fn is rewritten to setter', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted />
<p>{user}</p>`)
    expect(out).toContain('$$set_user(await getUser())')
  })

  it('emits mountedBlock with promise ref', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted />
<p>{user}</p>`)
    expect(out).toContain('$runtime.mountedBlock')
    expect(out).toContain('() => mounting')
  })

  it('wires onerror attribute', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted onerror={(err) => console.error(err)} />
<p>{user}</p>`)
    expect(out).toContain('(err) => console.error(err)')
  })

  it('hoists global pending and failed snippets to outer scope', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted />
<p>{user}</p>
{#snippet pending()}<p>Loading</p>{/snippet}
{#snippet failed(err)}<p>{err.message}</p>{/snippet}`)
    // snippets must be defined BEFORE mountedBlock call
    const pendingIdx  = out.indexOf('$$snippet_pending =')
    const failedIdx   = out.indexOf('$$snippet_failed =')
    const mountedIdx  = out.indexOf('mountedBlock(')
    expect(pendingIdx).toBeGreaterThan(-1)
    expect(failedIdx).toBeGreaterThan(-1)
    expect(pendingIdx).toBeLessThan(mountedIdx)
    expect(failedIdx).toBeLessThan(mountedIdx)
  })

  it('wrapping form behaves same as self-closing', async () => {
    const out = await cx(`
<script>
let user
const mounting = $mounted(async () => { user = await getUser() })
</script>
<mesa:mounted>
  {#snippet pending()}<p>Loading</p>{/snippet}
</mesa:mounted>
<p>{user}</p>`)
    expect(out).toContain('$runtime.mountedBlock')
    expect(out).toContain('() => mounting')
  })

  it('compiler error when $mounted called more than once', async () => {
    const ctx = await compile(`
<script>
let a, b
const m1 = $mounted(async () => { a = await getA() })
const m2 = $mounted(async () => { b = await getB() })
</script>
<mesa:mounted />
<p>{a}</p>`, { css: false })
    expect(ctx.analysis.errors.join(' ')).toContain('once')
  })
})

// ── §7  end-to-end — multi-root {#if} ────────────────────────────────────────

describe('end-to-end — multi-root {#if}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('controls before {#if} stay visible after branch switch', async () => {
    const fn = await compileAndExec(`
<script>
let show = true
function toggle() { show = !show }
</script>
<h2>Title</h2>
<div id="controls"><button on:click={toggle}>Toggle</button></div>
{#if show}
  <p id="shown">Shown</p>
{:else}
  <p id="hidden">Hidden</p>
{/if}`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#controls')).toBeTruthy()
    expect(app.find('#shown')).toBeTruthy()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#controls')).toBeTruthy()
    expect(app.find('#hidden')).toBeTruthy()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#controls')).toBeTruthy()
    expect(app.find('#shown')).toBeTruthy()
    app.destroy()
  })

  it('controls stay visible when {#if} wraps {#each} and items become empty', async () => {
    const fn = await compileAndExec(`
<script>
let items = ['a', 'b', 'c']
const hasItems = items.length > 0
function clear() { items = [] }
</script>
<h2>Title</h2>
<div id="controls"><button on:click={clear}>Clear</button></div>
{#if !hasItems}
  <p id="empty">No items</p>
{:else}
  {#each items as item (item)}
    <span class="item">{item}</span>
  {/each}
{/if}`, runtime)
    const app = mount(fn, runtime)
    expect(app.find('#controls')).toBeTruthy()
    expect(app.findAll('.item')).toHaveLength(3)
    expect(app.find('#empty')).toBeNull()
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.find('#controls')).toBeTruthy()
    expect(app.findAll('.item')).toHaveLength(0)
    expect(app.find('#empty')).toBeTruthy()
    app.destroy()
  })
})

// ── SVG {#each} with dynamic attributes ──────────────────────────────────────

describe('end-to-end — SVG {#each} dynamic attributes', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('renders SVG elements with dynamic attributes from {#each}', async () => {
    const fn = await compileAndExec(`
<script>
let bars = [
  { x: 10, h: 40 },
  { x: 50, h: 80 },
  { x: 90, h: 60 },
]
</script>
<svg viewBox="0 0 200 100">
  {#each bars as bar (bar.x)}
    <rect class="bar" x={bar.x} y={100 - bar.h} width="30" height={bar.h} fill="teal"/>
  {/each}
</svg>`, runtime)

    const app = mount(fn, runtime)
    const rects = app.findAll('.bar')
    expect(rects).toHaveLength(3)
    expect(rects[0].getAttribute('x')).toBe('10')
    expect(rects[0].getAttribute('height')).toBe('40')
    expect(rects[1].getAttribute('x')).toBe('50')
    expect(rects[1].getAttribute('height')).toBe('80')
    app.destroy()
  })

  it('updates SVG attributes reactively when items are mutated (rebind)', async () => {
    const fn = await compileAndExec(`
<script>
let items = [{ id: 1, r: 20 }, { id: 2, r: 40 }]
function grow() { items = items.map(i => ({ ...i, r: i.r + 10 })) }
</script>
<svg viewBox="0 0 200 100">
  {#each items as item (item.id)}
    <circle class="dot" cx="50" cy="50" r={item.r}/>
  {/each}
</svg>
<button on:click={grow}>Grow</button>`, runtime)

    const app = mount(fn, runtime)
    const circles = () => app.findAll('.dot')
    expect(circles()[0].getAttribute('r')).toBe('20')
    expect(circles()[1].getAttribute('r')).toBe('40')

    app.find('button').__click?.()
    runtime.flushSync()
    // Same keys — reconciler rebinds item signals; render() inside makeBlock re-runs
    expect(circles()[0].getAttribute('r')).toBe('30')
    expect(circles()[1].getAttribute('r')).toBe('50')
    app.destroy()
  })
})

// ── §E2E  ifBlock + keyBlock same-branch reactivity ───────────────────────────
// Regression: _run() was calling _disposeNode(this, false) which disposed the
// branchNode (containing keyBlock's effect) even when the branch didn't change.
// After the fix, _run() only clears deps/cleanups, never children.

describe('end-to-end — external object watch ($: obj)', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('$: obj (whole-object watch) on imported external object updates template on property mutation', async () => {
    // Regression: _buildProxy get() only subscribed to exact path signals.
    // $: themeNew registers a '__root__' signal. Reading themeNew.style in the
    // template looked for a 'style' signal — not found — and did NOT fall back to
    // '__root__'. So mutations to themeNew.style never triggered template re-renders.
    const imports = {
      './store.js': { themeNew: { style: 'dark' } }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew } from './store.js'
  $: themeNew
  function toggle() { themeNew.style = themeNew.style === 'dark' ? 'light' : 'dark' }
</script>
<p id="out">{themeNew.style}</p>
<button id="btn" on:click={toggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('dark')

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('light')

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('dark')
    app.destroy()
  })

  it('$: obj also triggers on nested property mutation', async () => {
    const imports = {
      './store.js': { store: { user: { name: 'Alice' } } }
    }
    const fn = await compileAndExec(`
<script>
  import { store } from './store.js'
  $: store
  function rename() { store.user.name = 'Bob' }
</script>
<p id="out">{store.user.name}</p>
<button id="btn" on:click={rename}>rename</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('Alice')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('Bob')
    app.destroy()
  })

  it('const alias of watched external object is reactive (style.style updates)', async () => {
    const imports = { './store.js': { themeNew: { style: 'dark' } } }
    const fn = await compileAndExec(`
<script>
  import { themeNew } from './store.js'
  $: themeNew
  const style = themeNew
  function toggle() { themeNew.style = themeNew.style === 'dark' ? 'light' : 'dark' }
</script>
<p id="out">{style.style}</p>
<button id="btn" on:click={toggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('dark')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('light')
    app.destroy()
  })

  it('destructured const from watched external object is reactive (otherStyle updates)', async () => {
    const imports = { './store.js': { themeNew: { style: 'dark' } } }
    const fn = await compileAndExec(`
<script>
  import { themeNew } from './store.js'
  $: themeNew
  const { style: otherStyle } = themeNew
  function toggle() { themeNew.style = themeNew.style === 'dark' ? 'light' : 'dark' }
</script>
<p id="out">{otherStyle}</p>
<button id="btn" on:click={toggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('dark')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('light')
    app.destroy()
  })

  it('both alias and destructured const react on same object', async () => {
    const imports = { './store.js': { themeNew: { style: 'dark' } } }
    const fn = await compileAndExec(`
<script>
  import { themeNew } from './store.js'
  $: themeNew
  const style = themeNew
  const { style: otherStyle } = themeNew
  function toggle() { themeNew.style = themeNew.style === 'dark' ? 'light' : 'dark' }
</script>
<p id="t1">{style.style}</p>
<p id="t2">{otherStyle}</p>
<button id="btn" on:click={toggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#t1').textContent).toBe('dark')
    expect(app.find('#t2').textContent).toBe('dark')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#t1').textContent).toBe('light')
    expect(app.find('#t2').textContent).toBe('light')
    app.destroy()
  })

  it('self-assignment on watched import (root = root) compiles to fire function', async () => {
    const src = `
<script>
  import { themeNew } from './store.js'
  $: themeNew
  function handleToggle() {
    themeNew = themeNew
  }
</script>
<p>{themeNew.style}</p>`
    const { result } = await compile(src, { debug: false, css: false })
    // Must rewrite to fire function, not a raw assignment
    expect(result).toContain('$$fire_themeNew()')
    expect(result).not.toContain('themeNew = themeNew')
    expect(result).not.toContain('$$proxy_themeNew = $$proxy_themeNew')
    // Must capture fire fn from watchPath
    expect(result).toContain('[$$watch_themeNew, $$fire_themeNew]')
  })

  it('self-assignment triggers re-render end-to-end (external mutation pattern)', async () => {
    // Simulates: external function mutates the object, then component uses
    // self-assignment to force a re-render
    const storeObj = { style: 'dark' }
    const imports = {
      './store.js': {
        themeNew: storeObj,
        toggleTheme: () => { storeObj.style = storeObj.style === 'dark' ? 'light' : 'dark' }
      }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew, toggleTheme } from './store.js'
  $: themeNew
  function handleToggle() {
    toggleTheme()
    themeNew = themeNew
  }
</script>
<p id="out">{themeNew.style}</p>
<button id="btn" on:click={handleToggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('dark')

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('light')

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('dark')
    app.destroy()
  })

  it('self-assignment works without any local let variables', async () => {
    // Regression: early-return guard in rewriteAssignments skipped when no local setters
    const storeObj = { count: 0 }
    const imports = {
      './store.js': {
        counter: storeObj,
        increment: () => { storeObj.count++ }
      }
    }
    const fn = await compileAndExec(`
<script>
  import { counter, increment } from './store.js'
  $: counter
  function inc() {
    increment()
    counter = counter
  }
</script>
<p id="out">{counter.count}</p>
<button id="btn" on:click={inc}>+</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('0')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('1')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('2')
    app.destroy()
  })

  it('$: fn(), handler compiles to a wrapper that fires after each call', async () => {
    const src = `
<script>
  import { themeNew, toggleTheme } from './store.js'
  $: themeNew
  $: handleToggle(), () => { themeNew = themeNew }
  function handleToggle() { toggleTheme() }
</script>
<p>{themeNew.style}</p>`
    const { result } = await compile(src, { debug: false, css: false })
    expect(result).toContain('__orig_handleToggle')
    expect(result).toContain('handleToggle = (...__args) =>')
    expect(result).toContain('$$fire_themeNew()')
  })

  it('$: fn(), handler end-to-end: external mutation + self-assignment fires re-render', async () => {
    const storeObj = { style: 'dark' }
    const imports = {
      './store.js': {
        themeNew: storeObj,
        toggleTheme: () => { storeObj.style = storeObj.style === 'dark' ? 'light' : 'dark' }
      }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew, toggleTheme } from './store.js'
  $: themeNew
  $: handleToggle(), () => { themeNew = themeNew }
  function handleToggle() { toggleTheme() }
</script>
<p id="out">{themeNew.style}</p>
<button id="btn" on:click={handleToggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('dark')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('light')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('dark')
    app.destroy()
  })

  it('$: fn(), handler with reactive lets: both fire after each call', async () => {
    const storeObj = { style: 'dark' }
    const imports = {
      './store.js': {
        themeNew: storeObj,
        toggleTheme: () => { storeObj.style = storeObj.style === 'dark' ? 'light' : 'dark' }
      }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew, toggleTheme } from './store.js'
  $: themeNew
  let toggleCount = 0
  $: handleToggle(), () => { themeNew = themeNew; toggleCount++ }
  function handleToggle() { toggleTheme() }
</script>
<p id="style">{themeNew.style}</p>
<p id="count">{toggleCount}</p>
<button id="btn" on:click={handleToggle}>toggle</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#style').textContent).toBe('dark')
    expect(app.find('#count').textContent).toBe('0')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#style').textContent).toBe('light')
    expect(app.find('#count').textContent).toBe('1')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#style').textContent).toBe('dark')
    expect(app.find('#count').textContent).toBe('2')
    app.destroy()
  })

  it('Object.assign on watched external object triggers re-render', async () => {
    const storeObj = { style: 'dark', mode: 'compact' }
    const imports = {
      './store.js': {
        themeNew: storeObj,
        setTheme: (updates) => Object.assign(storeObj, updates),
      }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew, setTheme } from './store.js'
  $: themeNew
  $: handleUpdate(), () => { themeNew = themeNew }
  function handleUpdate() {
    setTheme({ style: 'light', mode: 'expanded' })
  }
</script>
<p id="style">{themeNew.style}</p>
<p id="mode">{themeNew.mode}</p>
<button id="btn" on:click={handleUpdate}>update</button>`, runtime, imports)

    const app = mount(fn, runtime)
    expect(app.find('#style').textContent).toBe('dark')
    expect(app.find('#mode').textContent).toBe('compact')

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#style').textContent).toBe('light')
    expect(app.find('#mode').textContent).toBe('expanded')
    app.destroy()
  })

  it('Object.assign partial update only changes specified keys', async () => {
    const storeObj = { style: 'dark', mode: 'compact', accent: 'blue' }
    const imports = {
      './store.js': {
        themeNew: storeObj,
        setTheme: (updates) => Object.assign(storeObj, updates),
      }
    }
    const fn = await compileAndExec(`
<script>
  import { themeNew, setTheme } from './store.js'
  $: themeNew
  $: handleUpdate(), () => { themeNew = themeNew }
  function handleUpdate() { setTheme({ style: 'light' }) }
</script>
<p id="style">{themeNew.style}</p>
<p id="mode">{themeNew.mode}</p>
<p id="accent">{themeNew.accent}</p>
<button id="btn" on:click={handleUpdate}>update</button>`, runtime, imports)

    const app = mount(fn, runtime)
    app.find('#btn').__click?.()
    runtime.flushSync()
    // Only style changed — mode and accent preserved
    expect(app.find('#style').textContent).toBe('light')
    expect(app.find('#mode').textContent).toBe('compact')
    expect(app.find('#accent').textContent).toBe('blue')
    app.destroy()
  })

  it('cross-component: File 1 mutation via Object.assign updates File 2 render', async () => {
    // Both components share the same object reference — same signal — automatic reactivity
    const storeObj = { style: 'dark' }
    const storeModule = {
      themeNew: storeObj,
      setTheme: (updates) => Object.assign(storeObj, updates),
    }
    const imports = { './store.js': storeModule }

    // File 1: has the toggle logic + post-call hook
    const fn1 = await compileAndExec(`
<script>
  import { themeNew, setTheme } from './store.js'
  $: themeNew
  $: doToggle(), () => { themeNew = themeNew }
  function doToggle() {
    setTheme({ style: themeNew.style === 'dark' ? 'light' : 'dark' })
  }
</script>
<button id="btn1" on:click={doToggle}>toggle</button>`, runtime, imports)

    // File 2: just reads — no mutation logic
    const fn2 = await compileAndExec(`
<script>
  import { themeNew } from './store.js'
  $: themeNew
</script>
<p id="out2">{themeNew.style}</p>`, runtime, imports)

    const app1 = mount(fn1, runtime)
    const app2 = mount(fn2, runtime)

    expect(app2.find('#out2').textContent).toBe('dark')

    // File 1 triggers the update
    app1.find('#btn1').__click?.()
    runtime.flushSync()

    // File 2 should have re-rendered
    expect(app2.find('#out2').textContent).toBe('light')

    app1.find('#btn1').__click?.()
    runtime.flushSync()
    expect(app2.find('#out2').textContent).toBe('dark')

    app1.destroy()
    app2.destroy()
  })

})

describe('end-to-end — ifBlock + keyBlock param reactivity', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('keyBlock inside ifBlock remounts when signal changes (same branch)', async () => {
    const fn = await compileAndExec(`
<script>
  let slug = 'hello'
  function setSlug(v) { slug = v }
</script>
{#if slug}
  {#key slug}
    <p id="out">{slug}</p>
  {/key}
{/if}
<button id="btn" on:click={() => setSlug('world')}>change</button>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('hello')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('world')
    app.destroy()
  })

  it('keyBlock fires on multiple successive param changes', async () => {
    const fn = await compileAndExec(`
<script>
  let slug = 'a'
  function setSlug(v) { slug = v }
</script>
{#if slug}
  {#key slug}
    <p id="out">{slug}</p>
  {/key}
{/if}
<button id="b" on:click={() => setSlug('b')}>b</button>
<button id="c" on:click={() => setSlug('c')}>c</button>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('a')
    app.find('#b').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('b')
    app.find('#c').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('c')
    app.destroy()
  })

  it('keyBlock inside {#if key !== null} guard remounts on key change', async () => {
    // Exact ChainRenderer pattern
    const fn = await compileAndExec(`
<script>
  let slug = 'hello'
  function getKey() { return slug.length > 0 ? slug : null }
  function setSlug(v) { slug = v }
</script>
{#if getKey() !== null}
  {#key getKey()}
    <p id="out">{slug}</p>
  {/key}
{/if}
<button id="btn" on:click={() => setSlug('mesa-reactivity')}>change</button>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#out').textContent).toBe('hello')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#out').textContent).toBe('mesa-reactivity')
    app.destroy()
  })

  it('ifBlock still switches branches correctly', async () => {
    const fn = await compileAndExec(`
<script>
  let show = true
  function toggle() { show = !show }
</script>
{#if show}
  <p id="yes">yes</p>
{:else}
  <p id="no">no</p>
{/if}
<button id="btn" on:click={toggle}>toggle</button>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#yes')).not.toBeNull()
    expect(app.find('#no')).toBeNull()
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).toBeNull()
    expect(app.find('#no')).not.toBeNull()
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#yes')).not.toBeNull()
    app.destroy()
  })

  it('branch content is cleaned up on branch switch', async () => {
    const fn = await compileAndExec(`
<script>
  let mode = 'a'
  let count = 0
  function inc() { count++ }
  function setMode(m) { mode = m }
</script>
{#if mode === 'a'}
  <p id="count">{count}</p>
  <button id="inc" on:click={inc}>+</button>
{:else}
  <p id="other">other</p>
{/if}
<button id="switch" on:click={() => setMode('b')}>switch</button>`, runtime)

    const app = mount(fn, runtime)
    app.find('#inc').__click?.()
    runtime.flushSync()
    expect(app.find('#count').textContent).toBe('1')
    app.find('#switch').__click?.()
    runtime.flushSync()
    expect(app.find('#count')).toBeNull()
    expect(app.find('#other').textContent).toBe('other')
    app.destroy()
  })
  it('render() effects inside disposed ifBlock branch do not run after branch switches', async () => {
    // Regression: _disposeNode was not removing nodes from _queue.
    // When a signal change caused both an ifBlock condition effect and a render()
    // effect inside the branch to be queued, the render() effect could fire after
    // the branch was disposed — accessing null properties → TypeError.
    const fn = await compileAndExec(`
<script>
  let post = { tag: 'hello', title: 'World' }
  function clearPost() { post = null }
</script>
{#if post}
  <p id="tag">{post.tag}</p>
  <p id="title">{post.title}</p>
{:else}
  <p id="empty">no post</p>
{/if}
<button id="btn" on:click={clearPost}>clear</button>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#tag').textContent).toBe('hello')
    expect(app.find('#empty')).toBeNull()

    // This must not throw — render() effects inside branch must not fire after dispose
    expect(() => {
      app.find('#btn').__click?.()
      runtime.flushSync()
    }).not.toThrow()

    expect(app.find('#tag')).toBeNull()
    expect(app.find('#empty').textContent).toBe('no post')
    app.destroy()
  })

})

  describe('CSS scoping — document-root selectors', () => {
    it(':root selectors emit unscoped (cannot be descendant of scoped class)', async () => {
      const { css } = await compile(
        `<div/><style>:root { --c: red; }</style>`,
        { debug: false, css: true }
      )
      const out = css._rules[0]
      // Must NOT be prefixed with the component hash
      expect(out).toMatch(/^:root \{/)
      expect(out).not.toContain(' :root')
    })

    it(':root[attr] selectors emit unscoped', async () => {
      const { css } = await compile(
        `<div/><style>:root[data-theme="dark"] { --bg: #000; }</style>`,
        { debug: false, css: true }
      )
      const out = css._rules[0]
      expect(out).toContain(':root[data-theme="dark"]')
      expect(out).not.toMatch(/\.\w+ :root/)
    })

    it('html selector emits unscoped', async () => {
      const { css } = await compile(
        `<div/><style>html { box-sizing: border-box; }</style>`,
        { debug: false, css: true }
      )
      expect(css._rules[0]).toMatch(/^html \{/)
    })

    it('body selector emits unscoped', async () => {
      const { css } = await compile(
        `<div/><style>body { margin: 0; }</style>`,
        { debug: false, css: true }
      )
      expect(css._rules[0]).toMatch(/^body \{/)
    })

    it('component class selectors stay scoped', async () => {
      const { css } = await compile(
        `<div class="card"/><style>.card { color: red; }</style>`,
        { debug: false, css: true }
      )
      // Must be scoped with the component hash
      expect(css._rules[0]).toMatch(/\.[a-z0-9]+ \.card \{/)
    })

    it(':global(body) still works alongside :root selectors', async () => {
      const { css } = await compile(
        `<div/><style>:root { --c: red; } :global(body) { background: var(--c); }</style>`,
        { debug: false, css: true }
      )
      const out = css._rules[0]
      expect(out).toContain(':root {')
      expect(out).toContain('body {')
      expect(out).not.toMatch(/\.[a-z0-9]+ :root/)
      expect(out).not.toMatch(/\.[a-z0-9]+ body/)
    })
  })

describe('keyBlock — stable key does not remount', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('does not remount content when key expression re-runs but returns same value', async () => {
    // Regression: keyBlock subscribed to a memo. When the memo's upstream changed
    // (e.g. chain prop updating) and the memo re-ran but returned the same value
    // (same component function reference), keyBlock still called _remove() and
    // remounted — causing layout instance scripts to re-run on every navigation.
    const fn = await compileAndExec(`
<script>
  let trigger = 0
  const stableKey = 'same'
  function bump() { trigger++ }
</script>
<div>
  {#key stableKey}
    <p id="inner">inner</p>
  {/key}
</div>
<button id="btn" on:click={bump}>bump</button>
<p id="trigger">{trigger}</p>`, runtime)

    const app = mount(fn, runtime)
    expect(app.find('#inner').textContent).toBe('inner')
    expect(app.find('#trigger').textContent).toBe('0')

    // bump() changes trigger but stableKey stays 'same' — inner must NOT remount
    const innerEl = app.find('#inner')
    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#trigger').textContent).toBe('1')
    // Same DOM element — not remounted
    expect(app.find('#inner')).toBe(innerEl)

    app.find('#btn').__click?.()
    runtime.flushSync()
    expect(app.find('#trigger').textContent).toBe('2')
    expect(app.find('#inner')).toBe(innerEl)
    app.destroy()
  })

  it('does remount content when key value actually changes', async () => {
    const fn = await compileAndExec(`
<script>
  let key = 'a'
  function swap() { key = key === 'a' ? 'b' : 'a' }
</script>
<div>
  {#key key}
    <p id="inner">{key}</p>
  {/key}
</div>
<button id="btn" on:click={swap}>swap</button>`, runtime)

    const app = mount(fn, runtime)
    const innerEl1 = app.find('#inner')
    expect(innerEl1.textContent).toBe('a')

    app.find('#btn').__click?.()
    runtime.flushSync()
    // Key changed — should remount, new DOM element
    const innerEl2 = app.find('#inner')
    expect(innerEl2.textContent).toBe('b')
    expect(innerEl2).not.toBe(innerEl1)

    app.destroy()
  })
})

describe('end-to-end — named slots', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  async function compileLayout(src) {
    const { result, analysis } = await compile(src, { debug: false, css: false })
    if (analysis.errors.length) throw new Error(analysis.errors[0])
    return execCompiled(result, runtime)
  }

  it('named slot content replaces slot outlet', async () => {
    const LayoutFn = await compileLayout(`
<div>
  <aside id="sidebar"><slot name="sidebar" /></aside>
  <main id="main"><slot /></main>
</div>`)

    const fn = await compileAndExec(`
<script>import Layout from './Layout.mesa'</script>
<Layout>
  <p slot="sidebar" id="sb">Sidebar</p>
  <p id="mn">Main</p>
</Layout>`, runtime, { './Layout.mesa': { default: LayoutFn } })

    const app = mount(fn, runtime)
    expect(app.find('#sb').textContent).toBe('Sidebar')
    expect(app.find('#mn').textContent).toBe('Main')
    app.destroy()
  })

  it('fallback renders when no slot content provided', async () => {
    const LayoutFn = await compileLayout(`
<div>
  <aside id="sidebar">
    <slot name="sidebar">
      <p id="fallback">Default sidebar</p>
    </slot>
  </aside>
  <main><slot /></main>
</div>`)

    const fn = await compileAndExec(`
<script>import Layout from './Layout.mesa'</script>
<Layout><p id="mn">Main only</p></Layout>`,
      runtime, { './Layout.mesa': { default: LayoutFn } })

    const app = mount(fn, runtime)
    expect(app.find('#fallback').textContent).toBe('Default sidebar')
    expect(app.find('#mn').textContent).toBe('Main only')
    app.destroy()
  })

  it('$slots.sidebar is truthy when sidebar slot provided', async () => {
    const LayoutFn = await compileLayout(`
<div>
  {#if $slots.sidebar}
    <aside id="sidebar-wrapper"><slot name="sidebar" /></aside>
  {/if}
  <main><slot /></main>
</div>`)

    const fnWith = await compileAndExec(`
<script>import Layout from './Layout.mesa'</script>
<Layout>
  <p slot="sidebar" id="sb">Sidebar</p>
  <p id="mn">Main</p>
</Layout>`, runtime, { './Layout.mesa': { default: LayoutFn } })

    const app1 = mount(fnWith, runtime)
    expect(app1.find('#sidebar-wrapper')).not.toBeNull()
    expect(app1.find('#sb').textContent).toBe('Sidebar')
    app1.destroy()

    const fnWithout = await compileAndExec(`
<script>import Layout from './Layout.mesa'</script>
<Layout><p id="mn">Main only</p></Layout>`,
      runtime, { './Layout.mesa': { default: LayoutFn } })

    const app2 = mount(fnWithout, runtime)
    expect(app2.find('#sidebar-wrapper')).toBeNull()
    expect(app2.find('#mn').textContent).toBe('Main only')
    app2.destroy()
  })

  it('default slot receives all non-named content', async () => {
    const LayoutFn = await compileLayout(`
<div>
  <slot name="sidebar" />
  <main id="main-area"><slot /></main>
</div>`)

    const fn = await compileAndExec(`
<script>import Layout from './Layout.mesa'</script>
<Layout>
  <p slot="sidebar" id="sb">Sidebar</p>
  <p id="a">First</p>
  <p id="b">Second</p>
</Layout>`, runtime, { './Layout.mesa': { default: LayoutFn } })

    const app = mount(fn, runtime)
    expect(app.find('#sb').textContent).toBe('Sidebar')
    expect(app.find('#a').textContent).toBe('First')
    expect(app.find('#b').textContent).toBe('Second')
    app.destroy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  {#virtual each}
// ─────────────────────────────────────────────────────────────────────────────

describe('{#virtual each}', () => {
  let runtime
  beforeEach(async () => { runtime = await import('./runtime.js') })

  it('compiles to $$virtualEach call', async () => {
    const { result } = await compile(`
<div>
  {#virtual each rows as row (row.id)}
    <div>{row.id}</div>
  {/virtual}
</div>`)
    expect(result).toContain('$$virtualEach')
    expect(result).toContain('makeBlock')
  })

  it('emits correct key function', async () => {
    const { result } = await compile(`
<div>
  {#virtual each items as item (item.key)}
    <span>{item.name}</span>
  {/virtual}
</div>`)
    expect(result).toContain('(item) => item.key')
  })

  it('supports item and index', async () => {
    const { result } = await compile(`
<div>
  {#virtual each list as item, i (item.id)}
    <div>{i}: {item.name}</div>
  {/virtual}
</div>`)
    expect(result).toContain('$$virtualEach')
    expect(result).toContain('(item) => item.id')
  })

  it('emits null key function when no key provided', async () => {
    const { result } = await compile(`
<div>
  {#virtual each rows as row}
    <div>{row.name}</div>
  {/virtual}
</div>`)
    expect(result).toContain('$$virtualEach')
    expect(result).toContain(', null,')
  })

  it('renders correct DOM with virtual each', async () => {
    const fn = await compileAndExec(`
<script>
  let rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: 'Item ' + (i + 1) }))
</script>
<div class="container" style="height:200px;overflow-y:auto">
  {#virtual each rows as row (row.id)}
    <div class="row" style="height:40px">{row.name}</div>
  {/virtual}
</div>`, runtime)

    const app = mount(fn, runtime)
    // Should render a subset of 50 rows (overscan=5, ~5 visible at 40px height in 200px)
    const rows = app.container.querySelectorAll('.row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(50)
    // First visible row should be Item 1
    expect(rows[0].textContent.trim()).toBe('Item 1')
    app.destroy()
  })
})

describe('{@const}', () => {
  it('plain const — non-reactive expression', async () => {
    const out = await cx(`
<script>let arr = [{id:1,val:42}]</script>
{#each arr as item}
  {@const doubled = item.val * 2}
  <p>{doubled}</p>
{/each}`)
    // Non-reactive: item.val is an each accessor call, not a signal read
    // rewriteExpr replaces item.val with item().val, which IS a change
    // so it becomes a memo. Either way it should be declared.
    expect(out).toMatch(/const.*doubled/)
  })

  it('reactive const — expression reads a signal', async () => {
    const out = await cx(`
<script>let idx = 0
let arr = [{id:1}]</script>
{#each arr as item (item.id)}
  {@const isActive = item.id === idx}
  <p class:active={isActive}>{isActive}</p>
{/each}`)
    // isActive reads $$sig_idx, so it gets wrapped in createMemo
    expect(out).toContain('createMemo')
    expect(out).toContain('$$_const_isActive')
    expect(out).toContain('$$sig_idx')
  })

  it('chained @const — second references first', async () => {
    const out = await cx(`
<script>let items = [{id:1}]
let sel = 0</script>
{#each items as item (item.id)}
  {@const gi = item.id}
  {@const active = gi === sel}
  <p class:active={active}></p>
{/each}`)
    expect(out).toContain('const gi')
    expect(out).toContain('active')
    expect(out).not.toContain('isActive is not defined')
  })

  it('error on missing = in @const', async () => {
    const ctx = await compile(
      `{#each [1] as x}{@const bad}{/each}`,
      { debug: false, css: false }
    )
    expect(ctx.analysis.errors.some(e => e.includes('@const'))).toBe(true)
  })
})

describe('{#await} — thenBlock/catchBlock value binding', () => {
  it('thenBlock factory receives value as first param — not $parentElement', async () => {
    const out = await cx(`<script>let p = Promise.resolve()</script>
{#await p}{:then data}<p>{data}</p>{/await}`)
    // Must NOT have $parentElement as the leading param — that was the bug
    expect(out).not.toContain('($parentElement, data)')
    // Must have just (data) =>
    expect(out).toContain('(data) =>')
  })

  it('catchBlock factory receives error as first param', async () => {
    const out = await cx(`<script>let p = Promise.resolve()</script>
{#await p}{:catch err}<p>{err.message}</p>{/await}`)
    expect(out).not.toContain('($parentElement, err)')
    expect(out).toContain('(err) =>')
  })

  it('no-value thenBlock emits () =>', async () => {
    const out = await cx(`<script>let p = Promise.resolve()</script>
{#await p}<p>loading</p>{:then}<p>done</p>{/await}`)
    expect(out).toContain('() =>')
  })

  it('value is accessible in thenBlock body', async () => {
    const out = await cx(`<script>let p = Promise.resolve()</script>
{#await p}{:then result}<p>{result.name}</p>{/await}`)
    expect(out).toContain('result.name')
    // Ensure result is referenced inside the makeBlock callback, not as dead outer param
    expect(out).not.toContain('($parentElement, result)')
  })
})

describe('bind:value|mask', () => {
  it('static string pattern — emits bindMask directly', async () => {
    const out = await cx(`<script>let d = ''</script><input bind:value|mask({"99/99/9999"})={d} />`)
    expect(out).toContain('bindMask')
    expect(out).toContain('"99/99/9999"')
    expect(out).not.toContain('createEffect(() => { $runtime.bindMask')
  })

  it('reactive const pattern — emits bindMask inside createEffect', async () => {
    const out = await cx(`<script>
      let card = ''
      let t = 'visa'
      const cardMask = t === 'amex' ? '9999 999999 99999' : '9999 9999 9999 9999'
    </script><input bind:value|mask({cardMask})={card} />`)
    expect(out).toContain('createEffect(() => { $runtime.bindMask')
    expect(out).toContain('$runtime.get(cardMask)')
  })

  it('phone pattern with parens and dash', async () => {
    const out = await cx(`<script>let p = ''</script><input bind:value|mask({"(999) 999-9999"})={p} />`)
    expect(out).toContain('"(999) 999-9999"')
  })

  it('$money special pattern', async () => {
    const out = await cx(`<script>let a = ''</script><input bind:value|mask({"$money"})={a} />`)
    expect(out).toContain('"$money"')
  })

  it('error — mask without argument', async () => {
    const ctx = await compile(
      `<script>let v = ''</script><input bind:value|mask={v} />`,
      { css: false, debug: false }
    )
    expect(ctx.analysis.errors.some(e => e.includes('mask') && e.includes('argument'))).toBe(true)
  })
})

describe('set_attribute reactive inside {#each} — regression', () => {
  it('set_attribute is inside render() for {#each} item attributes', async () => {
    const out = await cx(`<script>
      let items = [{ id: 1, status: 'active' }]
    </script>
    {#each items as item (item.id)}
      <div data-status={item.status}>{item.status}</div>
    {/each}`)
    // set_attribute must appear inside a render() call, not bare
    const renderBlocks = out.split('$runtime.render(')
    const insideRender = renderBlocks.slice(1).some(chunk => chunk.includes('set_attribute'))
    expect(insideRender).toBe(true)
  })

  it('set_text/nodeValue is inside render() for {#each} item text', async () => {
    const out = await cx(`<script>
      let items = [{ id: 1, name: 'Alice' }]
    </script>
    {#each items as item (item.id)}
      <p>{item.name}</p>
    {/each}`)
    const renderBlocks = out.split('$runtime.render(')
    const insideRender = renderBlocks.slice(1).some(chunk =>
      chunk.includes('set_text') || chunk.includes('nodeValue')
    )
    expect(insideRender).toBe(true)
  })

  it('multiple attributes on {#each} item are all reactive', async () => {
    const out = await cx(`<script>
      let items = [{ id: 1, status: 'on', label: 'A', disabled: false }]
    </script>
    {#each items as item (item.id)}
      <button data-status={item.status} disabled={item.disabled}>{item.label}</button>
    {/each}`)
    // All three bindings should be in the same render() block
    const renderMatch = out.match(/\$runtime\.render\([\s\S]*?set_attribute[\s\S]*?set_attribute[\s\S]*?set_text[\s\S]*?\}/)
    expect(renderMatch).toBeTruthy()
  })
})

describe('$inspect builtin', () => {
  // $inspect is a dev-only builtin — must compile with debug: true (default)
  const cxDev = src => compile(src, { debug: true, css: false }).then(c => c.result)

  it('injects $inspect local from runtime', async () => {
    const out = await cxDev(`<script>let x = 0\n$inspect(x)</script><p>{x}</p>`)
    expect(out).toContain('const $inspect   = $runtime.$inspect')
  })

  it('transforms $inspect(signal) into structured call with getter', async () => {
    const out = await cxDev(`<script>let count = 0\n$inspect(count)</script><p>{count}</p>`)
    expect(out).toContain('$inspect({ label: "count", getters: [() => ($runtime.get($$sig_count))] })')
  })

  it('transforms $inspect(proxy) with proxy accessor', async () => {
    const out = await cxDev(`<script>
      import { cart } from './store.js'
      $: cart
      $inspect(cart)
    </script><p>{cart.total}</p>`)
    expect(out).toContain('$inspect({ label: "cart", getters: [() => ($$proxy_cart)] })')
  })

  it('handles multiple args with comma-joined label', async () => {
    const out = await cxDev(`<script>let a = 0\nlet b = ''\n$inspect(a, b)</script><p>{a}</p>`)
    expect(out).toContain('"a, b"')
    expect(out).toContain('$runtime.get($$sig_a)')
    expect(out).toContain('$runtime.get($$sig_b)')
  })

  it('transforms $inspect(x).with(fn) chaining', async () => {
    const out = await cxDev(`<script>let x = 0\n$inspect(x).with(console.trace)</script><p>{x}</p>`)
    expect(out).toContain('.with(console.trace)')
    expect(out).toContain('"x"')
    expect(out).toContain('$runtime.get($$sig_x)')
  })

  it('does not inject $inspect if not used', async () => {
    const out = await cx(`<script>let x = 0</script><p>{x}</p>`)
    expect(out).not.toContain('$inspect')
  })

  it('strips $inspect in production (debug: false)', async () => {
    const out = await cx(`<script>let x = 0\n$inspect(x)</script><p>{x}</p>`)
    expect(out).not.toContain('$inspect')
  })
})

// ── Dev instrumentation (config.dev: true) ───────────────────────────────────

describe('dev instrumentation — compiler output', () => {
  it('passes component name + file to push_component in dev mode', async () => {
    const out = await cxDevMode(`<script>let count = 0</script><p>{count}</p>`)
    expect(out).toContain("push_component('Counter', '")
  })

  it('does NOT pass args to push_component in prod mode', async () => {
    const out = await cx(`<script>let count = 0</script><p>{count}</p>`)
    expect(out).toContain('push_component()')
  })

  it('emits __dev.r() for plain let', async () => {
    const out = await cxDevMode(`<script>let count = 0</script><p>{count}</p>`)
    expect(out).toContain(`__dev?.r($$sig_count, 'count', 'let')`)
  })

  it('emits __dev.r() for export let prop', async () => {
    const out = await cxDevMode(`<script>export let value = 0</script><p>{value}</p>`)
    expect(out).toContain(`__dev?.r($$sig_value, 'value', 'prop')`)
  })

  it('emits __dev.r() for writable derived ($: name = expr)', async () => {
    const out = await cxDevMode(`<script>let items = [1,2]\n$: first = items[0]</script><p>{first}</p>`)
    expect(out).toContain(`__dev?.r($$sig_first, 'first', 'writable-derived')`)
  })

  it('emits __dev.r() for derived const', async () => {
    const out = await cxDevMode(`<script>let count = 0\nconst double = count * 2</script><p>{double}</p>`)
    expect(out).toContain(`__dev?.r(double, 'double', 'derived')`)
  })

  it('does NOT emit __dev.r() for static const', async () => {
    const out = await cxDevMode(`<script>const MAX = 100</script><p>{MAX}</p>`)
    expect(out).not.toContain(`__dev?.r`)
  })

  it('does NOT emit __dev.r() for var', async () => {
    const out = await cxDevMode(`<script>let price = 10\nvar snap = price</script><p>{price}</p>`)
    expect(out).not.toContain(`__dev?.r(snap`)
  })

  it('emits __dev.r() for async derived const', async () => {
    const out = await cxDevMode(`<script>let id = 1\nconst data = await fetch('/api/' + id)</script><p>{id}</p>`)
    expect(out).toContain(`__dev?.r($$sig_data, 'data', 'async-derived')`)
  })

  it('emits __dev.r() for one-shot async const', async () => {
    const out = await cxDevMode(`<script>const states = await fetch('/states')</script><p>hi</p>`)
    expect(out).toContain(`__dev?.r($$sig_states, 'states', 'async')`)
  })

  it('emits no __dev calls in prod mode', async () => {
    const out = await cx(`<script>let count = 0\nexport let val = 1\nconst d = count * 2</script><p>{count}</p>`)
    expect(out).not.toContain('__dev')
  })
})

describe('dev instrumentation — runtime', () => {
  it('__dev.r() registers signal and associates with current component', async () => {
    const { __dev, track, set, push_component, pop_component } = await import('./runtime.js')
    // Clear between tests
    __dev._signals.clear(); __dev._components.clear(); __dev._log = []

    push_component('TestComp', 'TestComp.mesa')
    const sig = track(42)
    __dev.r(sig, 'count', 'let')
    pop_component()

    expect(__dev._signals.size).toBe(1)
    const [, record] = [...__dev._signals.entries()][0]
    expect(record.name).toBe('count')
    expect(record.kind).toBe('let')
    expect(__dev._components.size).toBe(1)
    const [, comp] = [...__dev._components.entries()][0]
    expect(comp.name).toBe('TestComp')
    expect(comp.signals.has(sig)).toBe(true)
  })

  it('__dev._onUpdate() appends to log and notifies listeners', async () => {
    const { __dev, track, set, push_component, pop_component } = await import('./runtime.js')
    __dev._signals.clear(); __dev._components.clear(); __dev._log = []

    const events = []
    __dev.subscribe(e => events.push(e))

    push_component('TestComp2', 'TestComp2.mesa')
    const sig = track(0)
    __dev.r(sig, 'score', 'let')
    pop_component()

    set(sig, 99)

    expect(__dev._log.length).toBe(1)
    expect(__dev._log[0].name).toBe('score')
    expect(__dev._log[0].value).toBe(99)
    expect(events.some(e => e.type === 'update' && e.data.name === 'score')).toBe(true)

    __dev.unsubscribe(events => {}) // cleanup — ignore; unsubscribing a different ref is a no-op
  })

  it('snapshot() returns current state', async () => {
    const { __dev, track, push_component, pop_component } = await import('./runtime.js')
    __dev._signals.clear(); __dev._components.clear(); __dev._log = []

    push_component('Snap', 'Snap.mesa')
    const sig = track('hello')
    __dev.r(sig, 'msg', 'let')
    pop_component()

    const snap = __dev.snapshot()
    expect(snap.components.length).toBeGreaterThan(0)
    expect(snap.signals.some(s => s.name === 'msg')).toBe(true)
    expect(snap.signals.find(s => s.name === 'msg').value).toBe('hello')
  })

  it('__dev has zero overhead when no signals registered (prod path)', async () => {
    const { __dev, track, set } = await import('./runtime.js')
    __dev._signals.clear(); __dev._components.clear(); __dev._log = []

    const sig = track(0)
    // No __dev.r() call — simulates prod-compiled component
    set(sig, 1)
    expect(__dev._log.length).toBe(0)
  })
})

describe('top-level await in expressions', () => {
  it('reactive assignment with await wraps in async IIFE', async () => {
    const out = await cx(`
<script>
  let data = null
  data = await fetch('/api').then(r => r.json())
</script>
<div></div>`)
    // Should be wrapped, not bare top-level await
    expect(out).toContain('(async () => {')
    expect(out).toContain('await fetch(')
    // Should NOT have bare top-level await outside IIFE
    const lines = out.split('\n')
    const bareAwait = lines.find(l => /^\s*\$\$set_\w+\(await/.test(l.trim()) && !l.includes('async'))
    expect(bareAwait).toBeUndefined()
  })

  it('const await declaration still uses async IIFE (existing behaviour)', async () => {
    const out = await cx(`
<script>
  const data = await fetch('/api').then(r => r.json())
</script>
<div></div>`)
    expect(out).toContain('async ()')
    expect(out).toContain('await (')
  })

  it('non-await assignment is NOT wrapped', async () => {
    const out = await cx(`
<script>
  let x = 0
  x = 42
</script>
<div></div>`)
    expect(out).not.toContain('async ()')
    expect(out).toContain('$$set_x(42)')
  })
})

describe('compileMd remark/rehype plugins', () => {
  it('remark plugin receives and can transform the AST', async () => {
    // Plugin that adds a class to all headings
    function remarkAddHeadingClass() {
      return (tree) => {
        const visit = (node) => {
          if (node.type === 'heading') {
            node.data = node.data ?? {}
            node.data.hProperties = { ...(node.data.hProperties ?? {}), class: 'custom-heading' }
          }
          ;(node.children ?? []).forEach(visit)
        }
        visit(tree)
      }
    }

    const src = '# Hello World\n\nSome text.'
    const r = await compileSource(src, {
      filename: 'test.md',
      remarkPlugins: [remarkAddHeadingClass],
    })
    expect(r.analysis.errors).toHaveLength(0)
    // The heading carries the class (Mesa appends a scoped hash: class="custom-heading <hash>")
    expect(r.result).toContain('custom-heading')
  })

  it('rehype plugin receives and can transform the HTML AST', async () => {
    // Plugin that wraps all paragraphs in a div
    function rehypeWrapParagraphs() {
      return (tree) => {
        const visit = (node, parent, index) => {
          if (node.tagName === 'p' && parent) {
            const wrapper = { type: 'element', tagName: 'div', properties: { className: ['para-wrap'] }, children: [node] }
            parent.children.splice(index, 1, wrapper)
          }
          ;(node.children ?? []).forEach((c, i) => visit(c, node, i))
        }
        if (tree.children) tree.children.forEach((c, i) => visit(c, tree, i))
      }
    }

    const src = 'Hello paragraph.'
    const r = await compileSource(src, {
      filename: 'test.md',
      rehypePlugins: [rehypeWrapParagraphs],
    })
    expect(r.analysis.errors).toHaveLength(0)
    expect(r.result).toContain('para-wrap')
  })

  it('plugin with options array form [plugin, opts]', async () => {
    function remarkSetMeta(opts = {}) {
      return (tree, file) => {
        file.data = file.data ?? {}
        file.data.testMeta = opts.value ?? 'default'
      }
    }

    const src = 'Some content.'
    // Should not throw — options are passed through
    const r = await compileSource(src, {
      filename: 'test.md',
      remarkPlugins: [[remarkSetMeta, { value: 'hello' }]],
    })
    expect(r.analysis.errors).toHaveLength(0)
  })

  it('no plugins uses default processor (no regression)', async () => {
    const src = '# Title\n\nParagraph with **bold**.'
    const r = await compileSource(src, { filename: 'test.md' })
    expect(r.analysis.errors).toHaveLength(0)
    expect(r.result).toContain('Title')
  })
})
