/*
 * form-lifecycle.spec.mjs — what a <Form> does, not what it renders.
 *
 * The validation TIMING rule, the two error sources and how they retire, which
 * service method a submit picks, the imperative API, dirty tracking and reset.
 *
 * The timing rule is the one worth the fixture on its own, because it is a
 * rule about what must NOT happen: on input an error may only be removed,
 * never revealed. Wire it the obvious way — re-validate on every keystroke —
 * and the first character typed into the first field lights up "required" on
 * three fields nobody has reached. That misbehaviour looks like working
 * validation in a screenshot and like a hostile form to a person.
 */
export const name = 'Form — lifecycle'
export const covers = ['forms/Form']

const errKeys = `document.querySelector('#error-keys').textContent`
const msgIn = (sel) =>
  `document.querySelector(${JSON.stringify(sel)})?.textContent?.replace(/\\s+/g,' ').trim() ?? ''`

// A control's own message, wherever the kit puts it — asked by field name so
// this does not pin the markup around it.
const messageFor = (form, name) =>
  `(() => { const el = document.querySelector('${form} [name=${name}]'); const box = el?.closest('.field-group') ?? el?.parentElement; return box?.querySelector('.field-error, .error, [role=alert]')?.textContent?.trim() ?? ''; })()`

async function typeInto(t, sel, value) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

