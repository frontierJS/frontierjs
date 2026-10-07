/*
 * form-list.spec.mjs — a scalar list on a generated form.
 *
 * `FJS-1822`: a `String[]` rendered as a JSON box, so the first tag a person
 * typed was refused as *Unexpected token … is not valid JSON*. Five of the 21
 * apps the base44 stressor generated stopped there. A list whose items are a
 * scalar is now the MultiSelect with nothing to choose from: a person types an
 * item and presses Enter, as in any tag box.
 */
export const name = 'Form — a scalar list'
export const covers = ['forms/FormField', 'forms/MultiSelect']

const record = `JSON.parse(document.querySelector('#record').textContent)`
// The search box carries no `name` (the value is the pills, not the box), so
// each list is found through its own label.
const input  = (label) => `document.getElementById([...document.querySelectorAll('label')].find(l => l.textContent.includes(${JSON.stringify(label)})).htmlFor)`

export async function run(t) {
  await t.mount('form-list')

  t.is(await t.evaluate(`return document.querySelectorAll('textarea, [data-syntax=json]').length;`), 0,
    'neither list is drawn as a JSON box')
  t.is(await t.evaluate(`return document.querySelector('#asked').textContent;`), '',
    'and neither asks the resource for options it does not have')
  t.is(await t.evaluate(`return ${input('Tags')}?.getAttribute('placeholder') ?? null;`), 'Add…',
    'a list with nothing behind it asks for a value, not a choice')

  await t.evaluate(`${input('Tags')}.focus(); await waitSettled('body');`)
  t.is(await t.evaluate(`return document.querySelector('[role=listbox]')?.textContent.trim() ?? null;`),
    'Type a value and press Enter',
    'focused and empty, it says how an item is added rather than *No options*')

  await t.type('design')
  await t.press('Enter')
  await t.type('urgent')
  await t.press('Enter')
  await t.eventually(`${record}.tags.join(',')`, 'design,urgent',
    'each typed tag joins the list as a string')

  await t.evaluate(`${input('Scores')}.focus(); await waitSettled('body');`)
  await t.type('3')
  await t.press('Enter')
  await t.eventually(`JSON.stringify(${record}.scores)`, '[3]',
    'an item of an integer list is a number, not the text typed')
}
