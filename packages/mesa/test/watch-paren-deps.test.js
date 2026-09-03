// watch-paren-deps.test.js
//
// A `$:` dep list is a comma expression, so a PARENTHESISED group inside one is
// another SequenceExpression rather than a leaf. `$: (a.x, a.y), () => f()`
// therefore reached the dep collector as a single node whose path is null and
// whose identifier set is the ROOT alone, and the two paths were silently
// replaced by a watch on the whole object — wrong even when nothing else broke,
// because a property change fires no whole-object watch.
//
// Where the component ALSO held a bare `$: a.x`, the emitter went on to write a
// reference to `$$watch_a`, which nothing declares. That module PARSES, so
// Invariant 15's parse check cannot see it; what is raised is
// `ReferenceError: $$watch_a is not defined` from inside createEffect on mount,
// which reaches a browser as a dead screen and a console error (`FJS-599`).
//
// The two halves are separable and both are asserted here. The silent half is
// asserted as byte-identity against the unparenthesised twin, because that is
// the whole claim — the parens are grouping and must mean nothing. The loud
// half is asserted as "every `$$watch_*` this module reads, it also declares",
// which is a property over the emitted string rather than a list of shapes, so
// a new way to reach an undeclared signal fails here too.

import { describe, test, expect, beforeAll } from 'vitest'
import { compileSource } from '../src/compiler.js'

let flushSync, mount, createRoot, $rt

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'DocumentFragment']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  $rt = await import('../src/runtime.js')
  ;({ flushSync, mount, createRoot } = $rt)
})

const compile = (script, tpl = '<p>{1}</p>') =>
  compileSource(`<script>\n${script}\n</script>${tpl}`, { filename: '/t/T.mesa', dev: false })

