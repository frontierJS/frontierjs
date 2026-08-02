/**
 * async-decl-scope.test.js
 *
 * Regression tests for: an `async function` declaration whose body contains
 * `await` was wrapped in an async IIFE, scoping the declaration inside it.
 *
 *   async function handleLogin() { await save() }
 *
 * compiled to
 *
 *   (async () => { async function handleLogin() { await save() } })()
 *
 * so a template binding `onclick={handleLogin}` resolved to nothing and threw
 * "ReferenceError: handleLogin is not defined" at click time — no compile
 * warning, no build failure. Surfaced by the smoke-test login form.
 *
 * Cause: the wrap condition was a regex, `/\bawait\b/.test(rewritten)`, which
 * cannot distinguish a top-level await from one nested inside a function body.
 * Replaced with `_hasTopLevelAwait(node)`, an AST walk that stops at function
 * and class boundaries and refuses to wrap declarations outright.
 */

import { describe, test, expect } from 'vitest'
import { compileSource } from './compiler.js'

const compile = (src) => compileSource(src, { filename: '/test/T.mesa', dev: false })

/** Is the named binding declared in the component body rather than inside an IIFE? */
function declaredAtComponentScope(js, name) {
  const lines = js.split('\n')
  let depth = 0
  for (const line of lines) {
    const before = depth
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (new RegExp(`(async )?function ${name}\\b`).test(line)) {
      // depth 1 === directly inside `export default function Component(...) {`
      return before === 1 && !/\(async \(\) => \{/.test(line)
    }
  }
  return false
}

describe('async function declarations stay at component scope', () => {
  test('async declaration containing await is not wrapped in an IIFE', async () => {
    const ctx = await compile(`<script>
  let status = ''
  async function submit() {
    await new Promise(r => setTimeout(r, 1))
    status = 'done'
  }
</script>
<button onclick={submit}>go</button>`)

    expect(ctx.result).not.toMatch(/\(async \(\) => \{\s*async function submit/)
    expect(declaredAtComponentScope(ctx.result, 'submit')).toBe(true)
  })

  test('async declaration without await is unaffected', async () => {
    const ctx = await compile(`<script>
  let status = ''
  async function submit() { status = 'done' }
</script>
<button onclick={submit}>go</button>`)
    expect(declaredAtComponentScope(ctx.result, 'submit')).toBe(true)
  })

  test('plain function declaration is unaffected', async () => {
    const ctx = await compile(`<script>
  let status = ''
  function submit() { status = 'done' }
</script>
<button onclick={submit}>go</button>`)
    expect(declaredAtComponentScope(ctx.result, 'submit')).toBe(true)
  })

  test('multiple awaits in a declaration still do not trigger wrapping', async () => {
    const ctx = await compile(`<script>
  let a = null, b = null
  async function loadBoth() {
    a = await fetch('/a')
    b = await fetch('/b')
  }
</script>
<button onclick={loadBoth}>go</button>`)
    expect(declaredAtComponentScope(ctx.result, 'loadBoth')).toBe(true)
  })

  test('nested async function inside a sync declaration is fine', async () => {
    const ctx = await compile(`<script>
  let x = 0
  function outer() {
    async function inner() { await Promise.resolve(); x = 1 }
    inner()
  }
</script>
<button onclick={outer}>go</button>`)
    expect(declaredAtComponentScope(ctx.result, 'outer')).toBe(true)
  })
})

describe('genuine top-level await is still wrapped', () => {
  test('await in an assignment statement is wrapped', async () => {
    const ctx = await compile(`<script>
  let data = null
  data = await fetch('/api')
</script>
<p>{data}</p>`)
    expect(ctx.result).toMatch(/\(async \(\) => \{/)
  })

  test('bare await expression statement is wrapped', async () => {
    const ctx = await compile(`<script>
  let ready = false
  await new Promise(r => setTimeout(r, 1))
</script>
<p>{ready}</p>`)
    expect(ctx.result).toMatch(/\(async \(\) => \{/)
  })
})
