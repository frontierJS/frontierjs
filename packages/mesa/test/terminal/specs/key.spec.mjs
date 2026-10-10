/*
 * key — `fixtures/Keyed.mesa`: `{#key}` rebuilds its contents on a new key.
 *
 * `Draft` keeps a count of its own, so a count back at 0 is a fresh
 * instance and a count kept is the same one. A green run pins the DOM
 * path's rule: a different key (`===`) rebuilds, and a key that re-reads
 * to an equal value does not, its contents taking the change as a prop. The orion flow
 * inspector keys `<NodeInspector>` on the node for exactly this reset.
 */
export const name = 'key'

export async function run(t) {
  await t.mount(await t.compile('Keyed'), {}, { width: 40, height: 10 })
  await t.settle()
  t.expectFrame(await t.frame(), ['item 1n: 0'], 'built for the first key')

  await t.click('bump item 1n')
  t.expectFrame(await t.frame(), ['item 1n: 1'], 'its own state counts')

  // The key reads `note` too, so this re-runs it and it answers '1' again.
  await t.click('touch')
  t.expectFrame(await t.frame(), ['item 1nx: 1'], 'an equal key keeps the instance, and its prop updates in place')

  await t.click('next')
  const frame = await t.frame()
  t.expectFrame(frame, ['item 2nx: 0'], 'a new key builds a fresh instance')
  t.ok(!frame.includes('item 1'), 'and the old one is gone')
}
