/*
 * errors — a component that will not compile, mid-session.
 *
 * Two shapes reach the browser by different routes and both have been wrong:
 *
 *   a PARSE throw is caught in `handleHotUpdate`, which sends Vite an `error`
 *   payload and suppresses the update — the overlay is the whole report;
 *
 *   a COLLECTED error (`analysis.errors`) does not throw, so `handleHotUpdate`
 *   lets it through and `transform` serves a module that throws on import. The
 *   plugin used to read `warnings` alone and serve the half-compiled module
 *   instead, which renders, looks right, and writes nothing back.
 *
 * The two are provoked by different source, and the difference is not
 * obvious — an unclosed `{#if}` throws (`Unexpected EOF`), while an empty
 * `$: { }` is collected. Neither is a guess: both were measured against the
 * compiler before being written here.
 *
 * Recovery is asserted as well: an editor sits at a broken file for seconds at
 * a time, and a session that cannot come back from one is a reload with extra
 * steps. Every wait is long for the reason `hmr.spec` explains — a file-watch
 * round trip is seconds.
 */
export const name = 'errors — a broken component, mid-session'
export const covers = ['transform-errors', 'handleHotUpdate-errors']

const ARRIVES = 15000

export async function run(t) {
  // The page is expected to report; the patterns are narrow so anything else
  // still fails the run.
  t.allow(/\[Mesa\]|Failed to (fetch|reload)|Unexpected EOF/i)

  await t.clickAt('#sibling')
  await t.eventually(`document.querySelector('#sibling-count').textContent`, '1',
    'the page is alive before the break')

  // An unclosed block — the compiler throws rather than collecting, so this is
  // the `handleHotUpdate` path and the overlay is the only report.
  await t.edit('src/Counter.mesa', '<p id="counter-version">v1</p>',
    '{#if true}<p id="counter-version">v1</p>')

  const overlay = await t.evaluate(`
    const t0 = Date.now();
    let el;
    for (;;) {
      el = document.querySelector('vite-error-overlay');
      if (el || Date.now() - t0 > ${ARRIVES}) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { present: !!el, text: (el?.shadowRoot?.textContent ?? '').slice(0, 400) };
  `)
  t.ok(overlay.present, 'a parse failure raises the dev overlay')
  t.match(overlay.text, /Counter\.mesa|Unexpected EOF/, 'saying what broke')

  await t.restore()
  await t.eventually(`document.querySelector('#counter-version')?.textContent`, 'v1',
    'and the session recovers when the file compiles again', ARRIVES)
  t.is(await t.boots(), 1, 'without a navigation')

  // A collected error — legal syntax the analyser refuses. This is the shape
  // that used to be served half-compiled, because the plugin read `warnings`
  // and never `analysis.errors`.
  //
  // Asserted on the overlay, the same way the parse case above is. It used to
  // read `__hmrLog` OR the overlay and then truncate the pair to 600 chars —
  // and the log alone is longer than that, so the overlay half could never be
  // reached and only the log could ever satisfy it. `[Mesa]` arrived in the log
  // because the throwing module was EVALUATED in the page; it no longer is,
  // which is the fix (FJS-836), so the OR was hiding the assertion rather than
  // widening it.
  await t.edit('src/Counter.mesa', 'let count = 0', 'let count = 0\n  $: { }')

  const collected = await t.evaluate(`
    const t0 = Date.now();
    let el;
    for (;;) {
      el = document.querySelector('vite-error-overlay');
      if (el || Date.now() - t0 > ${ARRIVES}) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { present: !!el, text: (el?.shadowRoot?.textContent ?? '').slice(0, 400) };
  `)
  t.ok(collected.present,
    'a collected compile error reaches the browser rather than being served half-compiled')
  t.match(collected.text, /Counter\.mesa/, 'naming the file')
  t.match(collected.text, /\$: \{ \}|does nothing|Mesa/, 'and the fault')
}
