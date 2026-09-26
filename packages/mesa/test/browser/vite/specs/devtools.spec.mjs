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

    // ── a cause, across the same channel ──────────────────────────────
    //
    // A click in the app re-runs the render reading the value it wrote; the
    // panel's Runs tab has to name that write as the cause (FJS-1324). The
    // runtime drive's devtools-cause spec grades the chain itself; this one
    // grades that the panel is fed it.
    await t.clickAt('#sibling')
    await t.eventually(`document.querySelector('#sibling-count').textContent`, '1', 'the app re-rendered')

    const cause = await panel.evaluate(`
      document.querySelector('.tab[data-tab="runs"]').click();
      const t0 = Date.now();
      let rows = [];
      for (;;) {
        rows = [...document.querySelectorAll('#panel-runs .run-row')].map(el => el.textContent.replace(/\\s+/g, ' ').trim());
        if (rows.some(r => r.includes('n = 1')) || Date.now() - t0 > 8000) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return rows;
    `)
    t.ok(cause.some((r) => r.includes('Sibling') && r.includes('n = 1')),
      `the Runs tab names the write that woke Sibling's render — ${JSON.stringify(cause.slice(0, 3))}`)

    // ── a read nothing watches, marked static ─────────────────────────
    //
    // Stored reads an imported object with no $: beside it, in the template
    // and in a const. Both render once and never again (VISION RULE 44), and
    // the panel is where somebody asks why: the compiler's list has to reach
    // the component's table (FJS-1340).
    const statics = await panel.evaluate(`
      document.querySelector('.tab[data-tab="signals"]').click();
      const item = [...document.querySelectorAll('#comp-list > *')].find(el => el.textContent.includes('Stored'));
      if (!item) return null;
      item.click();
      const t0 = Date.now();
      let rows = [];
      for (;;) {
        rows = [...document.querySelectorAll('#panel-signals .static-row')].map(el => el.textContent.replace(/\\s+/g, ' ').trim());
        if (rows.length || Date.now() - t0 > 4000) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return rows;
    `)
    t.ok(statics !== null, 'the component reading the store is listed')
    t.ok((statics ?? []).some((r) => r.includes('shelf.count') && r.includes('template')),
      `its template read is marked static — ${JSON.stringify(statics)}`)
    t.ok((statics ?? []).some((r) => r.includes('const doubled')),
      'and so is the const built from it, which the template reads as a local')
    t.ok((statics ?? []).length > 0 && statics.every((r) => r.includes('$: shelf.count')),
      'each row names the watch that would track it')
  } finally {
    await panel.close()
  }
}