// `blur` does not bubble, which is why the form listens in the CAPTURE phase.
// Dispatching it straight at the element is what a real focus change does to
// that listener.
async function leave(t, sel) {
  await t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    el.dispatchEvent(new FocusEvent('blur'));
    return true;
  `)
}

export async function run(t) {
  await t.mount('form-lifecycle')

  /* ── the timing rule ──────────────────────────────────────────────────── */

  // One character in one field. Validation judges the WHOLE record, so the
  // naive wiring reports every other required field here.
  await typeInto(t, '#create [name=reference]', 'A')
  await t.eventually(errKeys, '', 'typing in one field reveals nothing anywhere')
  await t.eventually(`document.querySelector('#dirty').textContent`, 'true',
    'but the form is dirty from the first keystroke')

  // Leaving a field that HAS been typed in is what reveals it. 'A' is under
  // minLength, so this one has something to say.
  await leave(t, '#create [name=reference]')
  await t.eventually(errKeys, 'reference', 'leaving a field you typed in reveals that field')
  t.ok(await t.evaluate(`return ${messageFor('#create', 'reference')}.length > 0;`),
    'and the control shows the message')

  // Still only that one: tabbing past an untouched field must stay silent, or
  // an empty form shouts at someone who has typed nothing.
  await leave(t, '#create [name=total]')
  await t.eventually(errKeys, 'reference', 'leaving an untouched field stays silent')

  // The keystroke that fixes it takes the message away — a field already
  // speaking is allowed to be re-checked on input.
  await typeInto(t, '#create [name=reference]', 'ORD-1')
  await t.eventually(errKeys, '', 'the keystroke that fixes it goes quiet again')

  // And a revealed field may say something ELSE, rather than only being
  // cleared: re-check, not blind clear.
  await typeInto(t, '#create [name=reference]', 'AB')
  await t.eventually(errKeys, 'reference', 'a revealed field re-checks on input rather than clearing')
  await typeInto(t, '#create [name=reference]', 'ORD-1')
  await t.eventually(errKeys, '', 'and clears again when it passes')

  /* ── coercion runs before validation ──────────────────────────────────── */

  // Every DOM control hands back a string, so validating the raw record would
  // reject "42" for a number column — a correct value reported as wrong.
  await typeInto(t, '#create [name=total]', '42')
  await leave(t, '#create [name=total]')
  await t.eventually(errKeys, '', 'a number typed as a string is valid — coerce runs first')

  /* ── submit reveals everything ────────────────────────────────────────── */

  // Submit is what speaks for the fields nobody visited.
  await t.evaluate(`document.querySelector('#create [name=reference]').value = ''; document.querySelector('#create [name=reference]').dispatchEvent(new Event('input', {bubbles:true})); return true;`)
  await t.clickAt('#api-submit')
  await t.eventually(errKeys, 'reference', 'submitting reveals a field nobody visited')
  await t.eventually(`document.querySelector('#submitted').textContent`, 'true',
    'and records that a submit was attempted')
  // A form that will not validate must not reach the service at all.
  t.is(await t.evaluate(`return ${msgIn('#calls')};`), '',
    'and an invalid form never reaches the service')

  /* ── which method a submit picks ──────────────────────────────────────── */

  await typeInto(t, '#create [name=reference]', 'ORD-1')
  await typeInto(t, '#create [name=total]', '42')
  await t.clickAt('#api-submit')
  await t.eventually(`document.querySelector('#calls').textContent`, 'create:ORD-1',
    'a record with no id creates')
  await t.eventually(`document.querySelector('#done').textContent`, '1', 'and ondone fires')
  await t.eventually(`document.querySelector('#dirty').textContent`, 'false',
    'a successful submit is no longer dirty')

  // The same `method="auto"`, a record that has an id: patch, and the id has
  // to travel as the first argument rather than only inside the payload.
  await typeInto(t, '#patch [name=reference]', 'ORD-7b')
  await t.evaluate(`document.querySelector('#patch form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#calls').textContent`, 'create:ORD-1|patch:o-7:ORD-7b',
    'a record with an id patches, addressed by that id')

  await typeInto(t, '#upsert [name=reference]', 'ORD-9')
  await typeInto(t, '#upsert [name=total]', '5')
  await t.evaluate(`document.querySelector('#upsert form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#calls').textContent`,
    'create:ORD-1|patch:o-7:ORD-7b|upsert:ORD-9', 'and a stated method wins over both')

  // A resource that owns the write gets handed the record and the mode. The
  // form must NOT pick a service method for it: the resource knows the model's
  // id field and this component does not (`FJS-D114`).
  await typeInto(t, '#saves [name=reference]', 'ORD-S')
  await typeInto(t, '#saves [name=total]', '3')
  await t.evaluate(`document.querySelector('#saves form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#calls').textContent`,
    'create:ORD-1|patch:o-7:ORD-7b|upsert:ORD-9|save:auto:ORD-S',
    'a resource with save() owns the write, and hears which mode was asked for')

  /* ── the two error sources ────────────────────────────────────────────── */

  // A server message is the half only the server can know. It arrives through
  // the resource's own unwrapper, which is the one owner of "a thrown value →
  // per-field messages".
  await t.evaluate(`window.kitFailNextSubmit(); return true;`)
  await t.clickAt('#api-submit')
  await t.eventually(errKeys, 'reference', 'a rejected submit puts the server message on its field')
  await t.eventually(`document.querySelector('#failed').textContent`, '1', 'and onerror fires')
  await t.eventually(`${msgIn('#create [role=alert]')}`, 'Could not save the order',
    'while the failure no field can render becomes the form-level alert')
  t.ok(await t.evaluate(`return ${messageFor('#create', 'reference')}.includes('taken');`),
    'the field message is the server\'s, not the schema\'s')

  // Editing the value a server message was about retires it. Without that it
  // sits under a box the user has already fixed, which reads as a form
  // refusing a correct value.
  await typeInto(t, '#create [name=reference]', 'ORD-2')
  await t.eventually(errKeys, '', 'editing that field retires the server message')
  await t.eventually(`${msgIn('#create [role=alert]')}`, 'Could not save the order',
    'the form-level alert stays until the next submit — it was about the whole request')

  /* ── the imperative API ───────────────────────────────────────────────── */

  // Two ways in, the same three functions: onready predates `export function`
  // working at all, and bind:this is what the kit documents now.
  await t.clickAt('#api-clear')
  await t.eventually(`${msgIn('#create [role=alert]')}`, '', 'clearErrors drops the alert')

  await t.clickAt('#ref-submit')
  // The rejected attempt above is in the list too — the stub records the call
  // it was asked to make, and it was made.
  await t.eventually(`document.querySelector('#calls').textContent`,
    'create:ORD-1|patch:o-7:ORD-7b|upsert:ORD-9|save:auto:ORD-S|create:ORD-1|create:ORD-2',
    'bind:this offers the same submit as onready')

  /* ── reset ────────────────────────────────────────────────────────────── */

  await typeInto(t, '#create [name=reference]', 'SCRATCH')
  await t.clickAt('#api-reset')
  await t.eventually(`document.querySelector('#create [name=reference]').value`, '',
    'reset goes back to the pristine record')
  await t.eventually(`document.querySelector('#dirty').textContent`, 'false', 'and is not dirty')
  await t.eventually(`document.querySelector('#submitted').textContent`, 'false',
    'and has not been submitted')

  // reset(next) re-baselines: the form a save just succeeded on should reset
  // to what was saved, not to what it was first mounted with.
  await t.clickAt('#rebaseline')
  await t.eventually(`document.querySelector('#create [name=reference]').value`, 'BASE',
    'reset(next) adopts a new baseline')
  await typeInto(t, '#create [name=reference]', 'CHANGED')
  await t.clickAt('#api-reset')
  await t.eventually(`document.querySelector('#create [name=reference]').value`, 'BASE',
    'and the next reset returns to it')

  /* ── resetOnDone, and disabled ────────────────────────────────────────── */

  await typeInto(t, '#reset-on-done [name=reference]', 'ORD-3')
  await typeInto(t, '#reset-on-done [name=total]', '7')
  await t.evaluate(`document.querySelector('#reset-on-done form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#reset-on-done [name=reference]').value`, '',
    'resetOnDone clears the form after a successful save')

  // A disabled form refuses to submit at all — the guard is in submit(), not
  // only on the buttons, so a keyboard Enter cannot slip past it.
  const before = await t.evaluate(`return document.querySelector('#calls').textContent;`)
  await typeInto(t, '#off [name=reference]', 'NOPE')
  await t.evaluate(`document.querySelector('#off form').requestSubmit(); return true;`)
  await t.eventually(`document.querySelector('#calls').textContent`, before,
    'a disabled form does not submit')
  t.ok(await t.evaluate(`return document.querySelector('#off [name=reference]').disabled;`),
    'and its controls are disabled through the form context')
}
