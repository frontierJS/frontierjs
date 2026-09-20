/*
 * geofield.spec.mjs — the control a `@point` column gets, in a real browser.
 *
 * `FJS-D327` keeps a map out of the kit: a map is a rendering library plus a
 * tile VENDOR, which is a battery with tendrils and a vendor choice this repo
 * does not make. What the kit can own is two number boxes that refuse ±90/±180
 * and write the pair under the keys the MODEL declared.
 *
 * Two things are asked here and neither can be asked anywhere else.
 *
 * The WIRING — `x-geo` → `geo` (Sierra's table) → `GeoField` (the kit's
 * dispatcher) — because a break in either link renders a JSON textarea over a
 * coordinate and the form still looks fine.
 *
 * And the HALF-COORDINATE, which is the whole reason this is a control rather
 * than an attribute on an input. Two elements hold one value, so the moment
 * somebody types a latitude and tabs past the other box there is text on screen
 * that is not a value. Writing `{lat, lng: null}` makes a 400 out of it at
 * submit, on the database's own CHECK; writing `null` throws away what they
 * typed. The control hands back nothing and tells the form why — and the
 * RETRACTION is the half that turns that guard into a lock if it is missing.
 */
export const name = 'GeoField'
export const covers = ['forms/GeoField', 'forms/FormField']

const LAT = `document.querySelector('#generated input[name=site]')`
const LNG = `document.querySelector('#generated .field-row input:not([name])')`

/** Type into a box the way a person does — the control listens on `input`. */
const setValue = (t, expr, text) => t.evaluate(`
  const el = ${expr};
  if (!el) throw new Error('no element');
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`)

export async function run(t) {
  await t.mount('geofield')

  /* ── the value reaches the boxes, and the boxes reach the value ───────── */

  t.is(await t.evaluate(`return document.querySelector('input[name=site]').value;`),
    '51.5074', 'the stored latitude is what the box shows')

  // The two boxes carry the DECLARED key names as their placeholders and their
  // labels, which is the only thing on screen that says which is which.
  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#generated .field-row input')].map(i => i.placeholder).join(',');
  `), 'latitude,longitude', 'the generated form names the keys the model declared')

  /* ── the wiring: no control is named anywhere in that form ────────────── */

  t.is(await t.evaluate(`
    return document.querySelectorAll('#generated textarea').length;
  `), 0, 'x-geo reaches a control and not the JSON document editor')

  t.is(await t.evaluate(`
    return [...document.querySelectorAll('#generated .field-row input')].map(i => i.type).join(',');
  `), 'number,number', 'and the control is two number inputs')

  t.is(await t.evaluate(`
    const els = [...document.querySelectorAll('#generated .field-row input')];
    return els.map(e => e.min + '..' + e.max).join(' ');
  `), '-90..90 -180..180', 'each box refuses the range its own coordinate has')

  t.is(await t.evaluate(`return ${LAT}.value + ',' + ${LNG}.value;`),
    '40.7128,-74.006', 'and the record is shown under its own key names')

  /* ── a whole pair submits, under the declared keys ─────────────────────── */

  await setValue(t, LAT, '51.5')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '1',
    'a complete pair submits')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent;`),
    '{"latitude":51.5,"longitude":-74.006}',
    'and what it sends is one value under the keys the model declared')

  /* ── half a coordinate is not a value ─────────────────────────────────── */

  // Emptying one box is exactly what tabbing past it looks like to the form.
  await setValue(t, LNG, '')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '1',
    'a form does not submit while half a coordinate is on screen')

  t.ok(await t.evaluate(`
    return /needs both/.test(document.querySelector('#generated .field-hint.danger')?.textContent ?? '');
  `), 'and it says which two it needs, where a server error would appear')

  /* ── the retraction, which is what keeps the guard from being a lock ──── */

  await setValue(t, LNG, '-0.12')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '2',
    'completing the pair retracts the refusal and the form submits')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent;`),
    '{"latitude":51.5,"longitude":-0.12}', 'and the value it sends is the completed pair')

  /* ── clearing BOTH is a row with no location, which is ordinary ────────── */

  await setValue(t, LAT, '')
  await setValue(t, LNG, '')
  await t.clickAt('#save')
  await t.eventually(`document.querySelector('#saves').textContent`, '3',
    'clearing both boxes is not a refusal')
  t.is(await t.evaluate(`return document.querySelector('#sent').textContent;`),
    'null', 'it is a row with no location, which the column allows')
}
