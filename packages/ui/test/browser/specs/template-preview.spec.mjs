/*
 * template-preview.spec.mjs — TemplatePreview, a stored template as its
 * reader gets it.
 *
 * What only a browser can say is that the body is still isolated once it has
 * been filled: the catalog's example is escaped into the HTML and the script
 * the template carries runs nowhere. The sms rows hold the segment arithmetic
 * at its three edges — 160/161 septets, UCS-2 and the extension table.
 */
export const name = 'TemplatePreview'
export const covers = ['display/TemplatePreview']

export async function run(t) {
  await t.mount('template-preview')
  await t.evaluate(`return new Promise(r => setTimeout(r, 300))`)

  const q = (sel, prop) => t.evaluate(`
    const el = document.querySelector(${JSON.stringify(sel)});
    return el ? ${prop} : null;
  `)

  /* ── email: subject, html body, text part ─────────────────────────────── */

  t.is(await q('#email .fjs-template-preview-subject strong', 'el.textContent'), 'Hi Ada <b>Lovelace</b>',
    'the subject is text: the example is filled and not escaped')
  const srcdoc = await q('#email iframe', 'el.getAttribute("srcdoc")')
  t.ok(srcdoc.includes('<p>Dear Ada &lt;b&gt;Lovelace&lt;/b&gt;</p>'), 'the body is HTML: the example is escaped into it')
  t.ok(srcdoc.includes('<p>ex</p>'), 'the catalog example fills a field the record would')
  t.is(await q('#email iframe', 'el.getAttribute("sandbox")'), '', 'the body frame grants no sandbox token')
  t.is(await q('#email .fjs-template-preview-text', 'el.textContent'), 'Plain Ada <b>Lovelace</b>',
    'the plain-text part is filled as text')
  t.is(await t.evaluate(`return window.__heard.length`), 0, 'the template\'s script ran nowhere')

  /* ── a record stands over the examples, a default under a blank ───────── */

  const rec = await q('#record iframe', 'el.getAttribute("srcdoc")')
  t.ok(rec.includes('<p>Dear Grace</p>'), 'data replaces the catalog example')
  t.ok(rec.includes('<p>No note</p>'), 'a blank value falls to the declared default')
  t.is(await q('#record .fjs-template-preview-text', 'el.textContent'), null, 'a page has no text part')

  /* ── sms: a text and its segments ─────────────────────────────────────── */

  t.is(await q('#sms .fjs-template-preview-text', 'el.textContent'), 'Hi Ada <b>Lovelace</b>', 'an sms is filled as text')
  t.is(await q('#sms iframe', '1'), null, 'an sms draws no frame')
  const count = (id) => q(`#${id} .fjs-template-preview-count`, 'el.textContent.replace(/\\s+/g, " ").trim()')
  t.is(await count('sms'), '22 septets · 1 segment · GSM-7', 'a short GSM text is one segment')
  t.is(await count('sms-long'), '161 septets · 2 segments · GSM-7', '161 septets spill into a second segment')
  t.is(await count('sms-unicode'), '7 characters · 1 segment · UCS-2', 'a character outside GSM-7 sends the text as UCS-2')
  t.is(await count('sms-ext'), '162 septets · 2 segments · GSM-7', 'an extension-table character costs two septets')
}
