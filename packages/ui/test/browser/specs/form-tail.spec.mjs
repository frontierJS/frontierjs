/*
 * form-tail.spec.mjs — the controls a <Form> could not reach.
 *
 * `test/form.mjs` renders a form server-side and asserts the wiring; what it
 * cannot see is a control that resolves nothing, because a control which never
 * reads `$context.form` renders perfectly well — with the title-cased column
 * name where the schema's `@label` should be, no `required`, and no server
 * error. Every one of those looks correct in isolation and is wrong in a form.
 *
 * `FJS-077` is two defects in one row. Six controls read no rule at all, and
 * five more passed `label={label || name}` to `<Field>` — always truthy when a
 * name is given, so the raw column name arrived as an EXPLICIT label and shut
 * the schema out. Both are asked here the same way: every field in the fixture
 * declares a `title` that is not its title-cased name, so a control that
 * shadows the schema is a different string on screen rather than a coincidence.
 *
 * The second half drives a rejected submit. A control's own error line is the
 * thing no render test can produce, because it takes a request, a throw, and a
 * form that mapped it.
 */
export const name = 'form tail — the schema-deaf controls'
// FormField is NOT here: this fixture writes its children by hand, so the
// dispatcher never runs. `datetime.spec.mjs` covers it, through a generated
// form — which is the only path that reaches it.
export const covers = [
  'forms/Form', 'forms/Field', 'forms/Input', 'forms/Textarea',
  'forms/Select', 'forms/Checkbox', 'forms/Switch', 'forms/RadioGroup',
  'forms/Slider', 'forms/NumberInput', 'forms/Combobox', 'forms/MultiSelect',
]

// The label a control resolved, read off the `.field-group` that holds it.
// Scoped through the control's own element so a form with ten fields cannot
// answer with the wrong one. `(Optional)` is Label's own badge for a field
// that is not required and is asserted separately below.
const labelFor = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  const group = el && el.closest('.field-group');
  const text = group?.querySelector('label')?.textContent;
  return text == null ? null : text.replace(/\\(Optional\\)/, '').replace(/\\s+/g, ' ').trim();
