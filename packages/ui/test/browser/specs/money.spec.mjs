/*
 * money.spec.mjs — the control a `@money` column gets, in a real browser.
 *
 * `@money` stores a whole number of MINOR units and a person types MAJOR ones.
 * A box that hands its text to the column charges forty-two cents for an
 * order of forty-two dollars, and every screen, check and receipt agrees with
 * it — 42 is a legal value of the column (`FJS-D555`).
 *
 * Three things are asked here and none can be asked anywhere else.
 *
 * The WIRING — `x-money` → `money` (Sierra's table) → `MoneyInput` (the kit's
 * dispatcher) — because a break leaves the column off a form that still looks
 * finished.
 *
 * The CONVERSION at both edges, by the currency's own exponent: two places for
 * a dollar, none for a yen, three for a dinar, and `8.29` stored as 829 where a
 * float multiplication stores 828.
 *
 * And the REFUSAL with its retraction: more decimals than the currency has, or
 * a decimal comma, is not an amount — the form says so and does not submit,
 * and fixing the text is what lets it submit again.
 */
export const name = 'MoneyInput'
export const covers = ['forms/MoneyInput', 'forms/FormField']

const box = (field) => `document.querySelector('#generated input[name=${field}]')`

/** Type into a box the way a person does — the control listens on `input`. */
const setValue = (t, expr, text) => t.evaluate(`
  const el = ${expr};
  if (!el) throw new Error('no element');
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`)

const sent = (t) => t.evaluate(`return JSON.parse(document.querySelector('#sent').textContent || 'null');`)

export async function run(t) {
  await t.mount('money')

  /* ── standing alone ───────────────────────────────────────────────────── */

  t.is(await t.evaluate(`return document.querySelector('input[name=price]').value;`),
    '1.500', 'a dinar amount is shown with its three places')
  await setValue(t, `document.querySelector('input[name=price]')`, '2.5')
  await t.eventually(`document.querySelector('#seen').textContent`, '2500',
    'and 2.5 dinar is handed back as 2500 fils')

  /* ── the wiring: no control is named anywhere in that form ────────────── */

  t.is(await t.evaluate(`
    const els = ['total', 'tip', 'refund'].map(n => document.querySelector('#generated input[name=' + n + ']'));
    return els.map(e => e ? e.type + ':' + e.dataset.currency : 'missing').join(' ');
  `), 'text:USD text:JPY text:USD', 'each @money shape reaches a money box, in its own currency')

  t.is(await t.evaluate(`return [${box('total')}.value, ${box('tip')}.value, ${box('refund')}.value].join('|');`),
    '12.99|500|10.00', 'the stored minor units are shown in major ones')

  /* ── the conversion, on the way out ───────────────────────────────────── */

  await setValue(t, box('total'), '8.29')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '1', 'an amount submits')
  const first = await sent(t)
  t.is(first.total, 829, '8.29 dollars is 829 cents — not 828, which is what a float gives')
  t.is(first.tip, 500, 'and a yen amount untouched is what it was')

  await setValue(t, box('total'), '1,234.5')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '2', 'a grouped amount submits')
  t.is((await sent(t)).total, 123450, 'with its grouping read as grouping')

  /* ── what is not an amount ────────────────────────────────────────────── */

  await setValue(t, box('total'), '12.345')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '2',
    'three decimals of a dollar does not submit')
  t.ok(await t.evaluate(`
    return /2 decimal places/.test(document.querySelector('#generated .field-hint.danger')?.textContent ?? '');
  `), 'and it says how many the currency has, where a server error would appear')

  await setValue(t, box('total'), '12,50')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '2',
    'a decimal comma is refused, not read as twelve hundred and fifty')

  await setValue(t, box('tip'), '5.5')
  await setValue(t, box('total'), '12.34')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '2',
    'half a yen does not submit either, whatever the other box holds')

  /* ── the retraction, which keeps the guard from being a lock ──────────── */

  await setValue(t, box('tip'), '')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '3',
    'fixing the text retracts the refusal and the form submits')
  const cleared = await sent(t)
  t.is(cleared.total, 1234, 'with the amount now on screen')
  t.is(cleared.tip, null, 'and a blank box is no amount, not zero')

  /* ── a per-row currency ───────────────────────────────────────────────── */

  await setValue(t, box('refund'), '10')
  await t.evaluate(`
    const sel = document.querySelector('#generated select[name=currency]');
    sel.value = 'JPY';
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.eventually(`${box('refund')}.dataset.currency`, 'JPY',
    'the refund box follows the currency on its own row')
  t.is(await t.evaluate(`return ${box('refund')}.value;`), '10',
    'and the amount on screen is kept')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '4', 'the row submits')
  const perRow = await sent(t)
  t.is(perRow.currency, 'JPY', 'in its new currency')
  t.is(perRow.refund, 10, 'as 10 yen — never 1000, the cents the dollar amount was')
}
