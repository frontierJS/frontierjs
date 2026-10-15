// FJS-2509 — a parent's write to a bound prop made inside the callback the
// child calls after writing it must survive the bind.
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(js, userImports = {}) {
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(js)) !== null) {
    if (m[2] === '@frontierjs/mesa/runtime.js') continue
    importNames.push(m[1].trim())
    importValues.push(userImports[m[2]])
  }
  const code = js
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
}

const CHILD =
  `<script>\n  export let files = []\n  export let onchange = undefined\n` +
  `  function add(x) { files = [...files, x]; onchange?.(files) }\n</script>\n` +
  `<button class="add" on:click={() => add(1)}>add</button><i>{files.length}</i>`

const PARENT =
  `<script>\n  import Child from './Child.mesa'\n  let picked = []\n` +
  `  const onchange = () => { picked = [] }\n</script>\n` +
  `<button class="clear" on:click={() => (picked = [])}>clear</button>` +
  `<Child bind:files={picked} {onchange} /><b>{picked.length}</b>`

describe('FJS-2509: a parent write inside the child callback survives the bind', () => {
  it('reaches parent and child', async () => {
    const childFn = execCompiled((await compile(CHILD, { debug: false, css: false })).result)
    const parentFn = execCompiled(
      (await compile(PARENT, { debug: false, css: false })).result,
      { './Child.mesa': childFn },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const anchor = document.createComment('')
    container.appendChild(anchor)
    parentFn(anchor, {}, null)
    runtime.flushSync()
    const text = (sel) => container.querySelector(sel).textContent
    const click = (sel) => { container.querySelector(sel).__click(); runtime.flushSync() }

    click('.add')
    await Promise.resolve()
    runtime.flushSync()
    expect(text('b')).toBe('0')
    expect(text('i')).toBe('0')
    click('.add')
    await Promise.resolve()
    runtime.flushSync()
    expect(text('b')).toBe('0')
    expect(text('i')).toBe('0')
  })
})
