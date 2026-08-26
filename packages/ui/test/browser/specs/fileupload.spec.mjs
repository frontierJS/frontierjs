/*
 * fileupload.spec.mjs — FileUpload.
 *
 * A dropzone is a component that cannot be tested anywhere but a browser:
 * `DataTransfer`, `File`, a `drop` event carrying files, and an
 * `<input type="file">` whose `files` list can only be assigned from a real
 * `FileList`. None of that exists in a DOM shim, and the component's whole
 * job is the path from one of those to `bind:files`.
 *
 * The size guard is asserted through the same door as the happy path, because
 * a validator that rejects everything and one that rejects nothing produce the
 * same screen until a file is actually handed over.
 */
export const name = 'FileUpload'
export const covers = ['forms/FileUpload']

// Building a FileList by hand is the only way in: `input.files` is read-only
// except through a DataTransfer, which is also what a real drop carries.
const dropFiles = (files) => `
  const dt = new DataTransfer();
  ${files.map((f) => `dt.items.add(new File([new Uint8Array(${f.bytes})], ${JSON.stringify(f.name)}, { type: ${JSON.stringify(f.type)} }));`).join('\n')}
  const zone = document.querySelector('.fjs-dropzone');
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
`

export async function run(t) {
  await t.mount('fileupload')


  /* ── the component's own verbs, imported by a caller ──────────────────── */

  // `FJS-D116`: a component file may export the verbs that belong to its noun,
  // and a caller imports them by name. Asserted through the real pipeline —
  // the fixture imports them from the .mesa file and renders the answers.
  t.is(await t.evaluate(`return document.querySelector('#kinds').textContent;`),
    'true|false', 'isImage is importable by name from the component file')
  // The size string the component renders is toolbelt's, not a fourth copy of
  // it — the boundary `FJS-D116` names, met by `FJS-408`.
  t.is(await t.evaluate(`return document.querySelector('#sizes').textContent;`),
    '900 B|2.0 KB|5.0 MB', 'and the size formatter is the shared one')

  t.ok(await t.evaluate(`return !!document.querySelector('#stage .fjs-dropzone');`),
    'the dropzone renders')
  t.ok(await t.evaluate(`
    const input = document.querySelector('#stage input[type=file]');
    const label = document.querySelector('#stage label[for="' + input.id + '"]');
    return !!input && !!input.id;
  `), 'the file input carries an id a label can point at')

  await t.evaluate(dropFiles([{ name: 'notes.pdf', type: 'application/pdf', bytes: 12 }]))
  await t.eventually(`document.querySelector('#names').textContent`, 'notes.pdf',
    'a dropped file reaches bind:files')
  await t.eventually(`document.querySelector('#changes').textContent`, '1', 'onchange fires once')

  t.ok(await t.evaluate(`return !!byText('#stage .list-row', 'notes.pdf');`),
    'the file is listed by name')
  t.ok(await t.evaluate(`return !!byText('#stage .list-row', 'B') || !!byText('#stage .list-row', 'KB');`),
    'and by size')

  // multiple: a second drop appends rather than replacing.
  await t.evaluate(dropFiles([{ name: 'shot.png', type: 'image/png', bytes: 8 }]))
  await t.eventually(`document.querySelector('#names').textContent`, 'notes.pdf,shot.png',
    'a second drop appends when multiple is set')

  // Removing is a row action, and it has to renumber: removing the FIRST of
  // two is the case an index-by-value implementation gets wrong.
  await t.evaluate(`
    const row = byText('#stage .list-row', 'notes.pdf');
    row.querySelector('.row-actions button').click();
    return true;
  `)
  await t.eventually(`document.querySelector('#names').textContent`, 'shot.png',
    'removing a row drops that file and keeps the others')

  /* ── the size guard ──────────────────────────────────────────────────── */

  await t.mount('fileupload', { maxSizeMB: 1 })
  await t.evaluate(dropFiles([{ name: 'huge.bin', type: 'application/octet-stream', bytes: 2 * 1024 * 1024 }]))

  await t.eventually(`document.querySelector('#names').textContent`, '',
    'an oversized file is not accepted')
  t.ok(await t.evaluate(`
    const err = document.querySelector('#stage .field-hint.danger');
    return !!err && err.textContent.includes('huge.bin') && err.getAttribute('role') === 'alert';
  `), 'and the refusal names the file, in a live region')

  await t.evaluate(dropFiles([{ name: 'small.txt', type: 'text/plain', bytes: 32 }]))
  await t.eventually(`document.querySelector('#names').textContent`, 'small.txt',
    'a file under the limit still goes through')
  t.ok(await t.evaluate(`return !document.querySelector('#stage .field-hint.danger');`),
    'and the previous error is cleared')
}
