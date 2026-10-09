/*
 * runtime — `$$tui` driven directly, with no compiler in the loop.
 *
 * The component below is written by hand in the shape the terminal emitter
 * produces, so a green run pins the runtime on its own: element/text and
 * set_text paint; a marker takes no row; an ifBlock flips, paints the new
 * branch in place and disposes the old one's effects; an eachBlock adds,
 * removes and REORDERS keyed rows, moving a row as one node; focusNext reaches
 * a button and Enter fires its 'click'. counter.spec covers the same ground
 * through the compiler, so when both fail this one says which half.
 */
export const name = 'runtime'

export async function run(t) {
  const { createSignal, flushSync } = t.runtime
  const $$tui = t.tui

  const [count, setCount]   = createSignal(0)
  const [items, setItems]   = createSignal(['a', 'b'])
  const [shown, setShown]   = createSignal(true)
  const [label, setLabel]   = createSignal('hello')
  const clicks = []
  let branchRuns = 0, branchDisposed = 0

  function Component(__anchor) {
    const $$parentElement = $$tui.fragment()
    const $$el0 = $$tui.element('div', { class: 'box' })
    $$tui.append($$parentElement, $$el0)
    const $$el1 = $$tui.element('h1')
    $$tui.append($$el0, $$el1)
    $$tui.append($$el1, $$tui.text('Title'))
    const $$el2 = $$tui.element('p')
    $$tui.append($$el0, $$el2)
    const $$t0 = $$tui.text('')
    $$tui.append($$el2, $$t0)
    t.runtime.render((__prev) => {
      const __a = `Label: ${label()}`
      if (__prev.a !== __a) $$tui.set_text($$t0, __prev.a = __a)
    }, { a: '' })
    const $$el3 = $$tui.element('button')
    $$tui.append($$el0, $$el3)
    $$tui.append($$el3, $$tui.text('Go'))
    $$tui.on($$el3, 'click', (e) => { clicks.push(e.type); setCount(count() + 1) })
    // A marker at the root level, before the fragment is attached: the block
    // must land in the array and ride into the parent with it.
    const $$m0 = $$tui.marker()
    $$tui.append($$el0, $$m0)
    $$tui.ifBlock($$m0, () => shown() ? 0 : 1, [
      () => {
        branchRuns++
        t.runtime.onCleanup(() => { branchDisposed++ })
        const $$b = $$tui.fragment()
        const $$el4 = $$tui.element('p')
        $$tui.append($$b, $$el4)
        const $$t1 = $$tui.text('')
        $$tui.append($$el4, $$t1)
        t.runtime.render((__prev) => {
          const __a = `Shown ${count()}`
          if (__prev.a !== __a) $$tui.set_text($$t1, __prev.a = __a)
        }, { a: '' })
        return $$b
      },
      () => {
        const $$b = $$tui.fragment()
        const $$el5 = $$tui.element('p')
        $$tui.append($$b, $$el5)
        $$tui.append($$el5, $$tui.text('Hidden'))
        return $$b
      },
    ])
    const $$el6 = $$tui.element('ul', { id: 'list' })
    $$tui.append($$el0, $$el6)
    const $$m1 = $$tui.marker()
    $$tui.append($$el6, $$m1)
    $$tui.eachBlock($$m1, () => items(), (it, i) => it, (it, i) => {
      const $$b = $$tui.fragment()
      const $$el7 = $$tui.element('li')
      $$tui.append($$b, $$el7)
      const $$t2 = $$tui.text('')
      $$tui.append($$el7, $$t2)
      t.runtime.render((__prev) => {
        const __a = `${i()}: ${it()}`
        if (__prev.a !== __a) $$tui.set_text($$t2, __prev.a = __a)
      }, { a: '' })
      return $$b
    }, () => {
      const $$b = $$tui.fragment()
      const $$el8 = $$tui.element('p')
      $$tui.append($$b, $$el8)
      $$tui.append($$el8, $$tui.text('(empty)'))
      return $$b
    })
    const $$m2 = $$tui.marker()
    $$tui.append($$el0, $$m2)
    const $$el9 = $$tui.element('p')
    $$tui.append($$el0, $$el9)
    $$tui.append($$el9, $$tui.text('End'))
    $$tui.append(__anchor, $$parentElement)
  }

  const handle = await t.mount(Component)
  const rowsOf = (frame) => frame.split('\n').filter((l) => l.trim() !== '')

  // ── element / text / set_text ───────────────────────────────────────
  let frame = await t.frame()
  t.expectFrame(frame, ['Title', 'Label: hello', '[ Go ]', 'Shown 0', '0: a', '1: b', 'End'], 'initial frame')
  t.is(rowsOf(frame).length, 7, 'the two markers take no row')
  t.is(rowsOf(frame)[6], 'End'.padEnd(t.WIDTH), 'the row after a marker is the next element, not a blank')

  setLabel('changed')
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['Label: changed'], 'set_text repaints a bound text')

  // ── focusNext + click via Enter ─────────────────────────────────────
  await t.tab()
  t.is(handle.renderer.currentFocusedRenderable?.__attrs !== undefined, true, 'Tab focused a runtime-built node')
  await t.enter()
  t.is(clicks.length, 1, 'Enter on the focused button fired click once')
  t.is(clicks[0], 'click', 'the handler saw a click-typed event')
  frame = await t.frame()
  t.expectFrame(frame, ['Shown 1'], 'the click wrote a signal the branch reads')
  await t.press(' ')
  t.is(clicks.length, 2, 'Space fires it too')

  // ── ifBlock flips and disposes ──────────────────────────────────────
  t.is(branchRuns, 1, 'the first branch ran once')
  setShown(false)
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['[ Go ]', 'Hidden', '0: a'], 'the else branch paints in the marker position')
  t.ok(!frame.includes('Shown'), 'the first branch is gone from the frame')
  t.is(branchDisposed, 1, 'the first branch root was disposed')
  setShown(true)
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['Shown 2', '0: a'], 'flipping back rebuilds the branch with the live count')
  t.is(branchRuns, 2, 'the branch factory ran again rather than being reused')
  setShown(false); setShown(true)
  await t.settle()
  t.is(branchRuns, 2, 'a selector that settles on the same index does not rebuild')

  // ── eachBlock: add, remove, reorder keyed rows ──────────────────────
  const ul = handle.renderer.root.getChildren()[0].getChildren().find((n) => n.__attrs?.id === 'list')
  const liFor = (key) => ul.getChildren().find((n) => n.getChildren()[0]?.__t?.endsWith(`: ${key}`))
  const liA = liFor('a'), liB = liFor('b')
  t.ok(liA && liB && liA !== liB, 'rows are distinct renderables')

  setItems(['a', 'b', 'c'])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['0: a', '1: b', '2: c', 'End'], 'a new row paints after the existing ones')

  setItems(['c', 'b', 'a'])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['0: c', '1: b', '2: a', 'End'], 'a reorder repaints in the new order with new indexes')
  t.is(liFor('a'), liA, 'the moved row is the same renderable')
  t.is(ul.getChildrenCount(), 4, 'three rows and the marker — a moved row is one node, not two')

  setItems(['b'])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['Shown', '0: b', 'End'], 'removed rows leave the frame')
  t.ok(!/\d: a/.test(frame) && !/\d: c/.test(frame), 'no trace of the removed rows')
  t.is(liFor('b'), liB, 'the kept row survived untouched')

  setItems([])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['(empty)', 'End'], 'the else block shows for an empty list')
  setItems(['z'])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['0: z', 'End'], 'a row replaces the else block')
  t.ok(!frame.includes('(empty)'), 'the else block is gone')

  // ── teardown leaves the root empty ──────────────────────────────────
  handle.dispose()
  frame = await t.frame()
  t.is(frame.trim(), '', 'dispose removes everything the mount painted')

  // ── blocks at the component root ────────────────────────────────────
  // Their markers sit in the fragment, not in a parent, when the block first
  // runs: the content has to land in the array beside the marker and reach
  // the root with it, and a text under an h1 built there must still be bold.
  const { TextAttributes } = await import('@opentui/core')
  const [flag, setFlag] = createSignal(true)
  const [list, setList] = createSignal(['p', 'q'])
  let headingText = null
  function RootBlocks(__anchor) {
    const $$parentElement = $$tui.fragment()
    const $$m0 = $$tui.marker()
    $$tui.append($$parentElement, $$m0)
    $$tui.ifBlock($$m0, () => flag() ? 0 : null, [
      () => {
        const $$b = $$tui.fragment()
        const $$el0 = $$tui.element('h1')
        $$tui.append($$b, $$el0)
        headingText = $$tui.text('Flag on')
        $$tui.append($$el0, headingText)
        return $$b
      },
    ])
    const $$m1 = $$tui.marker()
    $$tui.append($$parentElement, $$m1)
    $$tui.eachBlock($$m1, () => list(), null, (it, i) => {
      const $$b = $$tui.fragment()
      const $$el1 = $$tui.element('li')
      $$tui.append($$b, $$el1)
      const $$t0 = $$tui.text('')
      $$tui.append($$el1, $$t0)
      t.runtime.render((__prev) => {
        const __a = `${i()}-${it()}`
        if (__prev.a !== __a) $$tui.set_text($$t0, __prev.a = __a)
      }, { a: '' })
      return $$b
    }, null)
    const $$el2 = $$tui.element('p')
    $$tui.append($$parentElement, $$el2)
    $$tui.append($$el2, $$tui.text('Tail'))
    $$tui.append(__anchor, $$parentElement)
  }
  const root = await t.mount(RootBlocks)
  frame = await t.frame()
  t.expectFrame(frame, ['Flag on', '0-p', '1-q', 'Tail'], 'root-level blocks paint in marker order')
  t.is(root.renderer.root.getChildrenCount(), 6, 'two markers, a heading, two rows, a tail — no duplicates from the fragment path')
  t.ok(headingText.attributes & TextAttributes.BOLD, 'the h1 built in a fragment branch still bolds its text')
  setFlag(false)
  setList(['q', 'p', 'r'])
  await t.settle()
  frame = await t.frame()
  t.expectFrame(frame, ['0-q', '1-p', '2-r', 'Tail'], 'an unkeyed list rebinds rows in place')
  t.ok(!frame.includes('Flag on'), 'a null selector index removes the branch')
  t.is(rowsOf(frame).length, 4, 'nothing else is on screen')
}
