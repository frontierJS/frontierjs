/*
 * export-button.spec.mjs — ExportButton saves the rows a screen's query names.
 *
 * The file is what Chrome wrote, so a query the button mangled or a Response
 * it never handed to `download` both fail here. The route refuses any `$` key
 * (Invariant 10), so a page query's directives must not reach the path.
 */
export const name = 'export button — the screen\'s filter goes to /exports/{dataset}, its directives do not; the file is saved; a refusal is shown'
export const covers = ['display/ExportButton']

export async function run(t) {
  await t.mount('export-button')

  const saved = t.nextDownload()
  await t.clickAt('#ok button')
  const file = await saved
  t.is(await t.evaluate(`return document.getElementById('asked').textContent;`), '/exports/Order?status=open',
    'the filter keys travel and the $ directives are dropped')
  t.is(file.name, 'order.csv', 'the file is saved under the name the server gave')
  t.is(file.text, 'id,status\n1,open\n', 'with the bytes the route answered')

  await t.clickAt('#bad button')
  await t.eventually(`document.querySelector('#bad [role="alert"]')?.textContent ?? ''`, 'Unknown column "colour"',
    'a refused export shows the server\'s message beside the button')
}
