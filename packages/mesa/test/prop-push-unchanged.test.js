// FJS-2589 — a parent re-render does not re-send a prop whose value it did not
// change. The push to a child re-runs when ANY prop moves; a child that wrote
// its own copy of an unbound prop had that write reverted by the parent's
// unchanged value, which is how `<Form record={row} bind:dirty>` lost the
// keystroke that flipped `dirty`.
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(js, userImports = {}) {
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(js)) !== null) {
    if (m[2] === '@frontierjs/mesa/runtime') continue
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
  `<script>\n  export let value = ''\n  export let other = 0\n</script>\n` +
  `<button class="own" onclick={() => (value = 'mine')}>own</button>` +
  `<i>{value}</i><b>{other}</b>`

const PARENT =
  `<script>\n  import Child from './Child.mesa'\n  let row = 'old'\n  let n = 0\n</script>\n` +
  `<button class="bump" onclick={() => n++}>bump</button>` +
  `<button class="swap" onclick={() => (row = 'next')}>swap</button>` +
  `<Child value={row} other={n} />`

describe('FJS-2589: an unchanged prop is not pushed again', () => {
  it('keeps the child\'s own write until the parent changes that prop', async () => {
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

    expect(text('i')).toBe('old')
    click('.own')
    expect(text('i')).toBe('mine')

    click('.bump')
    expect(text('b')).toBe('1')
    expect(text('i')).toBe('mine')

    click('.swap')
    expect(text('i')).toBe('next')
    container.remove()
  })
})
