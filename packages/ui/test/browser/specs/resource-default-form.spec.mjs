/*
 * resource-default-form.spec.mjs — the file `fli make:resource` writes, opened
 * in a browser.
 *
 * `FJS-D114` ruled that a Resource is the model's whole client-side surface, and
 * the generator now emits the default form rather than only permitting one. The
 * emitted markup makes one claim that a compile cannot check: a page rendering
 * `<Order />` gets the generated fields, and a page passing children gets its
 * own form instead. Both go through a wrapper that ALWAYS hands <Form> a slot,
 * which is the shape that would silently turn generation off everywhere.
 */
export const name   = 'a generated Resource — its default form'
export const covers = ['forms/Form']

const namesIn = (sel) =>
  `[...document.querySelectorAll(${JSON.stringify(sel)} + ' [name]')].map(el => el.getAttribute('name')).join(',')`

export async function run(t) {
  await t.mount('resource-default-form')

  t.is(await t.evaluate(`return ${namesIn('#create')};`), 'reference,status',
    '<Order /> with no children renders the generated form')

  t.is(await t.evaluate(`return document.querySelector('#edit [name=reference]').value;`), 'ORD-7',
    'and a record passed in is what the same form edits')

  // The seed has to SURVIVE the parent's prop push. A wrapper declaring
  // `export let record` re-pushes `undefined` after <Form> seeded its blank,
  // and *not stated* is not *cleared* — without that distinction the schema
  // blank is dropped and every control reads a field off nothing.
  t.is(await t.evaluate(`return document.querySelector('#create [name=status]').value;`), 'draft',
    'the schema-seeded blank survives the wrapper re-pushing an absent record')

  // Children win — that is the escape hatch `FJS-D112` names, and it has to
  // survive the wrapper.
  t.is(await t.evaluate(`return ${namesIn('#custom')};`), 'reference',
    'a page passing children gets its own form, not the generated one')
  t.ok(await t.evaluate(`return !!document.querySelector('#custom #mine');`),
    'and the child it wrote is the control that rendered')
}
