/*
 * form-stale-option.spec.mjs — Form's own "no longer available" refusal retires.
 *
 * `optionsFor` reports a pinned `unavailable` value through `_control`, which
 * refuses every submit and which only the raising control retracts. Form
 * raised it, so nothing did: the person picked another value, the message
 * stayed, and every submit after it made no call (`FJS-2592`).
 *
 * The message is about the VALUE it was raised for, so the assertions run both
 * ways: another value clears it and submits, and a reset back to the stale
 * value says it again rather than submitting a value the boundary refuses.
 */
export const name = 'Form — a stale option refusal clears once another value is picked'
export const covers = ['forms/Form']

const groupText = (root) =>
  `(document.querySelector('${root} select[name=status]')?.closest('form')?.textContent ?? '').includes('no longer available')`
const sent = (root) => `document.querySelector('${root}-sent').textContent`

async function pick(t, root, value) {
  await t.evaluate(`
    const el = document.querySelector('${root} select[name=status]');
    el.value = '${value}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
}

const submit = (t, root) => t.evaluate(`
  document.querySelector('${root} form').requestSubmit();
  return true;
`)

export async function run(t) {
  await t.mount('form-stale-option')

  for (const root of ['#hand', '#gen']) {
    await t.eventually(groupText(root), true, `${root}: a stale value says so on open`)

    await submit(t, root)
    await new Promise((r) => setTimeout(r, 50))
    t.is(await t.evaluate(`return ${sent(root)};`), '0', `${root}: and refuses the submit`)

    await pick(t, root, 'alpha')
    await t.eventually(groupText(root), false, `${root}: another value retires the message`)

    await submit(t, root)
    await t.eventually(sent(root), '1', `${root}: and the form submits again`)
  }

  /* ── a reset is graded against the value it lands on ─────────────────── */

  await t.clickAt('#gen-reset')
  await t.eventually(groupText('#gen'), true, 'a reset back to the stale value says so again')

  await t.clickAt('#gen-reset-next')
  await t.eventually(groupText('#gen'), false, 'a reset to another value retires it')
  await submit(t, '#gen')
  await t.eventually(sent('#gen'), '2', 'and the form submits')
}