/** Every `$$watch_*` the module reads, and every one it declares. */
const watchSigs = (js) => ({
  read: new Set(js.match(/\$\$watch_[A-Za-z0-9_$]+/g) ?? []),
  declared: new Set(
    [...js.matchAll(/const \[(\$\$watch_[A-Za-z0-9_$]+)/g)].map((m) => m[1])
      .concat([...js.matchAll(/(\$\$watch_[A-Za-z0-9_$]+)\s*=/g)].map((m) => m[1]))
  ),
})

// ─── The silent half: parens are grouping ─────────────────────────────────────

describe('a parenthesised dep list means what the unparenthesised one means', () => {

  const IMPORT = `import { a } from './s.js'\nfunction f(){}`

  test('$: (a.x, a.y), handler compiles to what $: a.x, a.y, handler compiles to', async () => {
    const bare  = await compile(`${IMPORT}\n$: a.x, a.y, () => f()`)
    const paren = await compile(`${IMPORT}\n$: (a.x, a.y), () => f()`)
    expect(paren.result).toBe(bare.result)
  })

  test('the paths are watched, not the object they hang off', async () => {
    const { result } = await compile(`${IMPORT}\n$: (a.x, a.y), () => f()`)
    expect(result).toMatch(/watchPath\(a, 'x'\)/)
    expect(result).toMatch(/watchPath\(a, 'y'\)/)
    // The whole-object watch is what the bug emitted instead.
    expect(result).not.toMatch(/watchPath\(a, ''\)/)
    expect(result).not.toMatch(/const \$\$v = a;/)
  })

  test('nesting is flattened however deep it goes', async () => {
    const flat   = await compile(`${IMPORT}\n$: a.x, a.y, a.z, () => f()`)
    const nested = await compile(`${IMPORT}\n$: ((a.x, a.y), a.z), () => f()`)
    expect(nested.result).toBe(flat.result)
  })

  test('a bare multi-path watch flattens too', async () => {
    const flat   = await compile(`${IMPORT}\n$: a.x, a.y`)
    const nested = await compile(`${IMPORT}\n$: (a.x), (a.y)`)
    expect(nested.result).toBe(flat.result)
  })

  test('a group entry flattens the same way', async () => {
    const flat   = await compile(`${IMPORT}\n$: {\n  a.x, a.y, () => f()\n}`)
    const nested = await compile(`${IMPORT}\n$: {\n  (a.x, a.y), () => f()\n}`)
    expect(nested.result).toBe(flat.result)
    expect(nested.result).toMatch(/deps: \[\$\$watch_a_x, \$\$watch_a_y\]/)
  })
})

// ─── The loud half: no reference to a signal nothing declares ─────────────────

describe('every watch signal read is a watch signal declared', () => {

  const CASES = {
    'a parenthesised list beside a bare path':
      `$: a.x\n$: (a.x, a.y), () => f()`,
    'a bare dep on a root another watch proxied':
      `$: a.x\n$: a, () => f()`,
    'a group whose deps are the only thing naming the root':
      `$: {\n  a.x, () => f()\n}`,
    'a group beside a bare path':
      `$: a.x\n$: {\n  (a.x, a.y), () => f()\n}`,
    'a group dep on the root itself':
      `$: a.x\n$: {\n  a, () => f()\n}`,
  }

  for (const [name, form] of Object.entries(CASES)) {
    test(name, async () => {
      const { result } = await compile(`import { a } from './s.js'\nfunction f(){}\n${form}`)
      const { read, declared } = watchSigs(result)
      expect([...read].filter((s) => !declared.has(s))).toEqual([])
    })
  }

  test('a group dep that resolves to no signal is not silently dropped', async () => {
    // Before the fix this emitted `deps: []` — an entry subscribed to nothing,
    // which never fires and says nothing.
    const { result } = await compile(`import { a } from './s.js'\nfunction f(){}\n$: {\n  a.x, () => f()\n}`)
    expect(result).toMatch(/deps: \[\$\$watch_a_x\]/)
  })
})

// ─── Mounted ──────────────────────────────────────────────────────────────────
// The emitted string is not the claim. `ReferenceError: $$watch_a is not
// defined` is raised when the effect RUNS, so the only assertion that can see
// the defect the issue was filed for is a component that mounts.

describe('mounted', () => {
  /** index.html's execCompiled, minus the userImports plumbing. */
  const exec = (js) => {
    let code = js.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    code = code.replace(/^export default\s+/m, 'const __component = ')
    return new Function('$$runtime', code + '\nreturn __component')($rt)
  }

  const render = async (src) => {
    const { result } = await compileSource(src, { filename: '/t/T.mesa', dev: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const label = document.createElement('span')
    container.appendChild(label)
    let instance, disposeRoot
    createRoot((dispose) => {
      disposeRoot = dispose
      instance = mount(label, exec(result), { props: {}, root: container })
      flushSync()
    })
    return {
      container,
      click: (text) => {
        ;[...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text).click()
        flushSync()
      },
      end: () => { disposeRoot(); instance.destroy(); container.remove() },
    }
  }

  test('a parenthesised path list fires on a property change', async () => {
    const r = await render(
      `<script>\n  let o = { x: 1, y: 2 }\n  let log = ''\n` +
      `  $: (o.x, o.y), () => { log = 'x' + o.x + 'y' + o.y }\n` +
      `  function bump() { o.x = o.x + 1 }\n</script>\n` +
      `<button on:click={bump}>+</button><p>log={log}</p>`)

    expect(r.container.textContent).toContain('log=')   // deferred: nothing on mount

    r.click('+')
    await Promise.resolve()
    flushSync()
    expect(r.container.textContent).toContain('log=x2y2')
    r.end()
  })

  test('a parenthesised list beside a bare path mounts — the ReferenceError case', async () => {
    const r = await render(
      `<script>\n  let o = { x: 1, y: 2 }\n  let log = ''\n` +
      `  $: o.x\n` +
      `  $: (o.x, o.y), () => { log = 'fired' }\n` +
      `  function bump() { o.y = o.y + 1 }\n</script>\n` +
      `<button on:click={bump}>+</button><p>x={o.x} log={log}</p>`)

    expect(r.container.textContent).toContain('x=1')

    r.click('+')
    await Promise.resolve()
    flushSync()
    expect(r.container.textContent).toContain('log=fired')
    r.end()
  })
})
