/*
 * destroy — a mount handle's teardown takes its own render with it (FJS-890).
 *
 * `mount()` names a teardown, and for the whole life of the runtime it removed
 * its anchor comment, released the delegation root and released the styles,
 * and left every node it had rendered standing. That is invisible to anything
 * that destroys and then clears the container — which is what both browser
 * harnesses in this repo do, and why no test here could see it. The caller it
 * cost was Sierra's widget runtime: a host page REPARENTING an element fires
 * disconnectedCallback then connectedCallback, so the remount appended beside
 * the corpse and every move duplicated the widget (FJS-817).
 *
 * Two things this spec asserts that a happy-dom test cannot make load-bearing:
 * the range is walked at destroy time, so an {#if} branch and an {#each} row
 * that only materialize at a flush AFTER mount() returned are inside it; and a
 * remount into the same stage leaves ONE of everything, which is the shape the
 * widget bug actually took.
 *
 * `t.destroy()` and not `t.mount()` of the next fixture: mesaUnmount clears the
 * stage itself, so through it every teardown looks perfect.
 */
export const name = 'destroy() removes what it rendered (FJS-890)'
export const covers = ['mount', 'destroy']

const count = (sel) => `return document.querySelectorAll(${JSON.stringify(sel)}).length;`

export async function run(t) {
  await t.mount('destroy', { rows: ['a', 'b', 'c'] })

  t.is(await t.evaluate(count('#stage #plain')), 1, 'the fixture rendered')
  t.is(await t.evaluate(count('#stage #late')), 1,
    'an {#if} branch that opened in $.onMount is on the page — it materialized after mount() returned')
  t.is(await t.evaluate(count('#stage .row')), 3, 'and the {#each} rows with it')
  t.is(await t.evaluate(count('#stage .child')), 1, 'and the child component')

  await t.evaluate("window.dispatchEvent(new Event('mesa-ping')); return true;")
  t.is(await t.evaluate('return window.__pings ?? 0;'), 1,
    'the <mesa:window> handler is live while the component is mounted')

  await t.destroy()

  t.is(await t.evaluate(count('#stage #plain')), 0, 'destroy() removed the static markup')
  t.is(await t.evaluate(count('#stage #late')), 0,
    'and the branch that arrived at a later flush — the range is walked at destroy, not recorded at mount')
  t.is(await t.evaluate(count('#stage .row')), 0, 'and every {#each} row')
  t.is(await t.evaluate(count('#stage .child')), 0, 'and the child component')
  t.is(await t.evaluate(`return [...document.getElementById('stage').childNodes]
      .filter((n) => n.nodeType !== 8).length;`), 0,
    'nothing but comment nodes is left standing in the stage')

  // The half no DOM assertion can reach. `destroy()` removed the render for a
  // year while the component's own owner node stayed parented to nothing —
  // unreachable, so its cleanups never ran and its listeners never came off.
  t.is(await t.evaluate('return window.__destroyed ?? 0;'), 1,
    '$.onDestroy ran — the mount owns a root, so its cleanups are reachable from the handle')
  await t.evaluate("window.dispatchEvent(new Event('mesa-ping')); return true;")
  t.is(await t.evaluate('return window.__pings ?? 0;'), 1,
    'and the <mesa:window> listener went with it — one per mount is what a teardown that disposes nothing leaks')

  // The shape the widget bug took: destroy, then mount the same component into
  // the same container again. A teardown that left the render behind reads as
  // TWO of everything here, both live.
  await t.evaluate(`
    const mod = await import('/mesa/test/browser/runtime/fixtures/destroy.mesa')
    const stage = document.getElementById('stage')
    const label = document.createComment('remount')
    stage.appendChild(label)
    const { mount } = await import('@frontierjs/mesa/runtime.js')
    window.__remount = mount(label, mod.default, { props: { rows: ['a', 'b'] }, root: stage })
    await new Promise((r) => setTimeout(r, 0))
    return true;
  `)
  t.is(await t.evaluate(count('#stage #plain')), 1, 'a remount after destroy leaves one copy, not two')
  t.is(await t.evaluate(count('#stage .row')), 2, 'and one list, at the new props')

  await t.evaluate('window.__remount.destroy(); delete window.__remount; return true;')
  t.is(await t.evaluate(count('#stage #plain')), 0, 'and that one tears down too')

  t.is((await t.warnings()).length, 0, 'no warning anywhere in the cycle')
}
