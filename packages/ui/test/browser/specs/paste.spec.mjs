/*
 * paste.spec.mjs — `@frontierjs/ui/paste` and Composer's `onfiles` (FJS-D2364).
 *
 * `DataTransfer`, `ClipboardEvent` and `createImageBitmap` are the browser's,
 * and the rules are about what a paste event carries and what is called before
 * an await, so a DOM shim proves none of it. An event with items and no files,
 * or no types at all (WebKitGTK), is a stub: `DataTransfer` fills `files` from
 * every item it is given.
 */
export const name = 'paste: the files a paste carries, an image fitted, a Composer that hands them over'
export const covers = ['display/Composer']

// Runs in the page. `ev` builds the event: a real ClipboardEvent over a real
// DataTransfer, or a stub with the same reads when a spec needs the shape a
// DataTransfer will not make.
const PRELUDE = `
  const P = window.__paste;
  const file = (name, type) => new File([new Uint8Array(4)], name, { type });
  const real = (parts) => {
    const dt = new DataTransfer();
    for (const p of parts) p.text !== undefined ? dt.setData('text/plain', p.text) : dt.items.add(p.file);
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    return e;
  };
  const stub = ({ files = [], items = [], types = [], text = '' }) => {
    const e = { prevented: 0, preventDefault() { this.prevented++ },
      clipboardData: { files, items, types, getData: (t) => t === 'text/plain' ? text : '' } };
    return e;
  };
  const names = (fs) => fs.map(f => f.name + ':' + f.type).join('|');
`

export async function run(t) {
  await t.mount('paste')

  /* ── files on the event ───────────────────────────────────────────── */

  t.is(await t.evaluate(`${PRELUDE}
    const e = real([{ file: file('a.png', 'image/png') }]);
    const out = await P.pastedFiles(e);
    return names(out) + '#' + e.defaultPrevented;`),
    'a.png:image/png#true', 'a paste with files returns them and cancels the default (no text)')

  t.is(await t.evaluate(`${PRELUDE}
    const items = [{ kind: 'file', type: 'image/png', getAsFile: () => file('b.png', 'image/png') }, { kind: 'string', getAsFile: () => null }];
    const e = stub({ items, types: ['Files'] });
    return names(await P.pastedFiles(e)) + '#' + e.prevented;`),
    'b.png:image/png#1', 'items only: the kind-file items are read')

  t.is(await t.evaluate(`${PRELUDE}
    const e = real([{ text: 'hello' }, { file: file('c.png', 'image/png') }]);
    const out = await P.pastedFiles(e);
    return names(out) + '#' + e.defaultPrevented;`),
    'c.png:image/png#false', 'text plus an image: the file comes back and the text is left to paste')

  /* ── an empty event: the WebKitGTK case ───────────────────────────── */

  t.is(await t.evaluate(`${PRELUDE}
    let reads = 0, sync = null;
    const e = stub({});
    const p = P.pastedFiles(e, { read: async () => { reads++; return [file('d.png', 'image/png')] } });
    sync = e.prevented;
    return names(await p) + '#' + reads + '#' + sync;`),
    'd.png:image/png#1#1', 'an empty event calls the host read, and cancels before the first await')

  t.is(await t.evaluate(`${PRELUDE}
    let reads = 0;
    const e = stub({ types: ['text/plain'], text: 'just words' });
    const out = await P.pastedFiles(e, { read: async () => { reads++; return [file('x.png', 'image/png')] } });
    return out.length + '#' + reads + '#' + e.prevented;`),
    '0#0#0', 'an empty event that has text never reads, and does not cancel')

  t.is(await t.evaluate(`${PRELUDE}
    let reads = 0;
    const e = stub({ text: 'words by getData only' });
    const out = await P.pastedFiles(e, { read: async () => { reads++; return [] } });
    return out.length + '#' + reads + '#' + e.prevented;`),
    '0#0#0', 'text reachable only through getData counts as text')

  t.is(await t.evaluate(`${PRELUDE}
    try { await P.pastedFiles(stub({}), { read: async () => { throw new Error('clipboard refused') } }); return 'swallowed' }
    catch (e) { return e.message }`),
    'clipboard refused', 'a refused read throws')

  /* ── fitImage ─────────────────────────────────────────────────────── */

  const fit = await t.evaluate(`${PRELUDE}
    const c = document.createElement('canvas');
    c.width = 400; c.height = 200;
    const g = c.getContext('2d');
    for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) { g.fillStyle = 'rgb(' + ((x * 7 + y * 13) % 256) + ',' + ((x * 3) % 256) + ',' + ((y * 11) % 256) + ')'; g.fillRect(x, y, 1, 1) }
    const src = await new Promise(r => c.toBlob(r, 'image/png'));
    const dims = async (b) => { const m = await createImageBitmap(b); const d = m.width + 'x' + m.height; m.close(); return d };
    const big   = await P.fitImage(src, { edge: 100, maxBytes: 1e7 });
    const small = await P.fitImage(src, { edge: 100, maxBytes: 100 });
    const same  = await P.fitImage(src, { edge: 1000, maxBytes: 1e7 });
    return { big: big.type, bigDims: await dims(big), small: small.type, smallDims: await dims(small), sameDims: await dims(same) };`)
  t.is(fit.big, 'image/png', 'a PNG under maxBytes stays a PNG')
  t.is(fit.bigDims, '100x50', 'scaled to edge on the long side')
  t.is(fit.small, 'image/jpeg', 'a PNG over maxBytes is re-encoded as a JPEG')
  t.is(fit.smallDims, '100x50', 'the JPEG is the same size')
  t.is(fit.sameDims, '400x200', 'an image under edge is never scaled up')

  /* ── Composer onfiles ─────────────────────────────────────────────── */

  const pasteInto = (sel, file) => `${PRELUDE}
    const e = real([{ file: file('${file}', 'image/png') }]);
    document.querySelector('${sel} textarea').dispatchEvent(e);
    return e.defaultPrevented;`
  t.is(await t.evaluate(pasteInto('#box', 'p.png')), true, 'a paste in the box with onfiles is taken over')
  await t.eventually(`document.querySelector('#got').textContent`, 'p.png:image/png', 'onfiles received the pasted file')

  t.is(await t.evaluate(pasteInto('#plain', 'q.png')), false, 'with no onfiles the box does not cancel a paste')
  await t.evaluate(`return new Promise(r => setTimeout(r, 50))`)
  t.is(await t.evaluate(`return document.querySelector('#got').textContent`), 'p.png:image/png', 'and hands nothing over')

  t.is(await t.evaluate(`${PRELUDE}
    const dt = new DataTransfer(); dt.items.add(file('r.png', 'image/png'));
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('#box textarea').dispatchEvent(e);
    return e.defaultPrevented;`), true, 'a drop on the box is taken')
  await t.eventually(`document.querySelector('#got').textContent`, 'p.png:image/png|r.png:image/png', 'onfiles received the dropped file')

  // A refused read arrives as onfiles([], error). Chrome with no permission
  // granted rejects navigator.clipboard.read() for a synthetic, untrusted event.
  await t.evaluate(`${PRELUDE}
    document.querySelector('#box textarea').dispatchEvent(stub === undefined ? null : new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true }));
    return true;`)
  await t.eventually(`document.querySelector('#err').textContent.length > 0`, true, 'a refused clipboard read reaches onfiles as an error')
}
