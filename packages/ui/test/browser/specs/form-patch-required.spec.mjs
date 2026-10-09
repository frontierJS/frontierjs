/*
 * form-patch-required.spec.mjs — the badge on an edit agrees with the refusal.
 *
 * A non-null column with a default is never in the schema's `required` list,
 * so the badge read "(Optional)" on an edit while blanking the box was refused
 * (`FJS-2065`). A create may leave the column to its default and keeps the
 * badge; a nullable column beside it stays optional on both.
 */
export const name = 'Form — a non-null defaulted column on an edit'
export const covers = ['forms/Form']

const isRequired = (sel) =>
  `(document.querySelector(${JSON.stringify(sel)})` +
  ` ? String(!!document.querySelector(${JSON.stringify(sel)}).required) : 'absent')`

const optionalBadge = (sel) => `
  const el = document.querySelector(${JSON.stringify(sel)});
  const group = el ? (el.closest('.field-group') ?? el.parentElement) : null;
  return group ? String(/optional/i.test(group.textContent ?? '')) : 'absent';
`

export async function run(t) {
  await t.mount('form-patch-required')

  t.is(await t.evaluate('return ' + isRequired('#edit [name=extraHours]')), 'true',
    'an edit requires a column that cannot be blank')
  t.is(await t.evaluate(optionalBadge('#edit [name=extraHours]')), 'false',
    'and carries no "(Optional)" badge')
  t.is(await t.evaluate(optionalBadge('#edit [name=note]')), 'true',
    'a nullable column beside it is still optional')

  t.is(await t.evaluate('return ' + isRequired('#create [name=extraHours]')), 'false',
    'a create leaves it to the default')
  t.is(await t.evaluate(optionalBadge('#create [name=extraHours]')), 'true',
    'and says so')
}