`

export async function run(t) {
  await t.mount('form-tail')

  /* ── the schema's own label reaches every control ─────────────────────── */

  // Each of these declares `title` in the fixture, and every one of them is a
  // different string from what `nameToLabel(name)` would produce. A control
  // that shadowed the schema answers the title-cased column instead.
  const LABELS = [
    ['input[name=headline]',        'Public headline',    'Input'],
    ['textarea[name=summary]',      'Short summary',      'Textarea'],
    ['select[name=plan]',           'Billing cycle',      'Select'],
    ['input[name=seats]',           'Seat count',         'NumberInput'],
    ['[role=slider]',               'Relative weight',    'Slider'],
    ['[role=radiogroup]',           'Account owner',      'RadioGroup'],
    ['input[name=regions]',         'Served regions',     'Combobox'],
    ['.fjs-multiselect-box',        'Delivery channels',  'MultiSelect'],
  ]
  for (const [sel, expected, who] of LABELS) {
    t.is(await t.evaluate(labelFor(sel)), expected, `${who} takes its label from @label`)
  }

  // Checkbox and Switch wrap their own text rather than using a `.field-group`,
  // so they are asked directly.
  t.is(await t.evaluate(`
    return document.querySelector('input[name=live]')?.closest('label')?.textContent.trim();
  `), 'Is live', 'Checkbox takes its label from @label')
  t.is(await t.evaluate(`
    return document.querySelector('input[name=notify]')?.closest('label')?.textContent.trim();
  `), 'Send notices', 'Switch takes its label from @label')

  /* ── a bound control the APP turns off ────────────────────────────────── */

  // The direction a click cannot test. `checked` reaches the DOM through
  // `set_attribute`, and `el.checked` stops reflecting its attribute the moment
  // anything writes the property — so removing the attribute leaves the switch
  // ON, the parent reading `false`, and nothing saying the two disagree.
  // `<Switch bind:checked>` was one-way for as long as it existed: on
  // `example`'s /settings/ the JSON tree moved the switch once and never again.
  await t.clickAt('#notify-on')
  await t.eventually(`document.querySelector('input[name=notify]').checked`, true,
    'the app can switch a bound Switch on')
  await t.clickAt('#notify-off')
  await t.eventually(`document.querySelector('input[name=notify]').checked`, false,
    'and off again — the property is reset, not just the attribute')

  /* ── required, which is the same schema fact ──────────────────────────── */

  // A native `required` where the element is the value…
  const REQUIRED = [
    ['input[name=headline]',  'Input'],
    ['textarea[name=summary]', 'Textarea'],
    ['select[name=plan]',      'Select'],
    ['input[name=seats]',      'NumberInput'],
    ['input[name=notify]',     'Switch'],
    ['input[name=regions]',    'Combobox'],
  ]
  for (const [sel, who] of REQUIRED) {
    t.ok(await t.evaluate(`return document.querySelector('${sel}')?.required === true;`),
      `${who} takes required from the schema`)
  }

  // …and `aria-required` where it is not. A group is not a labelable control
  // and a MultiSelect's inner box is a search field whose resting state is
  // empty, so a native `required` there refuses every submit.
  t.is(await t.evaluate(`
    return document.querySelector('[role=radiogroup]')?.getAttribute('aria-required');
  `), 'true', 'RadioGroup announces required without claiming to be the value')
  t.is(await t.evaluate(`
    return document.querySelector('.fjs-multiselect-box input')?.getAttribute('aria-required');
  `), 'true', 'MultiSelect announces required on its combobox, not on its search box')

  // This kit marks the OPTIONAL one rather than starring the required ones,
  // and that badge comes off the same resolution — so a control that resolved
  // no rule labels every field "(Optional)", including the ones the model
  // insists on. Asked both ways round, because only one of the two directions
  // catches that.
  const optional = await t.evaluate(`
    const badge = (sel) => {
      const g = document.querySelector(sel)?.closest('.field-group');
      return !!g && g.querySelector('label')?.textContent.includes('(Optional)');
    };
    return { weight: badge('[role=slider]'), headline: badge('input[name=headline]'),
             seats: badge('input[name=seats]'), owner: badge('[role=radiogroup]') };
  `)
  t.is(optional.weight, true, 'the one field the schema does not require is badged Optional')
  t.is(optional.headline, false, 'and a required one is not')
  t.is(optional.seats, false, 'NumberInput included')
  t.is(optional.owner, false, 'RadioGroup included — it badged every field before')

  /* ── the keyboard cursor names the row it is on (`FJS-323`) ───────────── */

  // Focus never leaves the text box in either of these, so a highlight moving
  // down the list is invisible to a screen reader on its own: there is no
  // focus event to follow and `aria-selected` says which option is CHOSEN, not
  // which one Enter would take. The input has to point at the row by id. Asked
  // through `document.getElementById` on purpose — an `aria-activedescendant`
  // naming an element that does not exist reads exactly like one that works.
  const cursorOf = (inputSel) => `
    const input = document.querySelector(${JSON.stringify(inputSel)});
    const listId = input.getAttribute('aria-controls');
    const list = listId && document.getElementById(listId);
    const named = input.getAttribute('aria-activedescendant');
    const row = named && document.getElementById(named);
    const highlighted = list && list.querySelector('[data-active]');
    return {
      list:     !!list && list.getAttribute('role'),
      named:    !!named,
      resolves: !!row && !!list && list.contains(row),
      isOption: row && row.getAttribute('role'),
      agrees:   !!row && row === highlighted,
      text:     row && row.textContent.trim(),
    };
  `

  await t.clickAt('input[name=regions]')
  await t.eventually(`!!document.querySelector('.fjs-combobox-panel')`, 'true',
    'the Combobox panel opens on focus')

  let cursor = await t.evaluate(cursorOf('input[name=regions]'))
  t.is(cursor.list, 'listbox', 'Combobox points aria-controls at its own listbox')
  t.ok(cursor.resolves, 'and aria-activedescendant names a row that exists inside it')
  t.is(cursor.isOption, 'option', 'which is an option')
  t.ok(cursor.agrees, 'and is the row the highlight is on')

  // The named row is read after the move has landed: Mesa flushes on a
  // microtask, so the attribute behind a keypress arrives after the round trip
  // that caused it.
  const firstRegion = cursor.text
  const namedRow = (inputSel) => `
    document.getElementById(
      document.querySelector(${JSON.stringify(inputSel)}).getAttribute('aria-activedescendant')
    )?.textContent.trim()`
  await t.press('ArrowDown')
  await t.eventually(`${namedRow('input[name=regions]')} !== ${JSON.stringify(firstRegion)}`, 'true',
    'ArrowDown renames the row before it is read')
  cursor = await t.evaluate(cursorOf('input[name=regions]'))
  t.ok(cursor.resolves && cursor.agrees, 'ArrowDown moves both together')
  t.ok(cursor.text && cursor.text !== firstRegion,
    `and the named row is the next one (${firstRegion} → ${cursor.text})`)

  await t.press('Escape')
  t.is(await t.evaluate(`
    return document.querySelector('input[name=regions]').getAttribute('aria-activedescendant');
  `), null, 'a closed list names no row — the id would dangle')

  // MultiSelect is the same control with a multi-value box around it, and its
  // search input is the thing focus lives in. The combobox's panel is animated
  // out and is absolutely positioned over the field BELOW it, so clicking the
  // MultiSelect before it has gone lands the press on a panel on its way out.
  await t.eventually(`document.querySelectorAll('.fjs-combobox-panel').length`, '0',
    'and the Combobox panel is gone')
  await t.clickAt('.fjs-multiselect-box')
  await t.eventually(`!!document.querySelector('.fjs-multiselect-panel')`, 'true',
    'the MultiSelect panel opens')

  cursor = await t.evaluate(cursorOf('.fjs-multiselect-box input'))
  t.is(cursor.list, 'listbox', 'MultiSelect points aria-controls at its own listbox')
  t.ok(cursor.resolves && cursor.isOption === 'option' && cursor.agrees,
    'and names the highlighted option by an id that resolves')

  const firstChannel = cursor.text
  await t.press('ArrowDown')
  await t.eventually(`${namedRow('.fjs-multiselect-box input')} !== ${JSON.stringify(firstChannel)}`, 'true',
    'ArrowDown renames the row here too')
  cursor = await t.evaluate(cursorOf('.fjs-multiselect-box input'))
  t.ok(cursor.text && cursor.text !== firstChannel,
    `ArrowDown moves the named row (${firstChannel} → ${cursor.text})`)

  // Taking the named row is the other half: until the options themselves were
  // invisible nothing here could ever be chosen, so a MultiSelect that renders
  // rows and cannot turn one into a pill would look identical.
  await t.press('Enter')
  await t.eventually(
    `[...document.querySelectorAll('.fjs-multiselect-box .pill')].map(p => p.textContent.trim()).join(',')`,
    cursor.text, 'Enter turns the named row into a pill')

  await t.press('Escape')

  /* ── constraints that are not required ────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('textarea[name=summary]').maxLength;`), 40,
    'Textarea takes maxlength from @length rather than needing it restated')

  // The bounds feed the ± buttons as well as the input, so a schema bound the
  // component could not see was a stepper that stepped straight past it.
  const seats = await t.evaluate(`
    const el = document.querySelector('input[name=seats]');
    return { min: el.min, max: el.max };
  `)
  t.is(seats.min, '2', 'NumberInput takes its minimum from the schema')
  t.is(seats.max, '9', 'and its maximum')

  await t.evaluate(`
    const dec = [...document.querySelectorAll('button')].find(b => b.closest('.fjs-number'));
    return true;
  `)
  // Step down from the seeded 2 — the schema's minimum — and it must hold.
  await t.evaluate(`
    const el = document.querySelector('input[name=seats]');
    const dec = el.parentElement.querySelector('button');
    click(dec); click(dec);
    return true;
  `)
  await t.eventually(`document.querySelector('input[name=seats]').value`, '2',
    'and the stepper stops at the schema minimum rather than walking past it')

  /* ── a server error reaches each of them ──────────────────────────────── */

  // Every field named at once: a control that shows its neighbor's message,
  // or none, is what the per-control resolution is for.
  await t.evaluate(`
    window.kitFailWith({
      headline: 'Headline is taken',
      summary:  'Summary is too vague',
      seats:    'Not enough seats',
      live:     'Cannot go live yet',
      notify:   'Notices are off for this plan',
      owner:    'Owner has left',
      regions:  'Unserved region',
      channels: 'No channel selected',
    });
    click(document.querySelector('#save'));
    return true;
  `)
  await t.eventually(`document.querySelector('#errorKeys').textContent`,
    'channels,headline,live,notify,owner,regions,seats,summary',
    'the rejection maps onto every field by name')

  const shown = await t.evaluate(`
    const text = (sel) => {
      const el = document.querySelector(sel);
      const group = el && el.closest('.field-group, .stack');
      return [...(group?.querySelectorAll('.field-hint.danger') ?? [])].map(p => p.textContent.trim()).join('|');
    };
    return {
      headline: text('input[name=headline]'),
      summary:  text('textarea[name=summary]'),
      live:     text('input[name=live]'),
      notify:   text('input[name=notify]'),
    };
  `)
  t.is(shown.headline, 'Headline is taken',           'Input shows its own server error')
  t.is(shown.summary,  'Summary is too vague',        'Textarea shows its own')
  t.is(shown.live,     'Cannot go live yet',          'Checkbox shows its own')
  t.is(shown.notify,   'Notices are off for this plan', 'Switch shows its own — it showed none at all before')

  // aria-invalid is the half a screen reader gets, and it was missing wherever
  // the message was.
  t.is(await t.evaluate(`
    return document.querySelector('input[name=notify]')?.getAttribute('aria-invalid');
  `), 'true', 'and marks itself invalid')
  t.is(await t.evaluate(`
    return document.querySelector('[role=radiogroup]')?.getAttribute('aria-invalid');
  `), 'true', 'RadioGroup marks the group invalid rather than an option')

  // A group that renders no Field renders no error either — this is the one
  // that was structurally impossible before, because the wrapper appeared only
  // when a `label` prop was passed and inside a <Form> nobody passes one.
  t.ok(await t.evaluate(`
    return !!byText('.field-group .field-hint.danger', 'Owner has left');
  `), 'RadioGroup renders a server error at all, which needed the Field wrapper')

  /* ── a clean submit still goes through ────────────────────────────────── */

  await t.evaluate(`window.kitFailWith({}); click(document.querySelector('#save')); return true;`)
  await t.eventually(`document.querySelector('#done').textContent`, '1',
    'and clearing the failure lets the same form submit')
  await t.eventually(`document.querySelector('#errorKeys').textContent`, '',
    'with every field error cleared')

  /* ── an unselected option SAYS it is unselected ───────────────────────── */

  // `aria-selected={false}` used to remove the attribute outright, so an option
  // that was not chosen announced itself as *not selectable* rather than as
  // selectable-and-not-selected — and a combobox that was CLOSED had no
  // `aria-expanded` at all, which announces it as not expandable. Both were
  // silent and both looked correct. Fixed in mesa's `set_attribute`, which
  // writes "false" for the four ARIA states whose default is `undefined`; this
  // is what holds it here, in a component that actually uses them.
  const ariaState = await t.evaluate(`
    const box = document.querySelector('input[name=regions]');
    const closed = box.getAttribute('aria-expanded');
    box.focus(); box.click();
    await new Promise(r => setTimeout(r, 120));
    const opts = [...document.querySelectorAll('.fjs-combobox-panel [role=option]')];
    return {
      closed,
      open: box.getAttribute('aria-expanded'),
      unselected: opts.length ? opts[opts.length - 1].getAttribute('aria-selected') : null,
    };
  `)
  t.is(ariaState.closed, 'false', 'a closed combobox says it is closed, not that it cannot open')
  t.is(ariaState.open, 'true', 'and open when it is')
  t.is(ariaState.unselected, 'false', 'an option that is not chosen says so rather than vanishing the attribute')
  // Last in the file on purpose. This has to OPEN the control to read its open
  // state, and a spec that leaves an overlay open — or closes one the next
  // block expected to find open — makes the next assertion fail for a reason
  // that has nothing to do with it.
  await t.press('Escape')
}
