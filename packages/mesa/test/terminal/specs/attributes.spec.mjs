/*
 * attributes — `fixtures/Attrs.mesa`: a live attribute on the terminal, the
 * `$$tui.set_attribute` owner reached from a render effect.
 *
 * A green run pins three things the static frame cannot: a program write to
 * an input's `value` repaints it and fires no `input` handler (the engine
 * emits one, a browser does not); a `disabled` that turns on takes the
 * button out of the Tab order; and a `class` with a hole compiles and paints
 * nothing. The Tab count in the last step is what tells a skipped button from
 * a focused-but-inert one: with Hit still in the order, the Enter lands on
 * Hit and `Locked` stays true.
 */
export const name = 'attributes'

export async function run(t) {
  const Attrs = await t.compile('Attrs')
  await t.mount(Attrs)

  let frame = await t.frame()
  t.expectFrame(frame, ['ada', 'Shout', 'Hit', 'Lock', 'Locked: false', 'Log:'], 'initial frame: the live value painted')

  await t.tab()          // input
  await t.tab()          // Shout
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['ADA', 'Locked: false'], 'a program write repaints the input')
  t.ok(!frame.includes('in:'), 'and fires no input handler')

  await t.tab()          // Hit
  await t.enter()
  await t.tab()          // Lock
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Locked: true', 'Log: hit'], 'Hit fired while enabled, then Lock disabled it')

  await t.tab()          // input
  await t.tab()          // Shout
  await t.tab()          // Lock, past the disabled Hit
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Locked: false', 'Log: hit'], 'the disabled button left the Tab order')

  await t.tab()          // input
  await t.type('x')
  frame = await t.frame()
  t.expectFrame(frame, ['ADAx', 'Log: hit,in:ADAx'], 'typing still reaches the handler')
}
