/*
 * image — `fixtures/Image.mesa`: `<img>` and `<mark>`.
 *
 * A green run pins an image painted as its `alt`, as a browser shows one it
 * cannot load: a static alt is the text, an empty one takes no row, a live
 * one follows its value and takes no row while empty, and `on:error` is
 * heard but never sent, since nothing fails to load. An image with no alt
 * inside `aria-hidden` is left out, and one outside it is refused at compile
 * by name. An `<svg>` is the same rule over `aria-label`, what a screen
 * reader reads it by, and its drawing is never built, so a tag the table
 * lacks inside one is not refused. `<mark>` is its text in inverse video, a
 * terminal's highlight.
 */
import { compile } from '../../../src/compiler.js'
import { TextAttributes } from '@opentui/core'

export const name = 'image'

export async function run(t) {
  const Image = await t.compile('Image')
  await t.mount(Image, {}, { height: 20 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['top', 'the logo', 'before', 'after', 'ada', 'next', 'a chart', 'mid', 'trend ada', 'low', 'a hit here'], 'alt text paints, and an empty alt and an aria-hidden image take no row')
  t.ok(/next\s*\n\s*a chart\s*\n\s*mid/.test(frame), 'an svg is one row of its aria-label, its drawing unbuilt')
  t.ok(/low\s*\n\s*a hit here/.test(frame), 'an svg inside aria-hidden takes no row')
  t.ok(/before\s*\n\s*after/.test(frame), 'an empty alt leaves no blank row')
  t.ok(!frame.includes('failed'), 'on:error is never sent')
  t.is((await t.attributesAt('hit')) & TextAttributes.INVERSE, TextAttributes.INVERSE, '<mark> is inverse')
  t.is((await t.attributesAt('here')) & TextAttributes.INVERSE, 0, 'and only the marked text')

  await t.click('swap')
  frame = await t.frame()
  t.ok(/after\s*\n\s*next/.test(frame), 'a live alt emptied takes its row away')
  t.ok(/mid\s*\n\s*low/.test(frame), 'and a live aria-label removed takes the svg\'s')

  await t.click('swap')
  frame = await t.frame()
  t.expectFrame(frame, ['after', 'bo', 'next', 'mid', 'trend bo', 'low'], 'and gives it back when it has text again')

  let refused = null
  try { await compile('<img src="a.png" />', { name: 'NoAlt', target: 'terminal', filename: 'NoAlt.mesa' }) }
  catch (e) { refused = e.message }
  t.ok(refused?.includes('<img> without alt'), `an image with no alt is refused by name (${refused})`)

  refused = null
  try { await compile('<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>', { name: 'NoLabel', target: 'terminal', filename: 'NoLabel.mesa' }) }
  catch (e) { refused = e.message }
  t.ok(refused?.includes('<svg> without aria-label'), `an svg with no aria-label is refused by name (${refused})`)
}
