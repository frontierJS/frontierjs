/*
 * form-unshown.spec.mjs — a refusal over a field the form does not draw.
 *
 * Found by `example`'s `verify:automations`: orion's flow drawer is
 * `only={['name', 'description']}`, the record carried `runsPerMinute: 0`, the
 * resource refused it, and the message went to a field with no box. The drawer
 * stayed open with nothing on it and nothing was written.
 *
 * A PAIR, same form and same refusal, only the named field changed. A form that
 * put every message at the top would pass the second half alone, and one that
 * never did would pass the first.
 */
export const name = 'Form — a refusal naming a field it does not draw'
export const covers = ['forms/Form']

// Expressions, not statements: t.eventually wraps what it is handed in parens.
const alertIn = (sel) =>
  `(document.querySelector(${JSON.stringify(sel)} + ' .alert')?.textContent ?? '').trim()`

async function submit(t, sel) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)} + ' [name=title]');
    el.value = 'Welcome';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector(${JSON.stringify(sel)} + ' form').requestSubmit();
    return true;
  `)
}

export async function run(t) {
  await t.mount('form-unshown')

  /* ── a field on screen keeps its message beside it ────────────────────── */

  await submit(t, '#shown')
  await t.eventually(
    `(document.querySelector('#shown [name=title]')?.closest('.field-group')?.textContent ?? '').includes('Title is taken')`, true, 'a refusal over a drawn field is under that field')
  t.is(await t.evaluate(`return ${alertIn('#shown')};`), '',
    'and is not repeated at the top')

  /* ── a field off screen is said at the top ────────────────────────────── */

  await submit(t, '#unshown')
  await t.eventually(alertIn('#unshown'), 'Limit must be at least 1',
    'a refusal over a field the form does not draw is the form-level message')

  /* ── a hand-written form: the DOM says what is drawn (FJS-2094) ───────── */

  await submit(t, '#handwritten-shown')
  await t.eventually(
    `(document.querySelector('#handwritten-shown [name=title]')?.closest('.field-group')?.textContent ?? '').includes('Title is taken')`, true,
    'a hand-written form keeps a drawn field\'s message beside it')
  t.is(await t.evaluate(`return ${alertIn('#handwritten-shown')};`), '',
    'and does not repeat it at the top')

  await submit(t, '#handwritten')
  await t.eventually(alertIn('#handwritten'), 'Limit must be at least 1',
    'a hand-written form says a refusal over an undrawn column at the top')

  await submit(t, '#auto-children')
  await t.eventually(alertIn('#auto-children'), 'Limit must be at least 1',
    'so does an auto form with children, whose generated list is not the whole screen')
}
