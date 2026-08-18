/*
 * devtools — the panel's own JavaScript, executed.
 *
 * `/__mesa/devtools` is 18 KB of hand-written HTML and script that nothing had
 * ever loaded. The route being served is asserted in `vite-devtools.test.js`;
 * whether the page it serves boots is a different question, and the answer to
 * it was unknown (`FJS-024`).
 *
 * The relay is a `BroadcastChannel`, which cannot be asked of one page:
 * same-origin and cross-document by definition, so a single tab posts and
 * never hears itself. So this opens a second target — the app in one, the
 * panel in the other, which is how a developer actually uses it — and asserts
 * that a mount in the app arrives in the panel.
 */
export const name = 'devtools — the panel boots'
export const covers = ['devtools-route', 'devtools-panel']

export async function run(t) {
  await t.goto('/__mesa/devtools')

  const page = await t.evaluate(`
    return {
      title:  document.title,
      nodes:  document.body.querySelectorAll('*').length,
      scripts: document.querySelectorAll('script').length,
      channel: typeof BroadcastChannel,
    };
  `)
  t.ok(page.nodes > 20, 'the panel rendered its own markup')
  t.ok(page.scripts > 0, 'and carries script of its own')
  t.match(page.title, /mesa|devtools/i, 'and is the panel rather than the app')

  // The panel's script running to completion is the thing that was never
  // known. Anything it threw is on the page's error channel, which the drive
  // reports for this spec — so an empty assertion list here would still catch
  // it; this one names what a working panel must have reached.
  t.is(page.channel, 'function', 'BroadcastChannel is available to the relay')

  // ── the relay, across two tabs ──────────────────────────────────────
  //
  // Back to the app in this tab, panel in the second. The panel asks for a
  // snapshot as soon as it opens and again on `online`, and the app's injected
  // client answers off `window.__MESA_DEV__` — so a component the app has
  // mounted has to appear in the panel's sidebar without anything else
  // happening.
  await t.goto('/', 'window.__appReady')

  const panel = await t.openTab('/__mesa/devtools',
    `!!document.getElementById('status-dot')`)

  try {
    const seen = await panel.evaluate(`
      const t0 = Date.now();
      let rows = [];
      for (;;) {
        // #comp-list is the sidebar's list; until the app answers it holds one
        // .empty-sidebar placeholder, which is not a component. (No backticks
        // in here — this whole probe is a template literal.)
        rows = [...document.querySelectorAll('#comp-list > *')]
          .filter(el => !el.classList.contains('empty-sidebar'))
          .map(el => el.textContent.trim());
        if (rows.length || Date.now() - t0 > 8000) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return {
        rows,
        online: document.getElementById('status-dot')?.classList.contains('online') ?? false,
      };
    `)
    t.ok(seen.online, 'the panel went online — the app answered across the channel')
    t.ok(seen.rows.length > 0, `and the app's components reached it (${seen.rows.length})`)
    t.ok(seen.rows.join(' ').includes('Counter') || seen.rows.join(' ').includes('App'),
      `naming what the app mounted — ${JSON.stringify(seen.rows.slice(0, 4))}`)
  } finally {
    await panel.close()
  }
}
