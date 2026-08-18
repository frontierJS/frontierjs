/*
 * form-generate.spec.mjs — <Form> building its own field list.
 *
 * `form-tail.spec.mjs` covers the other half: ten controls handed to a form,
 * each asked whether it resolves the schema. This one hands <Form> nothing and
 * asks what it BUILDS — the set, the order, the control each type implies, and
 * the two kinds of field that produce none.
 *
 * That path is the one an app is meant to reach for first and the one with the
 * fewest assertions on it, because putting it on a screen in `example/` means
 * committing to a schema; here it costs a rules object.
 */
export const name = 'Form — generated fields'
export const covers = ['forms/Form']

// One line, deliberately: this is interpolated after a `return`, and a newline
// there is a semicolon — the expression becomes unreachable and every
// assertion built on it reads `undefined`.
const controlsIn = (sel) =>
  `[...document.querySelectorAll(${JSON.stringify(sel)} + ' [name]')].map(el => el.getAttribute('name')).join(',')`

export async function run(t) {
  await t.mount('form-generate')

  /* ── the set, and its order ───────────────────────────────────────────── */

  // Schema order, not alphabetical and not the order the controls happen to
  // mount in. A form is read top to bottom and the schema is the only thing
  // that knows which order the columns mean anything in.
  t.is(await t.evaluate(`return ${controlsIn('#all')};`),
    'title,notes,status,qty,customerId,dueOn,archived',
    'every writable field appears, in schema order')

  // readOnly is the schema saying this is not the caller's to write, so the
  // form leaving it out IS the annotation working — silently, unlike a column
  // it simply has no control for.
  t.is(await t.evaluate(`return document.querySelector('#all [name=createdAt]');`), null,
    'a readOnly column is not offered')
  t.is(await t.evaluate(`return document.querySelector('#all [name=tags]');`), null,
    'and neither is one the kit has no control for')

  // The difference between the two is the whole point. A readOnly column is
  // the schema working; a column with no control is a field silently missing
  // from a form, which is the exact failure generating the list is meant to
  // end — so it is warned about, by model, name and reason.
  const warned = await t.evaluate(`return window.kitWarnings.filter(w => w.startsWith('[Form]'));`)
  t.ok(warned.some(w => w.includes('Order.tags') && w.includes('array')),
    'a column with no control is warned about by name and reason')
  t.ok(warned.every(w => !w.includes('createdAt')),
    'and a readOnly column is not — leaving it out is the annotation working')

  /* ── the control each type implies ────────────────────────────────────── */

  const kinds = await t.evaluate(`
    const of = (name) => {
      const el = document.querySelector('#all [name=' + name + ']');
      if (!el) return 'missing';
      return el.tagName === 'INPUT' ? 'input:' + el.type : el.tagName.toLowerCase();
    };
    return {
      title: of('title'), notes: of('notes'), status: of('status'),
      qty: of('qty'), dueOn: of('dueOn'), archived: of('archived'),
    };
  `)
  t.is(kinds.title, 'input:text', 'a string is a text input')
  t.is(kinds.notes, 'textarea', 'a markdown string is a textarea')
  t.is(kinds.status, 'select', 'an enum is a select')
  t.is(kinds.qty, 'input:number', 'an integer is a number input')
  t.is(kinds.dueOn, 'input:date', 'a date is a date input — it has no zone to lose')
  t.is(kinds.archived, 'input:checkbox', 'a boolean is a checkbox')

  // The schema's own constraints reach the DOM, which is what makes the
  // browser's validation agree with the server's.
  const constraints = await t.evaluate(`
    const el = (n) => document.querySelector('#all [name=' + n + ']');
    return {
      titleMax: el('title').getAttribute('maxlength'),
      titleReq: el('title').required,
      qtyMin:   el('qty').getAttribute('min'),
      qtyStep:  el('qty').getAttribute('step'),
      notesReq: el('notes').required,
    };
  `)
  t.is(constraints.titleMax, '60', 'maxLength reaches the control')
  t.is(constraints.titleReq, true, 'and so does required')
  t.is(constraints.qtyMin, '1', 'minimum reaches a number input')
  t.is(constraints.qtyStep, '1', 'an integer steps by one, a float by any')
  t.is(constraints.notesReq, false, 'an optional column is not made required')

  // @label reaches the browser as `title` — a generated form that title-cased
  // the column name instead would look completely correct.
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#all label')].some(l => l.textContent.includes('Order title'));
  `), 'the schema label is used, not the column name')

  /* ── the picker fetches its rows ──────────────────────────────────────── */

  // Rows are fetched for a FOREIGN KEY, not for a control named `picker` — the
  // relation is the schema fact, the control is a choice made over it.
  await t.eventually(`document.querySelector('#options-calls').textContent.split(',')[0]`, 'customerId',
    'a foreign key asks the resource for its rows')
  // `eventually`, not a plain read: the call being recorded is not the rows
  // having arrived, and the select repopulates a turn later.
  await t.eventually(`document.querySelectorAll('#all [name=customerId] option').length`, '3',
    'and the select repopulates when they arrive (two rows plus the empty)')
  t.ok(await t.evaluate(`
    return [...document.querySelectorAll('#all [name=customerId] option')]
      .some(o => o.textContent.trim() === 'Ada Lovelace');
  `), 'showing the human column rather than the id')
  // Only the foreign key. Asking for rows per field would be one request per
  // column on every form in the app.
  t.is(await t.evaluate(`
    return new Set(document.querySelector('#options-calls').textContent.split(',')).size;
  `), 1, 'and nothing else is asked for rows')

  /* ── only / except / auto ─────────────────────────────────────────────── */

  t.is(await t.evaluate(`return ${controlsIn('#narrowed')};`), 'status,title',
    'only narrows AND orders — naming fields is naming their order')
  t.is(await t.evaluate(`return ${controlsIn('#removed')};`), 'title,status,qty,dueOn,archived',
    'except removes and leaves the rest in schema order')

  // Children turn generation off; `auto` forces it back on and the generated
  // fields lead.
  t.is(await t.evaluate(`return ${controlsIn('#forced')};`), 'title,hand',
    'auto generates alongside children, generated first')
  // Two protocols reach a component and this kit uses both: every other
  // container takes a snippet prop, and the apps in this repo write
  // slot="actions" over a form. A caller who picks the wrong one gets no
  // buttons and no complaint, so both are pinned here.
  t.ok(await t.evaluate(`
    return document.querySelector('#forced .cluster #forced-save') !== null;
  `), 'an actions SNIPPET renders in its own cluster')
  t.ok(await t.evaluate(`
    return document.querySelector('#slotted .cluster #slotted-save') !== null;
  `), 'and so does a slot="actions" child')

  /* ── the form element itself ──────────────────────────────────────────── */

  // novalidate by default: the kit puts a real `required` on its controls, so
  // without this the browser silently refuses to fire submit and the form's
  // own messages never run (FJS-055).
  t.is(await t.evaluate(`return document.querySelector('#all form').noValidate;`), true,
    'a Form is novalidate, so its own messages are what the user sees')

  // A generated form is still a form: submitting it runs the handler rather
  // than reloading the page.
  await t.evaluate(`
    document.querySelector('#forced [name=title]').value = 'Something';
    document.querySelector('#forced [name=title]').dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.clickAt('#forced-save')
  await t.eventually(`document.querySelector('#saved').textContent`, '1',
    'and a submit button inside it submits')
}
