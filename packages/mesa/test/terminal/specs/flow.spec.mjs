/*
 * flow — `fixtures/Flow.mesa`: text and inline tags laid out as a browser's
 * line boxes lay them out.
 *
 * A green run pins prose with markup in it painted as one line that wraps
 * between words, at 40 columns: a key, a code span and a bold word inside a
 * sentence stay in the sentence, each with its own cell attributes, and a
 * button stays on the line beside its words. A link, and a tag something
 * listens to, are words of the run too: a press on their cells reaches them,
 * on every row they wrap across, Tab stops at them and the focus cue inverts
 * their cells, and one that joins a run while focused keeps its focus with
 * no blur heard (`FlowFocus.mesa`). The white space
 * between two inline siblings is one space, inside a run (`K J`) and between
 * two buttons, and a space ending one piece swallows the one starting the
 * next (`opens it`). A line's edges hold none, and a no-break space is
 * not white space, so it stays. A run follows a live text inside it and a block that
 * opens inside it, and a field beside its label keeps a browser's width.
 * A button's label is a line of its own, so its edge spaces collapse into
 * its brackets.
 */
import { TextAttributes } from '@opentui/core'

export const name = 'flow'

const row = (frame, text) => frame.split('\n').find((l) => l.includes(text))?.trimEnd()

export async function run(t) {
  const handle = await t.mount(await t.compile('Flow'), {}, { height: 36 })

  let frame = await t.frame()
  t.is(row(frame, 'Press'), 'Press Enter on [ Add ] to go.', 'a key and a button flow in the sentence')
  t.is(row(frame, 'Every'), 'Every cell came out of db/schema.lite,', 'a code span flows in the sentence')
  t.is(row(frame, 'so the'), 'so the status filters by membership and', 'and the sentence wraps between words')
  t.is(row(frame, 'Read'), 'Read the docs first.', 'a link sits in its line')
  t.is(row(frame, 'An inline'), 'An inline span whose words are wider', 'an inline tag wider than the screen wraps')
  t.is(row(frame, 'than the'), 'than the screen it sits in.', 'rather than painting over itself')
  t.is(row(frame, 'Name'), 'Name Ada', 'a field sits beside its label')
  t.is(row(frame, 'Toggle'), '[ Toggle ] [ Count 0 ]', 'the space between two buttons is painted')
  t.is(row(frame, 'Ctrl'), 'Ctrl K J opens it', 'white space between and across tags is one space')
  t.is(row(frame, 'Code').indexOf('end'), 'Code '.length + 6 + 1, 'a field is as wide as its size')
  t.is(row(frame, '[ Go ]'), '[ Go ]', 'a button after a sentence wider than the row starts the next')
  t.is(row(frame, '[ B ]'), '[ B ] [ C ]', 'a space left first in its row is not painted')
  const rows = frame.split('\n').map((l) => l.trimEnd())
  t.ok(rows.includes('edges trimmed'), 'a line holds no white space at its edges')
  t.ok(rows.includes('\u00a0\u00a0kept in'), 'and a no-break space is not white space')
  t.ok(rows.includes('wrapped across 3 lines'), 'a newline in the source is a space, a branch down too')
  t.ok(rows.includes('[ x ] label [ Spaced ]'), "an inline tag's edge is inside its parent's line, and a button's is inside its brackets")
  t.is(rows[rows.indexOf('[ One ]') + 1], '[ Two ]', 'a space between two buttons under a block paints no row')

  const { BOLD, INVERSE, UNDERLINE } = TextAttributes
  t.is((await t.attributesAt('Enter')) & BOLD, BOLD, '<kbd> is bold inside the run')
  t.is((await t.attributesAt('status')) & BOLD, BOLD, '<strong> is bold inside the run')
  t.is((await t.attributesAt('db/schema')) & BOLD, 0, 'and the code span beside it is not')

  await t.tab()
  await t.tab()
  t.is((await t.attributesAt('the docs')) & INVERSE, INVERSE, 'Tab stops at the link inside a sentence')

  await t.tab()
  await t.type('m')
  t.is(row(await t.frame(), 'Hello'), 'Hello Adam!', 'the run follows a live text inside it')

  await t.click('Toggle')
  frame = await t.frame()
  t.is(row(frame, 'Hello'), 'Hello Adam, welcome back!', 'a block opening inside the run joins it')
  t.is((await t.attributesAt('welcome back')) & INVERSE, INVERSE, 'with its own attributes')
  t.is(row(frame, 'solo'), 'solo pair', 'a lone inline tag joins the block opening beside it')
  t.is(row(frame, '[ B ]'), 'on [ B ] [ C ]', 'and a space between it and a button is painted')

  await t.click('Toggle')
  frame = await t.frame()
  t.is(row(frame, 'Hello'), 'Hello Adam!', 'and leaves it when it closes')
  t.is(row(frame, 'solo'), 'solo', 'and the tag left alone is painted again')

  const followed = []
  t.tui.followLinks(handle.renderer, (href) => followed.push(href))
  t.is(row(frame, 'You can'), 'You can open any order on the orders', 'a link wraps between words inside its sentence')
  t.is(row(frame, 'list —'), 'list — the totals across all of them.', 'and the words after it start no row with a space')
  t.is((await t.attributesAt('list —')) & UNDERLINE, UNDERLINE, 'a link keeps its underline in the run')
  t.is((await t.attributesAt('the totals')) & UNDERLINE, 0, 'and the words beside it do not take it')
  await t.click('the totals')
  await t.click('You can')
  t.is(followed.length, 0, 'a press on the words beside a link follows nothing')
  await t.click('list —')
  t.is(followed.join(' '), '/orders/', "a press on a link's cells follows it, on its second row too")
  t.is((await t.attributesAt('the orders')) & INVERSE, INVERSE, 'and focuses it, every row of it inverted')
  t.is((await t.attributesAt('list —')) & INVERSE, INVERSE, 'down to the row it wrapped onto')
  await t.enter()
  t.is(followed.length, 2, 'Enter follows the focused link inside a run')
  await t.tab()
  t.is((await t.attributesAt('list —')) & INVERSE, 0, 'Tab leaves it, and the cue goes with it')
  await t.enter()
  t.is(row(await t.frame(), 'Or tap'), 'Or tap here for taps 1.', 'Tab stops at a heard tag inside a run, and Enter clicks it')
  await t.click('here')
  t.is(row(await t.frame(), 'Or tap'), 'Or tap here for taps 2.', 'a press on its cells clicks it')
  await t.click('for taps')
  t.is(row(await t.frame(), 'Or tap'), 'Or tap here for taps 2.', 'and a press beside them does not')

  await t.mount(await t.compile('FlowFocus'), {}, { height: 4 })
  await t.tab()
  frame = await t.frame()
  t.is(row(frame, 'See'), 'See this', 'a focused link joins a run that opens beside it')
  t.is((await t.attributesAt('this')) & INVERSE, INVERSE, 'and keeps the focus it took')
  t.is(row(frame, 'heard'), 'heard focus', 'hearing one focus and no blur')
}
