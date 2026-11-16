/**
 * shadowed-local-write.test.js
 *
 * A function-local binding that shares a name with a component-level reactive
 * `let` is a different variable, and a write to it stays a plain write
 * (FJS-4348). The read side always resolved to the local, so the failure was
 * split: `let left = 2; left = left + 1` emitted `$$set_left(left + 1)` — the
 * local stayed 2 and the component's signal was overwritten.
 */

import { describe, test, expect } from 'vitest'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'

const compile = async (body) => {
  const ctx = await compileSource(`<script>
  let left = null
${body}
</script>
<p>{left}</p>`, { filename: '/test/T.mesa', dev: false })
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  return ctx.result
}

/** The source of the named function in the output. */
const fnBody = (js, name) => {
  const at = js.indexOf(name)
  return js.slice(at, js.indexOf('\n  }', at))
}

describe('a write to a local that shadows a reactive let stays local', () => {
  test('let in a function body, = and +=', async () => {
    const js = await compile(`  function launch() {
    let left = 2
    left = left + 1
    left += 1
    return left
  }`)
    const body = fnBody(js, 'function launch')
    expect(body).not.toMatch(/\$\$set_left|\$\$sig_left/)
    expect(body).toMatch(/left = left \+ 1/)
    expect(body).toMatch(/left \+= 1/)
  })

  test('the same in an async function, with ++', async () => {
    const js = await compile(`  async function go() {
    let left = await Promise.resolve(2)
    left++
    return left
  }`)
    const body = fnBody(js, 'function go')
    expect(body).not.toMatch(/\$\$set_left|\$\$sig_left/)
    expect(body).toMatch(/left\+\+/)
  })

  test('a parameter and a destructured local', async () => {
    const js = await compile(`  function a(left) { left = 1; return left }
  function b() { let [left] = [1]; [left] = [2]; return left }`)
    expect(fnBody(js, 'function a')).not.toMatch(/\$\$set_left/)
    expect(fnBody(js, 'function b')).not.toMatch(/\$\$set_left/)
  })

  test('a block shadow ends with its block; outside it the write is the signal', async () => {
    const js = await compile(`  function c() {
    if (true) { let left = 1; left = 3 }
    left = 9
  }`)
    const body = fnBody(js, 'function c')
    expect(body).toMatch(/left = 3/)
    expect(body).toMatch(/\$\$set_left\(9\)/)
  })

  test('an unshadowed write in a function still sets the signal', async () => {
    const js = await compile(`  function d() { left = 4 }`)
    expect(fnBody(js, 'function d')).toMatch(/\$\$set_left\(4\)/)
  })
})
