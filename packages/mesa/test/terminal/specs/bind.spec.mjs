/*
 * bind — `fixtures/Bound.mesa` binds two `fixtures/Stepper.mesa` children:
 * `bind:value={n}` with `bind:this={ref}`, and the shorthand `bind:value`.
 *
 * A green run pins both halves of a two-way prop: the parent's value reaches
 * the child at mount and on a parent write, and a write the CHILD makes to
 * its own prop comes back to the parent. The shorthand binds the parent's
 * variable of the prop's name. `bind:this` hands over the child's exported
 * interface rather than its anchor — `ref.reset()` is an `export function`
 * and `ref.value = 3` writes the child's prop signal — and either write
 * travels back up through the same binding.
 */
export const name = 'bind'

export async function run(t) {
  const Bound = await t.compile('Bound')
  await t.mount(Bound, {}, { height: 16 })

  let frame = await t.frame()
  t.expectFrame(frame, ['A: 5', 'B: 1', 'Parent: 5 1'], 'each child mounts with the parent\'s value')

  await t.tab()          // A+
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['A: 6', 'Parent: 6 1'], 'a child\'s own write comes back to the parent')

  await t.tab()          // B+
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['B: 2', 'Parent: 6 2'], 'the shorthand binds the variable of the prop\'s name')

  await t.tab()          // Ten
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['A: 10', 'Parent: 10 2'], 'a parent write reaches the child')

  await t.tab()          // Reset
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['A: 0', 'Parent: 0 2'], 'bind:this calls the child\'s exported function, and its write comes back')

  await t.tab()          // Three
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['A: 3', 'Parent: 3 2'], 'bind:this writes the child\'s prop through its interface')
}
