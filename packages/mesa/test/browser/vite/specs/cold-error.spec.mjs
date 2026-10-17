/*
 * cold-error — a component that will not compile, on a COLD page load.
 *
 * `errors.spec` walks `handleHotUpdate`, a mid-session edit. A first load takes
 * the other route: the plugin used to serve a broken file 200 with a throw as
 * its body, so Vite had nothing to put in an overlay, and the ES module LINKER
 * rejected the importer's `default` import before a line ran. The author read
 * *does not provide an export named 'default'*, naming neither Mesa nor the
 * fault (FJS-836). `broken.html` imports `src/Broken.mesa`, an unclosed tag,
 * and the main app never does.
 */
export const name = 'cold-error — a broken component on a first load'
export const covers = ['transform-errors']

export async function run(t) {
  // The module request is the report: a 500 the page logs as a failed load.
  t.allow(/Broken\.mesa|Failed to (fetch|load)|500|Unexpected EOF/i)

  let refused = ''
  try { await t.transform('/src/Broken.mesa') } catch (e) { refused = String(e.message ?? e) }
  t.match(refused, /Unexpected EOF/, 'the dev server refuses to produce the module')

  await t.leave()
  await t.goto('/broken.html')
  const seen = await t.evaluate(`
    const t0 = Date.now();
    let el;
    for (;;) {
      el = document.querySelector('vite-error-overlay');
      if (el || Date.now() - t0 > 10000) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { present: !!el, text: (el?.shadowRoot?.textContent ?? '').slice(0, 800) };
  `)
  t.ok(seen.present, 'the overlay is on the page')
  t.match(seen.text, /Broken\.mesa/, 'naming the file')
  t.match(seen.text, /Unexpected EOF/, 'and the fault')
  t.ok(!/does not provide an export named/.test(seen.text), 'not the linker report the author used to get')
  t.ok(!(await t.errors()).some((e) => /does not provide an export named/.test(e)),
    'and nothing on the console tells the author their own import is wrong')
}
