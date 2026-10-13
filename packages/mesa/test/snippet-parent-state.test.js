/*
 * A snippet the parent passes to a child, whose body reads the PARENT's state.
 *
 * The kit Shell (IDEAS/app-shell.md step 0.3) takes a badge(entry) and a foot()
 * snippet from the app's _module.mesa and renders each twice — in the sidebar
 * and again inside a drawer the Shell opens and closes on its own state. The
 * counts and the session those snippets read belong to the app, so if a change
 * there did not reach the Shell's copies, a per-entry count would freeze at its
 * first value with no error.
 *
 * What it pins: a snippet tracks exactly the reads the parent's own template
 * would, wherever the child renders it, including a copy mounted after the
 * change and one torn down and rebuilt. RULE 43 still holds — an unwatched
 * in-place mutation reaches neither the parent nor the snippet — and an
 * imported object is written through watchProxy, the way Sierra writes session.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'

const compile = (src, filename = 'T.mesa') => compileSource(src, { filename, css: false, debug: false })
const build = async (src, name, Child, store = null) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
    .replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
  return new Function('$$runtime', 'Child', 'store', code + '\nreturn __c')($rt, Child, store)
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

const SHELL = `<script>
  export let groups = []
  export let badge = null
  export let foot = null
  let open = false
</script>
<nav class="side">
  {#each groups as e (e.id)}
    <a class="entry" data-id={e.id}>{e.label}{#if badge}<b class="badge">{@render badge(e)}</b>{/if}</a>
  {/each}
  <footer class="foot">{@render foot?.()}</footer>
</nav>
{#if open}
  <aside class="drawer">
    {#each groups as e (e.id)}<a class="dentry">{e.label}<b class="dbadge">{@render badge?.(e)}</b></a>{/each}
    <footer class="dfoot">{@render foot?.()}</footer>
  </aside>
{/if}
<button class="toggle" on:click={() => open = !open}>menu</button>`

const PARENT = `<script>
  import Child from './Shell.mesa'
  let groups = [{ id: 'a', label: 'Inbox' }, { id: 'b', label: 'Jobs' }]
  let counts = { a: 1, b: 0 }
  let user = { name: 'ada' }
  const reassign = () => { counts = { a: 5, b: 2 } }
  const mutate   = () => { counts.a = 9 }
  const rename   = () => { user = { name: 'grace' } }
  const renameIn = () => { user.name = 'linus' }
</script>
<Child {groups}>
  {#snippet badge(e)}{counts[e.id]}{/snippet}
  {#snippet foot()}<span class="who">{user.name}</span>{/snippet}
</Child>
<button id="reassign" on:click={reassign}>r</button>
<button id="mutate" on:click={mutate}>m</button>
<button id="rename" on:click={rename}>n</button>
<button id="renameIn" on:click={renameIn}>ni</button>`

const text = (c, sel) => [...c.querySelectorAll(sel)].map(n => n.textContent.trim()).join(',')
const click = (c, sel) => { c.querySelector(sel).click(); $rt.flushSync() }

const setup = async (extra = '', watch = false) => {
  const Shell  = await build(SHELL, 'Shell.mesa')
  let src = PARENT.replace('<button id="reassign"', extra + '<button id="reassign"')
  if (watch) src = src.replace("const reassign", "$: (counts, user)\n  const reassign")
  const Parent = await build(src, 'Parent.mesa', Shell)
  return mount(Parent)
}

describe('a snippet the parent passes, reading the PARENT\'s state', () => {
  it('first render', async () => {
    const c = await setup()
    expect(text(c, '.badge')).toBe('1,0')
    expect(text(c, '.foot .who')).toBe('ada')
  })
  it('reassigned object reaches badge', async () => {
    const c = await setup(); click(c, '#reassign')
    expect(text(c, '.badge')).toBe('5,2')
  })
  it('CONTROL: in-place mutation reaches the parent\'s own template (RULE 43, watched)', async () => {
    const c = await setup('<i class="own">{counts.a}</i><i class="ownname">{user.name}</i>', true)
    click(c, '#mutate'); click(c, '#renameIn')
    expect(text(c, '.own') + '|' + text(c, '.ownname')).toBe('9|linus')
  })
  it('UNWATCHED in-place mutation does not reach badge (RULE 43)', async () => {
    const c = await setup(); click(c, '#mutate')
    expect(text(c, '.badge')).toBe('1,0')
  })
  it('watched in-place mutation reaches the drawer copy too', async () => {
    const c = await setup('', true); click(c, '.toggle'); click(c, '#mutate'); click(c, '#renameIn')
    expect([text(c, '.badge'), text(c, '.dbadge'), text(c, '.dfoot .who')].join('|')).toBe('9,0|9,0|linus')
  })
  it('watched in-place mutation reaches badge', async () => {
    const c = await setup('', true); click(c, '#mutate')
    expect(text(c, '.badge')).toBe('9,0')
  })
  it('reassigned user reaches foot', async () => {
    const c = await setup(); click(c, '#rename')
    expect(text(c, '.foot .who')).toBe('grace')
  })
  it('watched in-place user mutation reaches foot', async () => {
    const c = await setup('', true); click(c, '#renameIn')
    expect(text(c, '.foot .who')).toBe('linus')
  })
  it('drawer mounted after a change shows current state', async () => {
    const c = await setup(); click(c, '#reassign'); click(c, '#rename'); click(c, '.toggle')
    expect(text(c, '.dbadge') + '|' + text(c, '.dfoot .who')).toBe('5,2|grace')
  })
  it('both copies follow a change while the drawer is open', async () => {
    const c = await setup(); click(c, '.toggle'); click(c, '#reassign'); click(c, '#rename')
    expect([text(c, '.badge'), text(c, '.dbadge'), text(c, '.foot .who'), text(c, '.dfoot .who')].join('|')).toBe('5,2|5,2|grace|grace')
  })
  it('close, change, reopen', async () => {
    const c = await setup(); click(c, '.toggle'); click(c, '.toggle'); click(c, '#reassign'); click(c, '.toggle')
    expect(text(c, '.dbadge') + '|' + text(c, '.badge')).toBe('5,2|5,2')
  })
  const imported = async (watch) => {
    const Shell = await build(SHELL, 'Shell.mesa')
    const store = { user: { name: 'ada' }, counts: { a: 1, b: 0 } }
    const Parent = await build(`<script>
  import Child from './Shell.mesa'
  import { store } from './store.js'
  let groups = [{ id: 'a', label: 'Inbox' }, { id: 'b', label: 'Jobs' }]
  $: ${watch}
</script>
<i class="own">{store.counts.a}</i>
<Child {groups}>
  {#snippet badge(e)}{store.counts[e.id]}{/snippet}
  {#snippet foot()}<span class="who">{store.user?.name}</span>{/snippet}
</Child>`, 'Parent.mesa', Shell, store)
    return { c: mount(Parent), store }
  }
  const W = (o) => $rt.watchProxy(o)
  const tick = (fn) => { fn(); $rt.flushSync() }

  it('IMPORTED, replacement: reaches badge, foot and the drawer copy', async () => {
    const { c, store } = await imported('(store.user, store.counts)')
    expect(text(c, '.badge') + '|' + text(c, '.foot .who')).toBe('1,0|ada')
    tick(() => W(store).counts = { a: 5, b: 2 })
    expect(text(c, '.own') + '|' + text(c, '.badge')).toBe('5|5,2')
    tick(() => W(store).user = { name: 'grace' })
    expect(text(c, '.foot .who')).toBe('grace')
    tick(() => W(store).user = null)
    expect(text(c, '.foot .who'), 'signed out').toBe('')
    tick(() => c.querySelector('.toggle').click())
    tick(() => W(store).counts = { a: 3, b: 4 })
    expect(text(c, '.badge') + '|' + text(c, '.dbadge')).toBe('3,4|3,4')
  })
  it('IMPORTED, in-place under a shallow watch: CONTROL, own template', async () => {
    const { c, store } = await imported('(store.user, store.counts)')
    tick(() => W(store).counts.a = 7)
    expect(text(c, '.own')).toBe('7')
  })
  it('IMPORTED, in-place under a shallow watch: badge', async () => {
    const { c, store } = await imported('(store.user, store.counts)')
    tick(() => W(store).counts.a = 7)
    expect(text(c, '.badge')).toBe('7,0')
  })
  it('IMPORTED, in-place under a whole-object watch ($: store): own + badge', async () => {
    const { c, store } = await imported('store')
    tick(() => W(store).counts.a = 7)
    expect(text(c, '.own') + '|' + text(c, '.badge')).toBe('7|7,0')
  })
})
