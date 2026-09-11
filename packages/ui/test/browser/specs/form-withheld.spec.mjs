/*
 * form-withheld.spec.mjs — a column the caller was not allowed to read.
 *
 * A field `@allow('read', …)` is enforced by stripping the KEY, so the value a
 * form holds for it is `undefined` whether the column is empty or forbidden.
 * The two are one answer to every reader that looks at the value, which is why
 * the flag exists and why nothing could use it until there was a reader.
 *
 * EVERY row is a PAIR, and the pair is the whole test. The admin's own row is
 * the control on the affordance side; the row that is genuinely EMPTY is the
 * sharper one, because *withheld* and *null* are exactly the two states a fix
 * that keyed off the value would merge — and merging them is the bug in the
 * other direction: an admin looking at a customer with no note must get an
 * ordinary editable box, not a lecture about permissions.
 *
 * The second half is the write, and it is the reason this is not cosmetic. A
 * read policy is not a write policy: measured against `example`'s
 * `Customer.notes`, a caller who cannot read the column CAN overwrite it. So an
 * empty box that saves destroys a note nobody on this screen has seen.
 */
export const name = 'Form — a column that was withheld'
export const covers = ['forms/Form', 'forms/Field']

// `?.disabled` on a missing element is `undefined`, so *not disabled* and *not
// rendered* would be one answer. Every probe here returns a STRING and `absent`
// is one of its values.
const isDisabled = (sel) =>
  `(document.querySelector(${JSON.stringify(sel)})` +
  ` ? String(!!document.querySelector(${JSON.stringify(sel)}).disabled) : 'absent')`

// What a sighted person actually reads. The badge and the sentence are asserted
// separately: a locked box with nothing said beside it is the same screen as an
// empty one, which is the defect.
const groupText = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  const g = el ? (el.closest('.field-group') ?? el.parentElement) : null;
  return g ? (g.textContent ?? '') : 'absent';
`

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus(); el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

const submit = (sel) => `
  document.querySelector(${JSON.stringify(sel)} + ' form').requestSubmit();
  return true;
`

export async function run(t) {
  await t.mount('form-withheld')

  /* ── the affordance ───────────────────────────────────────────────────── */

  t.is(await t.evaluate('return ' + isDisabled('#staff [name=notes]')), 'true',
    'a column the server withheld is not an editable box')

  // The pair on the permission side.
  t.is(await t.evaluate('return ' + isDisabled('#admin [name=notes]')), 'false',
    'the same column is editable for somebody who may read it')

  // The pair that decides the mechanism: this row HAS the key and its value is
  // null. A reader that keyed off the value rather than key PRESENCE marks this
  // one withheld too, and tells an admin they lack a permission they have.
  t.is(await t.evaluate('return ' + isDisabled('#empty [name=notes]')), 'false',
    'and a column that is genuinely empty is an ordinary box, not a withheld one')

  // The column beside it is the control for *the whole form locked*.
  t.is(await t.evaluate('return ' + isDisabled('#staff [name=name]')), 'false',
    'the ordinary column beside it is untouched')

  /* ── and the screen SAYS so ───────────────────────────────────────────── */

  const staffText = await t.evaluate(groupText('#staff [name=notes]'))
  t.ok(/hidden/i.test(staffText),
    'the field is badged Hidden, which is what separates it from empty')
  t.ok(/permission to view/i.test(staffText),
    'and says why, since a locked empty box and an empty one look identical')

  const emptyText = await t.evaluate(groupText('#empty [name=notes]'))
  t.ok(!/hidden/i.test(emptyText) && !/permission to view/i.test(emptyText),
    'and says none of it about a column that is merely empty')

  /* ── the payload, which is why this is not cosmetic ───────────────────── */

  // The form holds no value for the column, so anything it sent would be an
  // absence written over a note nobody here has seen — and the boundary would
  // take it, since a read policy is not a write policy.
  await typeInto(t, '#staff [name=name]', 'Cy Edited')
  await t.evaluate(submit('#staff'))
  await t.eventually(`window.kitSent().length`, 1, 'the withheld form saves')

  t.ok(!await t.evaluate(`return window.kitSent()[0].keys.includes('notes');`),
    'and the withheld column is not in what it sent')
  t.ok(await t.evaluate(`return window.kitSent()[0].keys.includes('name');`),
    'while the column beside it is')
  t.is(await t.evaluate(`return window.kitSent()[0].data.name;`), 'Cy Edited',
    'carrying what was typed')

  // The pair. An admin sends the column like any other — a strip that dropped
  // it everywhere would pass every assertion above.
  await typeInto(t, '#admin [name=notes]', 'Prefers post.')
  await t.evaluate(submit('#admin'))
  await t.eventually(`window.kitSent().length`, 2, 'the admin form saves too')

  t.ok(await t.evaluate(`return window.kitSent()[1].keys.includes('notes');`),
    'and a caller who may read it still sends the column')
  t.is(await t.evaluate(`return window.kitSent()[1].data.notes;`), 'Prefers post.',
    'with the edit in it')

  /* ── a create withholds nothing ───────────────────────────────────────── */
  //
  // No record is a row being made: there is no stored value to keep back, so a
  // create form that read the flag off an absent row would lock a column
  // nobody could then fill in.
  t.is(await t.evaluate('return ' + isDisabled('#create [name=notes]')), 'false',
    'a create form withholds nothing, because there is nothing stored yet')

  /* ── a form that re-enables it on purpose ─────────────────────────────── */
  //
  // A stated `disabled` beats the lock — that is the seal's documented contract
  // and this inherits it. What it cannot do is put the value back in the
  // payload: the form still does not know what is stored, so what was typed
  // here would overwrite it unseen just the same. This is also the only
  // arrangement in which the strip is reachable at all, since a key the read
  // never carried is absent from the payload whether or not anything drops it.

  t.is(await t.evaluate('return ' + isDisabled('#forced [name=notes]')), 'false',
    'a stated disabled={false} still wins, because the lock is an affordance')

  await typeInto(t, '#forced [name=notes]', 'typed over something unseen')
  await typeInto(t, '#forced [name=name]',  'Cy Forced')
  await t.evaluate(submit('#forced'))
  await t.eventually(`window.kitSent().length`, 3, 'the forced form saves')

  t.ok(!await t.evaluate(`return window.kitSent()[2].keys.includes('notes');`),
    'and the withheld column is STILL dropped on the way out')
  t.is(await t.evaluate(`return window.kitSent()[2].data.name;`), 'Cy Forced',
    'while the column beside it carries what was typed')
}

