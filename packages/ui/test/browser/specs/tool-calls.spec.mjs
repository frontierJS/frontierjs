/*
 * tool-calls.spec.mjs -- an assistant turn's tool calls: one disclosure per
 * call, none folded away by count, a status mark whose word is read as well
 * as seen (`FJS-3621`, `FJS-D1658`).
 *
 * Whether a <details> opens on a real click and whether the status word is
 * clipped out of sight are properties of a real layout; a render test sees
 * neither.
 */
export const name = 'tool calls: a disclosure per call, a status word, nothing folded away'
export const covers = ['display/ToolCalls']

export async function run(t) {
  await t.mount('tool-calls')

  const rows = await t.evaluate(`
    return [...document.querySelectorAll('#calls .fjs-toolcall')].map((e) => ({
      tag: e.tagName,
      status: e.dataset.status,
      name: e.querySelector('.fjs-toolcall-name').textContent,
      word: e.querySelector('.visually-hidden').textContent,
      wordPx: Math.round(e.querySelector('.visually-hidden').getBoundingClientRect().width),
      open: e.open === true,
    }))
  `)
  t.is(rows.length, 4, 'every call is drawn -- the kit folds none away')
  t.is(rows.map((r) => r.name).join(','), 'search,refund,lookup,ping', 'in the order given')
  t.is(rows.map((r) => r.word).join(','), 'Done,Failed,Running,Done', 'each mark carries its status word')
  t.ok(rows.every((r) => r.wordPx <= 1), 'the status word is visually hidden')
  t.is(rows.map((r) => r.tag).join(','), 'DETAILS,DETAILS,DETAILS,DIV',
    'a call with something to show is a <details>; one with nothing is a plain row')
  t.ok(rows.every((r) => !r.open), 'all start closed')

  await t.clickAt('#calls .fjs-toolcall:nth-child(1) summary')
  await t.eventually(`document.querySelector('#calls .fjs-toolcall').open`, true, 'a click opens the call')
  const body = await t.evaluate(`return document.querySelector('#calls .fjs-toolcall').querySelector('.disclosure-body').textContent`)
  t.ok(/Input/.test(body) && /"q": "orders"/.test(body) && /Output/.test(body) && /3 rows/.test(body),
    'it shows the input (an object as indented JSON) and the output')
  t.is(await t.evaluate(`return document.querySelectorAll('#calls details[open]').length`), 1,
    'opening one leaves the others as they were')

  const running = await t.evaluate(`
    const e = document.querySelector('#calls .fjs-toolcall:nth-child(3)');
    e.open = true;
    return e.querySelector('.disclosure-body').textContent`)
  t.ok(/Input/.test(running) && !/Output/.test(running), 'a call with no output shows no Output label')
}
