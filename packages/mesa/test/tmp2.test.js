import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'

const compile = (src, filename = 'T.mesa') => compileSource(src, { filename, css: false, debug: false })
const build = async (src, name, Child) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
    .replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
  return new Function('$runtime', 'Child', code + '\nreturn __c')($rt, Child)
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

describe('snippet arg inside a nested component slot', () => {
  it('updates the slot text when the arg changes', async () => {
    const Pill = await build(`<span class="pill"><slot /></span>`, 'Pill.mesa')
    const Parent = await build(
      `<script>
        import Child from './Pill.mesa'
        let o = { status: 'pending' }
        const bump = () => { o = { status: 'paid' } }
      </script>
      {#snippet row(x)}<Child>{x.status}</Child>{/snippet}
      <div>{@render row(o)}</div>
      <button on:click={bump}>go</button>`, 'Parent.mesa', Pill)

    const c = mount(Parent)
    expect(c.querySelector('.pill').textContent.trim()).toBe('pending')
    c.querySelector('button').click()
    $rt.flushSync()
    console.log('SLOT HTML:', c.querySelector('div').innerHTML)
    expect(c.querySelector('.pill').textContent.trim()).toBe('paid')
    c.remove()
  })
})

describe('table shape', () => {
  it('each inside an if/else chain, snippet row, external-ish getter', async () => {
    const Child = await build(
      `<script>
        export let row = null
        export let rows = []
        export let loading = false
      </script>
      <table><tbody>
        {#if loading}
          <tr><td>loading</td></tr>
        {:else if !rows.length}
          <tr><td>empty</td></tr>
        {:else}
          {#each rows as r, i (i)}
            {@render row?.(r, i)}
          {/each}
        {/if}
      </tbody></table>`, 'Child.mesa')

    const Parent = await build(
      `<script>
        import Child from './Child.mesa'
        let items = [{ ref: 'a', status: 'pending' }]
        const bump = () => { items = [{ ref: 'a', status: 'paid' }] }
      </script>
      <Child rows={items}>
        {#snippet row(o)}
          <tr><td>{o.ref}</td><td class="pill">{o.status}</td></tr>
        {/snippet}
      </Child>
      <button on:click={bump}>go</button>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('.pill').textContent).toBe('pending')
    c.querySelector('button').click()
    $rt.flushSync()
    console.log('HTML:', c.querySelector('tbody').innerHTML)
    expect(c.querySelector('.pill').textContent).toBe('paid')
    c.remove()
  })
})
