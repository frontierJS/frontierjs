/*
 * datetime.spec.mjs — DateTimeInput, and the schema path that reaches it.
 *
 * `FJS-079`: a `DateTime` column had no control. `Input` refuses to map
 * `format: date-time` to `datetime-local` on purpose — Litestone stores an
 * INSTANT and that element reads and writes a wall clock with no zone, so
 * handing one to the other shifts the value going in (the offset is truncated
 * and the wall clock read as local) and again coming out (a zoneless string
 * the server parses as UTC). The two shifts are in opposite directions and of
 * different sizes, which is why the fix is a control rather than an attribute.
 *
 * Everything below is asked in a REAL browser because the whole defect lives
 * in the browser's zone. On a machine at UTC the broken and the correct answer
 * are the same string, so the run prints the offset it measured and the one
 * assertion that needs a non-zero one says so when it cannot be made.
 *
 * The last third asserts the wiring rather than the component: an app writes
 * no control name anywhere, so `format: date-time` → `datetime` (Sierra's
 * table) → `DateTimeInput` (the kit's dispatcher) has to hold end to end or a
 * generated form renders a text box that looks perfectly fine.
 */
export const name = 'DateTimeInput'
export const covers = ['forms/DateTimeInput', 'forms/FormField']

const ISO = '2026-03-04T09:30:00.000Z'

// The wall clock that instant IS, in this browser's zone — written out with
// plain Date getters rather than through the component's own helper, so the
// two are independent statements of the same rule.
const EXPECTED_LOCAL = `
  const d = new Date(${JSON.stringify(ISO)});
  const p = (n) => String(n).padStart(2, '0');
  return \`\${d.getFullYear()}-\${p(d.getMonth() + 1)}-\${p(d.getDate())}T\${p(d.getHours())}:\${p(d.getMinutes())}\`;
`

export async function run(t) {
  await t.mount('datetime', { iso: ISO })

  const offset = await t.evaluate(`return new Date(${JSON.stringify(ISO)}).getTimezoneOffset();`)

  /* ── an instant reaches the element as a wall clock ───────────────────── */

  const expected = await t.evaluate(EXPECTED_LOCAL)
  t.is(await t.evaluate(`return document.querySelector('input[name=startsAt]').value;`),
    expected, 'an ISO instant is shown as the wall clock it is in this zone')

  // The bug it replaces, stated as a measurement: the naive path hands the
  // element `iso.slice(0, 16)`, which is the UTC wall clock wearing no zone.
  if (offset !== 0) {
    t.ok(await t.evaluate(`
      return document.querySelector('input[name=startsAt]').value !== ${JSON.stringify(ISO.slice(0, 16))};
    `), `and is not the truncated UTC string (offset ${offset})`)
  } else {
    // Saying so out loud rather than passing quietly: a green run at UTC has
    // not asked this question.
    t.ok(true, 'browser is at UTC — the shift assertion cannot be made here')
  }

  t.match(await t.evaluate(`
    return document.querySelector('.fjs-dt-zone')?.textContent.trim();
  `), /\S/, 'the zone being shown is named beside the value')

  /* ── and comes back as an instant ─────────────────────────────────────── */

  // A wall clock typed by a reader means that time HERE. What must reach the
  // column is the instant it names, with an offset on it.
  const back = await t.evaluate(`
    const el = document.querySelector('input[name=startsAt]');
    el.value = '2026-07-01T14:45';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    return { emitted: document.querySelector('#seen').textContent,
             bound:   document.querySelector('#value').textContent };
  `)
  t.is(back.emitted, back.bound, 'onvalue and the bound value agree')
  t.match(back.emitted, /Z$/, 'what leaves the control is an ISO instant, not a wall clock')

  t.is(await t.evaluate(`
    // The instant it named, computed from the same wall clock read as LOCAL —
    // which is what new Date('…T14:45') does, where a date ALONE is UTC.
    return new Date('2026-07-01T14:45').getTime() ===
           new Date(document.querySelector('#value').textContent).getTime();
  `), true, 'and it is the instant that wall clock names here, to the millisecond')

  // Round-tripping it back through the control must land on the same wall
  // clock. This is the assertion that fails for every naive implementation:
  // one that shifts by the offset on the way out and not on the way in reads
  // back an hour or seven adrift.
  await t.eventually(`document.querySelector('input[name=startsAt]').value`, '2026-07-01T14:45',
    'and re-rendering that instant shows the wall clock it was typed as')

  /* ── an incomplete entry is not a value ───────────────────────────────── */

  const cleared = await t.evaluate(`
    const el = document.querySelector('input[name=startsAt]');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    return document.querySelector('#value').textContent;
  `)
  t.is(cleared, '', 'clearing the box sends nothing rather than an invented instant')

  /* ── the schema path, with no control named anywhere ──────────────────── */

  // One generated form, three columns. What is asserted is the CONTROL each
  // one got: a `String` is a text box, a `Date` is `type="date"` because it
  // has no zone to lose, and only a `DateTime` gets this component.
  const generated = await t.evaluate(`
    const form = document.querySelectorAll('form')[0];
    const byName = (n) => form.querySelector('[name=' + n + ']');
    return {
      reference:    byName('reference')?.type,
      scheduledFor: byName('scheduledFor')?.type,
      dueOn:        byName('dueOn')?.type,
    };
  `)
  t.is(generated.reference, 'text', 'a String column is still a text box')
  t.is(generated.dueOn, 'date', 'a Date column is still a date input — it has no zone to lose')
  t.is(generated.scheduledFor, 'datetime-local',
    'and a DateTime column gets this control, with nothing in the app naming it')

  // The generated one shows the same instant, which is the whole chain: the
  // resource seeded a record with an ISO string, the dispatcher passed it
  // through as a value, and the control converted it.
  t.is(await t.evaluate(`
    return document.querySelector('form [name=scheduledFor]').value;
  `), expected, 'and the value the resource seeded arrives converted, not truncated')

  // The schema facts every other control in this folder resolves.
  t.ok(await t.evaluate(`
    return document.querySelector('form [name=scheduledFor]').required === true;
  `), 'it takes required from the schema')
  t.is(await t.evaluate(`
    const el = document.querySelector('form [name=scheduledFor]');
    return el.closest('.field-group')?.querySelector('label')?.textContent.replace(/\\s+/g, ' ').trim();
  `), 'Scheduled for', 'and its label from @label')
}
