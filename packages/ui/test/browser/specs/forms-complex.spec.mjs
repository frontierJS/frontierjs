/*
 * forms-complex.spec.mjs — the small defects of the date, number, picker and
 * file controls (FJS-2609), one control each.
 *
 * Each is a place a control did something quietly wrong rather than loudly:
 * a number stored as 0.7999999999999999, a keyboard picking a row a click
 * cannot, a drop skipping the filter the dialog applies. Asserted through the
 * same door a person uses.
 */
export const name = 'forms-complex — number, thresholds, file, picker, json'
export const covers = [
  'forms/NumberInput', 'forms/Thresholds', 'forms/FileUpload', 'forms/Combobox',
  'forms/MultiSelect', 'forms/JsonInput',
]

const dropFiles = (files) => `
  const dt = new DataTransfer();
  ${files.map((f) => `dt.items.add(new File([new Uint8Array(4)], ${JSON.stringify(f.name)}, { type: ${JSON.stringify(f.type)} }));`).join('\n')}
  document.querySelector('#file .fjs-dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
`

export async function run(t) {
  await t.mount('forms-complex')

  /* ── NumberInput: a string value, and a box that can be emptied ───────── */

  t.is(await t.evaluate(`return document.querySelector('#qty').value;`), '5',
    'a string value shows in the box instead of throwing')
  await t.clickAt('#num button[aria-label="Increase"]')
  await t.eventually(`document.querySelector('#qty-value').textContent`, '6',
    'and a stepper adds to it as a number, not by concatenation')

  await t.evaluate(`const el = document.querySelector('#qty'); el.focus(); el.select(); return true;`)
  await t.press('Backspace')
  await t.eventually(`document.querySelector('#qty-value').textContent`, 'null',
    'emptying the box clears the value to null')
  await t.evaluate(`document.querySelector('#qty').blur(); return true;`)
  t.is(await t.evaluate(`return document.querySelector('#qty').value;`), '',
    'and blur leaves it empty rather than snapping back to the last number')

  /* ── Thresholds: a pushed neighbor is on the step grid ────────────────── */

  await t.evaluate(`
    const el = document.querySelectorAll('#thr input[type="range"]')[0];
    el.value = '0.7';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await t.eventually(`JSON.stringify(window.emitted.at(-1))`, '[0.7,0.8,0.9]',
    'pushing a cut emits 0.8 and 0.9, not 0.7999999999999999')

  /* ── FileUpload: a drop is filtered like the picker is ────────────────── */

  await t.evaluate(dropFiles([{ name: 'notes.pdf', type: 'application/pdf' }]))
  t.is(await t.evaluate(`return document.querySelector('#file-names').textContent;`), '',
    'a drop outside accept is refused')
  t.ok(await t.evaluate(`return /not an accepted/.test(document.querySelector('#file').textContent);`),
    'and says why')

  await t.evaluate(dropFiles([{ name: 'a.png', type: 'image/png' }, { name: 'b.png', type: 'image/png' }]))
  t.is(await t.evaluate(`return document.querySelector('#file-names').textContent;`), '',
    'two files dropped on a single-file control are refused')

  await t.evaluate(dropFiles([{ name: 'a.png', type: 'image/png' }]))
  await t.eventually(`document.querySelector('#file-names').textContent`, 'a.png',
    'one file inside accept is taken')

  /* ── Combobox: the keyboard cannot pick what a click cannot ───────────── */

  await t.clickAt('#combo-input')
  await t.press('ArrowDown')
  await t.eventually(`document.getElementById(document.querySelector('#combo-input').getAttribute('aria-activedescendant'))?.textContent.trim()`, 'Gamma',
    'ArrowDown steps over a disabled option')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#pick').textContent`, 'c', 'and Enter takes the enabled row')

  await t.clickAt('#combo2-input')
  await t.press('Enter')
  t.is(await t.evaluate(`return document.querySelector('#first').textContent;`), '',
    'Enter on a disabled row picks nothing')

  /* ── Escape belongs to a list that is open, not to the dialog around ──── */

  await t.evaluate(`window.escapes.length = 0; document.querySelector('#combo2-input').focus(); return true;`)
  await t.press('Escape')
  await t.press('Escape')
  t.is(await t.evaluate(`return JSON.stringify(window.escapes);`), '[true,false]',
    'Escape is taken while the list is open and left alone once it is shut')

  /* ── MultiSelect: a form-locked control offers no way to change itself ── */

  t.is(await t.evaluate(`return document.querySelectorAll('#locked .pill-close, #locked [aria-label="Clear all"], #locked input[role=combobox]').length;`), 0,
    'a locked MultiSelect draws no remove, no Clear all and no search box')
  t.ok(await t.evaluate(`return document.querySelectorAll('#multi .pill-close').length === 1;`),
    'while a free one still does')

  /* ── JsonInput: an integer past 2^53 is refused, not rounded ──────────── */

  await t.evaluate(`window.docs.length = 0; return true;`)
  await t.evaluate(`
    const box = document.querySelector('#json textarea');
    box.focus();
    box.value = '{"id": 9007199254740993}';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  t.is(await t.evaluate(`return window.docs.length;`), 0, 'a document holding 2^53 + 1 is not written')
  t.ok(await t.evaluate(`return /2\\^53/.test(document.querySelector('#json').textContent);`),
    'and the box says why')
  await t.evaluate(`
    const box = document.querySelector('#json textarea');
    box.value = '{"id": "9007199254740993", "n": 12345678901234}';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  t.is(await t.evaluate(`return window.docs.length;`), 1,
    'the same digits as a string, and a safe integer, are written')
}
