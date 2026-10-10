/*
 * links — `fixtures/Links.mesa`: an `<a href>` is a link.
 *
 * A green run pins what a browser does with one, on a terminal: Tab reaches
 * it and it inverts while focused; Enter and a press follow it, and Space
 * does not; following hands the `href`, as written, to what `followLinks`
 * registered for the renderer. A prevented `click` follows nothing, and
 * neither does a link with `download`. An `<a>` with no `href` is text that
 * Tab passes, and a live `href` removed makes its link text again. With no
 * follower an activated link goes nowhere and throws nothing. A link that
 * loses its `href` and has a `click` listener still hears a press.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'links'

export async function run(t) {
  const Links = await t.compile('Links')
  const handle = await t.mount(Links, {}, { height: 12 })
  const followed = []
  const off = t.tui.followLinks(handle.renderer, (href) => followed.push(href))
  await t.settle()

  await t.tab()
  const { INVERSE, UNDERLINE } = TextAttributes
  t.is((await t.attributesAt('Orders')) & (INVERSE | UNDERLINE), INVERSE | UNDERLINE, 'a focused link inverts, and keeps its underline')
  await t.press(' ')
  t.is(followed.length, 0, 'Space follows nothing')
  await t.enter()
  t.is(followed.join(' '), '/orders/', 'Enter follows the focused link, its href as written')
  await t.tab()
  t.is((await t.attributesAt('Orders')) & (INVERSE | UNDERLINE), UNDERLINE, 'a link blurred is no longer inverted')

  await t.click('Live')
  t.is(followed.at(-1), '/orders/7/', 'a press follows a live href')

  await t.click('Kept')
  t.expectFrame(await t.frame(), ['kept 1'], 'a click listener on a link hears the press')
  t.is(followed.length, 2, 'a prevented click follows nothing')

  await t.click('File')
  t.is(followed.length, 2, 'a link with download is not followed')

  // The press focused File; Plain has no href, so the button is next.
  await t.tab()
  await t.enter()
  t.expectFrame(await t.frame(), ['kept 1 live none'], 'Tab passes an <a> with no href')
  await t.click('Live')
  t.is(followed.length, 2, 'an href removed leaves text, which a press does not follow')
  await t.click('Heard')
  t.expectFrame(await t.frame(), ['heard 1'], 'and one with a click listener still hears a press')
  t.is(followed.length, 2, 'which follows nothing')

  off()
  await t.click('Orders')
  t.is(followed.length, 2, 'with no follower an activated link goes nowhere')
}
