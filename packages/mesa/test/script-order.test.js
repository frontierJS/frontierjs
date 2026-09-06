/**
 * script-order.test.js — a declaration must be able to see the one above it.
 *
 * An instance `<script>` is not emitted in source order: variables are
 * topologically sorted so a derived can name one declared below it, and the
 * effects follow every declaration. That reordering is deliberate and is what
 * makes `$:` and derived values work. A `class` declaration was outside it —
 * emitted with the trailing statements, after every variable — and a class
 * binding does not hoist, so `const c = new C()` read `C` in its temporal
 * dead zone and the component threw on its first mount with nothing said at
 * compile time (`FJS-846`).
 *
 * What orders a class is only what its DECLARATION evaluates: the superclass,
 * a computed key, the static half. A method body is deferred, so a name read
 * there orders nothing — asserted below, because the cheap fix of ordering on
 * every identifier in the class turns a method reading a `let` into a cycle.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false })

const build = async (src, name) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
  return new Function('$$runtime', code + '\nreturn __c')($rt)
}

const mount = (Comp) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const l = document.createElement('span')
  c.appendChild(l)
  $rt.mount(l, Comp, { props: {} })
  $rt.flushSync()
  return c
}

describe('a class declaration in an instance script (FJS-846)', () => {
  it('is instantiable by a const below it', async () => {
    const C = await build(`<script>
  class Counter { constructor() { this.n = 7 } }
  const c = new Counter()
</script>
<p>{c.n}</p>`, 'ClassThenConst.mesa')
    expect(mount(C).textContent).toBe('7')
  })

  it('is instantiable by a const ABOVE it in source', async () => {
    // The sort is by dependency, not by position — `const c` names `Later`,
    // so the class has to be emitted first however the file is written.
    const C = await build(`<script>
  const c = new Later()
  class Later { constructor() { this.n = 3 } }
</script>
<p>{c.n}</p>`, 'ConstThenClass.mesa')
    expect(mount(C).textContent).toBe('3')
  })

  it('can extend a class declared below it', async () => {
    const C = await build(`<script>
  class Child extends Base { }
  class Base { get n() { return 5 } }
  const c = new Child()
</script>
<p>{c.n}</p>`, 'ClassExtendsClass.mesa')
    expect(mount(C).textContent).toBe('5')
  })

  it('can extend a local const', async () => {
    const C = await build(`<script>
  const Base = class { get n() { return 4 } }
  class Child extends Base { }
  const c = new Child()
</script>
<p>{c.n}</p>`, 'ClassExtendsConst.mesa')
    expect(mount(C).textContent).toBe('4')
  })

  it('reads a reactive let from a method body without ordering on it', async () => {
    // The negative control for the dependency walk: `n` is read inside a
    // method, which runs when it is called. Ordering the class on it would
    // make this file a cycle and refuse a component that works.
    const C = await build(`<script>
  let n = 2
  class Reader { read() { return n } }
  const c = new Reader()
</script>
<p>{c.read()}</p>`, 'MethodBodyRead.mesa')
    expect(mount(C).textContent).toBe('2')
  })

  it('reads a reactive let from a static field, which does order it', async () => {
    const C = await build(`<script>
  let n = 6
  class Held { static base = n }
  const c = Held.base
</script>
<p>{c}</p>`, 'StaticFieldRead.mesa')
    expect(mount(C).textContent).toBe('6')
  })

  it('names both sides when a class and a declaration need each other', async () => {
    // Neither can be emitted first, so the compiler says which two rather than
    // picking one and letting the mount throw.
    const ctx = await compile(`<script>
  class Child extends Base { }
  const Base = new Child()
</script>
<p>x</p>`, 'ClassCycle.mesa')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain('Child')
    expect(ctx.analysis.errors[0]).toContain('Base')
  })
})
