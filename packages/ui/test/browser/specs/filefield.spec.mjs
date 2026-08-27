/*
 * filefield.spec.mjs — the control a `File` column gets.
 *
 * `FileUpload` has a spec of its own and it is about the DROPZONE: a
 * DataTransfer, a drop event, a FileList. This one is about the VALUE, which is
 * the whole reason a second component exists — a column is one of three things
 * and a form must render all three while handing back only one of them.
 *
 * The one that cannot be asserted anywhere else is the middle state. A row that
 * has been saved holds the URL the server resolved its stored reference into,
 * so an edit form is handed a string where a create form is handed nothing —
 * and the failure it guards is silent: a control that renders the URL as text,
 * or drops it, turns "replace this photograph" into "there is no photograph".
 */
export const name = 'FileField'
export const covers = ['forms/FileField']

const pick = (sel, file) => `
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(${file.bytes})], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));
  document.querySelector(${JSON.stringify(sel)} + ' .fjs-dropzone')
    .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
`

export async function run(t) {
  await t.mount('filefield')

  /* ── nothing chosen yet ───────────────────────────────────────────────── */

  t.ok(await t.evaluate(`return !!document.querySelector('#empty .fjs-dropzone');`),
    'an empty column offers the picker')
  t.is(await t.evaluate(`return !!document.querySelector('#empty [data-file-current]');`), false,
    'and shows no preview, because there is nothing stored')

  // `@accept` reaches the dialog. The Data boundary enforces the same list, so
  // this is not the guard — it is the difference between being told before
  // choosing a file and being told after uploading one.
  t.is(await t.evaluate(`return document.querySelector('#empty input[type=file]').accept;`),
    'image/png, image/gif', 'the input carries the accept list the schema declared')

  /* ── a saved row: the server resolved the reference into a URL ─────────── */

  t.ok(await t.evaluate(`return !!document.querySelector('#existing [data-file-current]');`),
    'a stored value renders as the photograph, not as its URL')
  t.ok(await t.evaluate(`
    const img = document.querySelector('#existing [data-file-current]');
    return img.complete && img.naturalWidth > 0;
  `), 'and the image actually decoded')

  /* ── the value handed back ────────────────────────────────────────────── */

  // The substance. A form must send the browser File and never the URL it was
  // showing a moment ago — a control that hands back its rendered string writes
  // a URL into a column that holds a storage reference, which the Data boundary
  // accepts as a path and stores as text nobody can read back.
  await t.evaluate(pick('#existing', { name: 'replacement.png', type: 'image/png', bytes: 24 }))
  await t.eventually(`document.querySelector('#handed').textContent`, 'replacement.png',
    'choosing a file hands the form the File itself')
  await t.eventually(`document.querySelector('#kind').textContent`, 'File',
    '…as a File object, not a name or a URL')

  t.ok(await t.evaluate(`return !!document.querySelector('#existing [data-file-preview]');`),
    'the chosen file previews in place of the stored one')
  t.ok(await t.evaluate(`return !!byText('#existing', 'not saved yet');`),
    'and says it has not been saved, because nothing has uploaded')

  /* ── undo, which is not the same as clear ─────────────────────────────── */

  // Two different intentions the same button cannot serve: `undefined` leaves
  // the column alone and `null` empties it. A control offering only one of them
  // makes "I picked the wrong file" indistinguishable from "remove the photo".
  await t.clickAt('#existing [data-file-undo]')
  await t.eventually(`document.querySelector('#handed').textContent`, 'undefined',
    'undo hands back undefined — the stored file is left alone')
  t.ok(await t.evaluate(`return !!document.querySelector('#existing [data-file-current]');`),
    'and the stored photograph is on screen again')

  await t.clickAt('#existing [data-file-clear]')
  await t.eventually(`document.querySelector('#handed').textContent`, 'null',
    'remove hands back null — which is what clears the column')

  /* ── the shape that means something upstream is wrong ─────────────────── */

  // A row read by a path that did not resolve the reference. `<img src>` on a
  // JSON blob is a broken-image icon and no explanation, so it is reported.
  // This is `FJS-541`'s shape, kept visible after the fix rather than removed
  // with it: the resolution happens in litestone and a form is downstream of
  // every read an app might add.
  t.ok(await t.evaluate(`return !!document.querySelector('#unresolved [data-file-unresolved]');`),
    'an unresolved reference is named rather than drawn as a broken image')
  t.is(await t.evaluate(`return !!document.querySelector('#unresolved [data-file-current]');`), false,
    'and no <img> is pointed at it')
}
