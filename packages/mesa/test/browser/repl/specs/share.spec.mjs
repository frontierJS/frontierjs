/*
 * share — a link that carries the code, and the standalone export.
 *
 * The share hash is `JSON → LZString.compressToEncodedURIComponent → #s=…`,
 * and the only assertion worth making about a codec is the ROUND TRIP through
 * a real navigation: encoding alone proves nothing, and a stub on either side
 * would agree with itself. That is also why lz-string wants vendoring rather
 * than stubbing when the CDNs go (`FJS-326`).
 *
 * Nothing the REPL defines is reachable from the page's global scope — it is
 * all inside one module script — so this drives the button rather than calling
 * `encodeState`. That is the better test anyway: `copyShareLink` writes the
 * hash with `replaceState` BEFORE it touches the clipboard, so the assertion
 * needs no clipboard permission and still covers the path a user takes.
 *
 * The buffer is changed by loading a different example rather than by typing:
 * the editor is CodeMirror with `closeBrackets` on, so typed source is not the
 * source that arrives.
 */
export const name = 'repl — share link and standalone export'
export const covers = ['repl-share-hash', 'repl-standalone']

export async function run(t) {
  // Load something that is not the default, so finding it after a navigation
  // means the hash carried it and nothing else did.
  const started = await t.evaluate(`
    return { preview: document.getElementById('pv-container').textContent.trim().slice(0, 160) };
  `)

  await t.clickAt('#ex-btn')
  await t.evaluate(`return await window.waitVisible('#ex-drawer');`)
  await t.evaluate(`return await window.waitSettled('#ex-drawer');`)

  const chosen = await t.evaluate(`
    const items = [...document.querySelectorAll('#ex-drawer-body .ex-item')];
    const el = items.find(e => !e.classList.contains('active'));
    if (!el) throw new Error('every example is the active one');
    el.id = 'repl-share-pick';
    return { key: el.dataset.key };
  `)
  await t.clickAt('#repl-share-pick')

  // On the PREVIEW, not on `#pvlbl` — the status already said "running" before
  // the click, so waiting on it captures the example being replaced.
  await t.eventually(
    `document.getElementById('pv-container').textContent.trim().slice(0, 160) !== ${JSON.stringify(started.preview)}`,
    'true', `a second example is loaded (${chosen.key})`, 8000)

  const loaded = await t.evaluate(`
    return { preview: document.getElementById('pv-container').textContent.trim().slice(0, 160) };
  `)

  await t.clickAt('#share-btn')
  const shared = await t.evaluate(`
    await new Promise(r => setTimeout(r, 300));
    return { hash: location.hash };
  `)
  t.match(shared.hash, /^#s=.+/, 'Share writes a state hash into the URL')

  // The round trip. A fresh navigation re-reads the hash, decodes it and
  // compiles what it found.
  await t.open(shared.hash)
  const restored = await t.evaluate(`
    return { preview: document.getElementById('pv-container').textContent.trim().slice(0, 160),
             status:  document.getElementById('pvlbl').textContent };
  `)
  t.is(restored.preview, loaded.preview,
    'and opening the link restores that code, compiled and mounted')
  t.ok(!/error|failed/i.test(restored.status), `with no error (${restored.status})`)

  await t.open()

  // *Open standalone* fetches the runtime as source text to inline it into a
  // blob. The path is relative to the PAGE, so `./runtime.js` resolved inside
  // `example/` — where no such file exists, and there is none at the package
  // root either. Asserted as a fetch rather than by clicking, because the
  // button opens a tab this drive is not attached to.
  const runtime = await t.evaluate(`
    const r = await fetch('../src/runtime.js');
    return { status: r.status, len: r.ok ? (await r.text()).length : 0 };
  `)
  t.is(runtime.status, 200, 'the runtime the standalone export inlines is fetchable')
  t.ok(runtime.len > 1000, 'and is the runtime rather than an error page')
}
