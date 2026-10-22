/*
 * toned — `fixtures/Toned.mesa`: `@frontierjs/css`'s tones and box
 * composites as a terminal draws them (FJS-D1423).
 *
 * A green run pins: a card draws a rounded border and `raised` clears it, a
 * bare `surface` draws none; a tone inks a box's text and its border in the
 * tone's palette index, and the ink stops at a button, which takes its own
 * tone or none; a live tone change re-inks, a live `class:` tone too; muted
 * text is dim; and a text field underlines its whole width, past its text.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'toned'

const DANGER = 1, SUCCESS = 2, PRIMARY = 4

export async function run(t) {
  await t.mount(await t.compile('Toned'), {}, { height: 40 })
  await t.settle()

  const frame = await t.frame()
  const row = (text) => frame.split('\n').find((l) => l.includes(text)) ?? ''
  t.ok(frame.includes('╭'), 'a card draws a rounded border')
  t.ok(row('Plain card').includes('│ Plain card'), 'with a column of padding inside it')
  t.ok(!row('Lifted').includes('│'), 'raised clears it, as its transparent border does in a browser')
  t.ok(!row('Bare').includes('│'), 'a bare surface draws none')

  t.is(await t.inkAt('Plain card'), null, 'an untoned card keeps the default color')
  t.is((await t.attributesAt('quiet words')) & TextAttributes.DIM, TextAttributes.DIM, 'text-muted is dim')

  t.is(await t.inkAt('Alert body'), DANGER, 'a toned box inks its text')
  t.is(await t.inkAt('Alert body', -2), DANGER, 'and its border')
  t.is(await t.inkAt('Flip'), null, 'an untoned button inside it keeps its own color')
  t.is(await t.inkAt('Go'), PRIMARY, 'a toned button takes its tone')
  t.is(await t.inkAt('live'), DANGER, 'a class: tone inks')
  t.is(await t.inkAt(' word'), null, 'and only its own text')

  const under = (dx) => t.attributesAt('typed', dx).then((a) => a & TextAttributes.UNDERLINE)
  t.is(await under(0), TextAttributes.UNDERLINE, 'a field underlines its text')
  t.is(await under(10), TextAttributes.UNDERLINE, 'and the empty width past it')

  await t.click('Flip')
  await t.settle()
  t.is(await t.inkAt('Alert body'), SUCCESS, 'a live tone change re-inks the text')
  t.is(await t.inkAt('Alert body', -2), SUCCESS, 'and the border')
  t.is(await t.inkAt('live'), null, 'a class: tone turned off gives the default back')
}
