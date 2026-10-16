/*
 * form-small.spec.mjs — the small Form and simple-control defects of FJS-2608.
 *
 * Every claim here is a pair with its opposite somewhere else in the suite:
 * a lock that stops a write, a mode the form answers, a flag a button reads.
 * None of them has a symptom in a screenshot.
 */
export const name = 'Form — small defects'
export const covers = ['forms/Form', 'forms/RadioGroup', 'forms/Checkbox', 'forms/Button', 'forms/FormField']

const calls = `document.querySelector('#calls').textContent`

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function run(t) {
  await t.mount('form-small')

  /* ── -7: upsert over a row with an id is a patch, so it autosaves ─────── */

  await typeInto(t, '#upsert [name=reference]', 'ORD-8')
  await t.eventually(calls, 'save:upsert:ORD-8',
    'method=upsert on a row that has an id autosaves instead of answering create')

  /* ── -6: a window armed before a lock does not write after it ─────────── */

  await typeInto(t, '#late [name=reference]', 'ORD-9')
  await t.evaluate(`window.kitLock(); return true;`)
  await sleep(600)
  t.is(await t.evaluate(`return ${calls};`), 'save:upsert:ORD-8',
    'an autosave armed before the form was disabled writes nothing when it fires')

  /* ── -8: a non-null Boolean is not a required checkbox ────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#bool [name=active]').required;`), false,
    'a not-null Boolean on a patch is not native required')

  /* ── -10: a number item is written as a number ────────────────────────── */

  await t.evaluate(`document.querySelector('#radio input[value="2"]').click(); return true;`)
  await t.eventually(`document.querySelector('#picked').textContent`, 'number:2',
    'a number item comes back as a number, not the DOM string')

  /* ── -17: the description id survives a value with a space ────────────── */

  t.is(await t.evaluate(`
    const bad = [...document.querySelectorAll('#radio input[aria-describedby]')]
      .filter((el) => /\\s/.test(el.getAttribute('aria-describedby')) || !document.getElementById(el.getAttribute('aria-describedby')));
    return bad.length;
  `), 0, 'every aria-describedby names one element that exists')

  /* ── -14: ondone gets what was saved, not the reset blank ─────────────── */

  await typeInto(t, '#done [name=reference]', 'ORD-3')
  await typeInto(t, '#done [name=total]', '7')
  await t.evaluate(`document.querySelector('#done form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#saved-ref').textContent`, 'ORD-3',
    'resetOnDone hands ondone the record that was saved')

  /* ── -13: a submit does not leave every field revealed ────────────────── */

  await typeInto(t, '#again [name=reference]', 'ORD-4')
  await typeInto(t, '#again [name=total]', '5')
  await t.evaluate(`document.querySelector('#again form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#again [name=reference]').value`, '',
    'the parent took another blank record')
  await typeInto(t, '#again [name=reference]', 'A')
  await t.eventually(`document.querySelector('#again-errors').textContent`, '',
    'the first key of the next record speaks for no field')

  /* ── -16: after a committed failure the submit is off ─────────────────── */

  await typeInto(t, '#commit [name=reference]', 'ORD-5')
  await typeInto(t, '#commit [name=total]', '5')
  await t.evaluate(`window.kitFailCommitted(); return true;`)
  await t.evaluate(`document.querySelector('#commit form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#commit button[type=submit]').disabled`, 'true',
    'the submit button is disabled once the row is written')

  /* ── -15: @big keeps its keypad and its pattern ───────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('#big [name=big]').getAttribute('inputmode');`), 'numeric',
    'a @big column asks for the numeric keypad')
  t.is(await t.evaluate(`return document.querySelector('#big [name=big]').getAttribute('pattern');`), '^-?[0-9]+$',
    'and carries the column pattern')
}
