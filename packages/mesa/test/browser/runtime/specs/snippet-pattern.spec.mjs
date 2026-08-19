/*
 * A snippet parameter that is a destructuring pattern.
 *
 * It compiled and could not work: the argument is passed lazily, so
 * `{#snippet row([name, q])}` emitted `(__anchor, [name, q])` and destructured
 * the accessor FUNCTION — `TypeError: function is not iterable`, thrown from
 * the compiled file with no mention of the snippet, and the whole enclosing
 * block rendered nothing (`FJS-339`).
 *
 * `{#each}` answers the same question by unwrapping the item and destructuring
 * that, and it does NOT transfer: a block re-runs per item and a snippet's DOM
 * is built once, so an unwrap-then-destructure would read each name exactly
 * once and freeze it — the frozen-argument bug the getters exist to prevent
 * (VISION §9.5). So the destructuring moves into the read, and each bound name
 * keeps its own subscription. The reassignments below are what tells the two
 * fixes apart; the first render passes under either.
 */
export const name = '{#snippet} — a destructuring parameter (FJS-339)'
export const covers = ['snippet-pattern']

export async function run(t) {
  await t.mount('snippet-pattern')

  const pair = `document.querySelector('#out .pair')?.textContent.trim()`
  const card = `document.querySelector('#out .card')?.textContent.trim()`

  t.is(await t.evaluate(`return ${pair};`), 'ada = 1',
    'an array pattern binds each position')
  t.is(await t.evaluate(`return ${card};`), 'x1 · first',
    'and an object pattern binds each property, renaming included')

  // A page error fails the spec through the drive's own channel, which is what
  // catches the regression directly: destructuring the accessor throws
  // `function is not iterable` before either assertion above can read a node.

  await t.clickAt('#swap-pair')
  await t.eventually(pair, 'grace = 2',
    'a reassignment reaches both names — the reads are lazy, not unwrapped once')

  await t.clickAt('#swap-record')
  await t.eventually(card, 'x2 · second',
    'and the same holds for a renamed property')

  t.is(await t.evaluate(`return document.querySelector('#out .card').getAttribute('data-id');`), 'x2',
    'an ATTRIBUTE bound to a destructured name updates too — the same one test '
    + 'decides both, and it reads the accessor by name')

  // The shape this was found in: the argument is an {#each} item's accessor,
  // not a component signal. basecamp's Hub had been rendering nothing here.
  const rows = `[...document.querySelectorAll('#rows .pair')].map(e => e.textContent.trim()).join(' | ')`
  t.is(await t.evaluate(`return ${rows};`), 'queued = 3 | running = 1',
    'a snippet rendered once per {#each} item destructures each item')

  await t.clickAt('#swap-rows')
  await t.eventually(rows, 'queued = 9 | running = 4',
    'and reassigning the list reaches the names inside the pattern')
}
