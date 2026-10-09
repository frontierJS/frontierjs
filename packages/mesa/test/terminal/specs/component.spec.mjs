/*
 * component — `fixtures/Panel.mesa` mounts `fixtures/Card.mesa` three times:
 * with a reactive prop, a callback prop, default and named slot content; with
 * nothing, so both slots fall back; and inside an `{#if}`.
 *
 * A green run pins the call across a file boundary: the child's nodes land
 * where its tag sits (before the marker, not appended after `end`), a prop
 * pushed from the parent repaints the child, the child calling a callback
 * writes the parent's signals, and a component torn down by its block leaves
 * the frame and comes back without the engine refusing a node twice.
 */
export const name = 'component'

export async function run(t) {
  const Panel = await t.compile('Panel')
  await t.mount(Panel, {}, { height: 24 })

  let frame = await t.frame()
  t.expectFrame(frame, [
    'Alpha (0)', 'body 0', 'act', 'Pick',
    'Beta (0)', 'empty card', 'Pick',
    'picked: none', 'Toggle',
    'Gamma (0)', 'empty card', 'Pick',
    'end',
  ], 'each card where its tag sits, slots filled or fallen back')
  t.ok(frame.indexOf('empty card') > frame.indexOf('Beta'), 'Alpha passed a default slot, so its fallback is not painted')

  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Alpha (1)', 'body 1', 'Beta (0)', 'picked: alpha 0', 'Gamma (1)'],
    'a callback prop writes the parent; the pushed prop repaints two children')

  await t.tab()
  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.ok(!frame.includes('Gamma'), 'the {#if} took its component out')
  t.expectFrame(frame, ['Toggle', 'end'], 'and left the rest in place')

  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Toggle', 'Gamma (1)', 'empty card', 'Pick', 'end'], 'and put it back, current')
}
