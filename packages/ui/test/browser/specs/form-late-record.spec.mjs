/*
 * form-late-record.spec.mjs — a row handed to <Form> after mount is graded.
 *
 * The async-detail shape: the form mounts on `undefined` and the stored row
 * arrives a moment later. The seal, the withheld columns and the `reset()`
 * baseline were all taken at setup, off the blank, so the late row was never
 * graded and a reset dropped its id — the next `auto` submit was a create
 * (`FJS-2588`).
 *
 * `#early` is the pair: the same row handed in at mount. A fix that froze
 * the column on both looks identical from the late side to one that froze it
 * on neither until the early form is read too.
 */
export const name = 'Form — a record that arrives after mount'
export const covers = ['forms/Form']

const disabled = (sel) => `!!document.querySelector(${JSON.stringify(sel)})?.disabled`

export async function run(t) {
  await t.mount('form-late-record')

  t.is(await t.evaluate(`return ${disabled('#early [name=code]')};`), true,
    'a row handed in at mount freezes its @immutable column')
  t.is(await t.evaluate(`return ${disabled('#early [name=notes]')};`), true,
    'and locks the column its read withheld')

  t.is(await t.evaluate(`return ${disabled('#late [name=code]')};`), false,
    'before the row arrives the late form is a blank, and nothing is frozen')

  await t.evaluate(`window.kitLoad(); return true;`)
  await t.eventually(`document.querySelector('#late [name=name]').value`, 'W1',
    'the late row reaches the form')

  await t.eventually(disabled('#late [name=code]'), true,
    'a row that arrives after mount freezes its @immutable column too')
  await t.eventually(disabled('#late [name=notes]'), true,
    'and locks the column its read withheld')
  t.is(await t.evaluate(`return ${disabled('#late [name=name]')};`), false,
    'and leaves an ordinary column editable')

  // Edit, then throw the edit away: the baseline is the row, not the blank.
  await t.evaluate(`
    const el = document.querySelector('#late [name=name]');
    el.focus();
    el.value = 'W2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.evaluate(`document.getElementById('late-reset').click(); return true;`)
  await t.eventually(`document.querySelector('#late [name=name]').value`, 'W1',
    'reset() returns to the row that arrived, not to the blank seeded at mount')

  await t.evaluate(`
    const el = document.querySelector('#late [name=name]');
    el.focus();
    el.value = 'W2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#late form').requestSubmit();
    return true;
  `)
  await t.eventually(`window.kitSent().length`, 1, 'the late form saves')
  const out = await t.evaluate(`return window.kitSent()[0];`)
  t.is(out.data.id, 'w-1', 'and the save after a reset still names the row, so it is a patch and not a second row')
  t.is('code' in out.data, false, 'and the frozen column is not sent')
  t.is('notes' in out.data, false, 'nor the withheld one')

  // A different row is a different row opened: graded off ITS read.
  await t.evaluate(`window.kitSelect(); return true;`)
  await t.eventually(`document.querySelector('#late [name=name]').value`, 'W3',
    'a second row replaces the first')
  await t.eventually(disabled('#late [name=notes]'), false,
    'and a column its read carried is an ordinary box again')
  t.is(await t.evaluate(`return ${disabled('#late [name=code]')};`), true,
    'while its @immutable column stays frozen')
  await t.evaluate(`document.getElementById('late-reset').click(); return true;`)
  await t.eventually(`document.querySelector('#late [name=notes]').value`, 'kept',
    'and reset() returns to the second row')
}
