/*
 * style — `fixtures/Styled.mesa` against its twin `fixtures/Unstyled.mesa`,
 * the same markup with every `style:` and `class:` taken off. A terminal
 * paints no CSS, so both are inert, as a static `style` or `class` and the
 * scoped rules are: the two frames must be the same characters, before and
 * after a click moves the live ones.
 *
 * A green run pins what the slice decided rather than what it built — a
 * `style:display` of `none` still shows its content here, where a browser
 * hides it, and so does a live `class:hidden`. Mapping any property onto the engine (`gap`, `flex-direction`,
 * `padding`, hiding on `display`/`visibility`) changes a frame and fails it.
 */
export const name = 'style'

async function frames(t, fixture) {
  await t.mount(await t.compile(fixture))
  const before = await t.frame()
  await t.tab()          // Flip
  await t.enter()
  return [before, await t.frame()]
}

export async function run(t) {
  const [styled, styledAfter] = await frames(t, 'Styled')
  const [plain, plainAfter] = await frames(t, 'Unstyled')

  t.expectFrame(styled, ['Shown', 'Flip', 'hidden: true'], 'display: none still paints its content')
  t.expectFrame(styledAfter, ['Shown', 'Flip', 'hidden: false'], 'the click ran under the live style:')
  t.is(styled, plain, 'the initial frame is the unstyled frame')
  t.is(styledAfter, plainAfter, 'and so is the frame after the live values moved')
}
