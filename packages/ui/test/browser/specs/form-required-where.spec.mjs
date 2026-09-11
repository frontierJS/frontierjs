/*
 * form-required-where.spec.mjs — a control that becomes required as you type.
 *
 * `@required(where: status == 'shipped')` is required in the rows a predicate
 * admits. The answer is in the record, so it cannot be a schema keyword and it
 * cannot be resolved once at mount: the person may pick the status that makes
 * the column required, and the form has to move with them.
 *
 * This is the one assertion neither the toolbelt spec nor sierra's can make.
 * They grade the evaluator and the seam; only a browser can say the CONTROL
 * moved — and the failure this exists for is a form that resolves the rule at
 * mount and never again, which every unit test on either side passes.
 *
 * EVERY row is a PAIR, and the pairs are chosen so that the three ways to be
 * wrong are each separated:
 *
 *   • never required   — the shipped half is the control
 *   • always required  — the draft half is, and it is the one that matters:
 *     an affordance stricter than the boundary produces a control nobody can
 *     satisfy while the server would happily accept the write
 *   • required once, then stuck — asserted by going BACK to draft
 *
 * The create form is the fourth: no record is a row being made, and a form that
 * read the predicate off an absent row would demand a value for a state nobody
 * has chosen yet.
 */
export const name = 'Form — required as a condition'
export const covers = ['forms/Form']

// `?.required` on a missing element is `undefined`, so *not required* and *not
// rendered* are the same answer — which is how the first draft of this spec
// passed four assertions against a control that did not exist. Every probe here
// answers a STRING, and `absent` is one of its values.
// An EXPRESSION rather than a body, because `eventually` polls one and
// `evaluate` runs the other — one probe used by both is one definition of what
// is being asked.
const isRequired = (sel) =>
  `(document.querySelector(${JSON.stringify(sel)})` +
  ` ? String(!!document.querySelector(${JSON.stringify(sel)}).required) : 'absent')`

// What a sighted person actually reads. The kit marks the NEGATIVE — a column
// that is not required carries an "(Optional)" badge and a required one carries
// nothing — so the visible change is that badge going away, and asserting it
// beside the attribute is what separates *the control knows* from *the screen
// says*.
const optionalBadge = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  const group = el ? (el.closest('.field-group') ?? el.parentElement) : null;
  return group ? String(/optional/i.test(group.textContent ?? '')) : 'absent';
`

async function pick(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    return true;
  `)
}

export async function run(t) {
  await t.mount('form-required-where')

  /* ── it starts as the row starts ──────────────────────────────────────── */

  t.is(await t.evaluate('return ' + isRequired('#edit [name=trackingCode]')), 'false',
    'a draft order does not need a tracking code')
  t.is(await t.evaluate('return ' + isRequired('#edit [name=status]')), 'true',
    'while a column the schema requires unconditionally still does')
  t.is(await t.evaluate(optionalBadge('#edit [name=trackingCode]')), 'true',
    'and the screen says so — the column carries an "(Optional)" badge')

  /* ── and MOVES ────────────────────────────────────────────────────────── */

  await pick(t, '#edit [name=status]', 'shipped')
  await t.eventually(isRequired('#edit [name=trackingCode]'), 'true',
    'picking shipped makes the tracking code required, with nothing reloaded')

  t.is(await t.evaluate(optionalBadge('#edit [name=trackingCode]')), 'false',
    'and the "(Optional)" badge is gone, which is what a person actually reads')

  // The column beside it is the control for *the whole form went required*.
  t.is(await t.evaluate('return ' + isRequired('#edit [name=note]')), 'false',
    'the ordinary column beside it is untouched')

  /* ── and moves BACK, which is the one a latching rule fails ───────────── */

  await pick(t, '#edit [name=status]', 'cancelled')
  await t.eventually(isRequired('#edit [name=trackingCode]'), 'false',
    'a state that does not need it releases the control again')

  await pick(t, '#edit [name=status]', 'shipped')
  await t.eventually(isRequired('#edit [name=trackingCode]'), 'true',
    'and it comes back')

  /* ── the affordance is an affordance ──────────────────────────────────── */
  //
  // What is deliberately NOT asserted here: that an empty required control
  // blocks the submit. This fixture stubs `save`, so the whole write pipeline
  // that would refuse — and the Data boundary behind it — is not in the run,
  // and a test of it here would be a test of the stub. **Enforcement is the
  // CHECK's** and is graded in litestone's `test/required-where.test.ts`,
  // including through `asSystem()` and a raw INSERT. Invariant 6 is the
  // division: this is a UI affordance and the server refuses regardless.
  //
  // So the last thing to say here is that the affordance did not become the
  // rule — the column is still SENT, and what the person typed is in it.
  await t.evaluate(`
    const el = document.querySelector('#edit [name=trackingCode]');
    el.focus(); el.value = 'T-1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.evaluate(`document.querySelector('#edit form').requestSubmit(); return true;`)
  await t.eventually(`window.kitSent().length`, 1, 'the form saves')
  t.ok(await t.evaluate(`return window.kitSent()[0].data.trackingCode === 'T-1';`),
    'carrying what was typed')

  /* ── a create form is making a draft ──────────────────────────────────── */

  t.is(await t.evaluate('return ' + isRequired('#create [name=trackingCode]')), 'false',
    'a create form demands nothing for a state nobody has chosen yet')
}
