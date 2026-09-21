/*
 * start-stop.spec.mjs — starting a row, and refusing to stop one this page did
 * not start.
 *
 * The refusal is the half worth driving in a browser. Everything else here can
 * be asserted over HTTP; what cannot is whether a person looking at a row that
 * is answering can tell WHY there is no stop button under it — and *no button*
 * and *a button that does nothing* look identical from the outside.
 */
export const name = 'starting a row, and the stop this page will not offer'

const ROW = 'suite:packages/toolbelt'   // a real suite: it runs, prints, and exits

const sel = (id, part) =>
  `document.querySelector('#dash-groups [data-id="${id}"] [${part}]')`

export async function run(t) {
  /* ── before: start is offered, stop is not ────────────────────────────── */

  t.is(await t.evaluate(`return ${sel(ROW, 'data-start')}.hidden;`), false,
    'a row that is not running here offers start')
  t.is(await t.evaluate(`return ${sel(ROW, 'data-stop')}.hidden;`), true,
    'and offers no stop, because there is nothing of ours to stop')

  /* ── start it ─────────────────────────────────────────────────────────── */

  const started = await t.evaluate(`
    const res  = await fetch('/api/start/' + encodeURIComponent(${JSON.stringify(ROW)}), { method: 'POST' });
    const body = await res.json();
    return { status: res.status, pid: body.pid };
  `)
  t.is(started.status, 200, 'the server starts it')
  t.ok(started.pid > 0, `and answers the pid it started (${started.pid})`)

  // The page has to see it on its own poll rather than because the click
  // painted it — a button that repaints optimistically and a page that is
  // reading real state look the same until the process dies.
  await t.evaluate(`return await pollState();`)
  t.is(await t.evaluate(`return ${sel(ROW, 'data-stop')}.hidden;`), false,
    'the next poll offers stop, because this page owns the process')

  /* ── the refusal ──────────────────────────────────────────────────────── */

  // Stop it at the server, so the page's own table no longer holds it, and ask
  // again: the answer must be the sentence, not a 200.
  const refused = await t.evaluate(`
    await fetch('/api/stop/' + encodeURIComponent(${JSON.stringify(ROW)}), { method: 'POST' });
    const res  = await fetch('/api/stop/' + encodeURIComponent(${JSON.stringify(ROW)}), { method: 'POST' });
    return { status: res.status, error: (await res.json()).error };
  `)
  t.is(refused.status, 409, 'stopping one this page did not start is refused')
  t.ok(/not started here/.test(refused.error), `and the refusal says why — "${refused.error}"`)

  /* ── a row that is up and is not ours ─────────────────────────────────── */

  // The state the design is arranged around: something is answering on the
  // port and this page has no business killing it. It must SAY so rather than
  // simply having no button, which reads as a missing feature.
  await t.evaluate(`return await pollState();`)
  const foreign = await t.evaluate(`
    const rows = [...document.querySelectorAll('#dash-groups [data-id]')];
    const up = rows.find(li => li.querySelector('[data-state]')?.textContent === 'answering'
                            && li.querySelector('[data-stop]'));
    if (!up) return { skipped: true };
    return {
      stopHidden: up.querySelector('[data-stop]').hidden,
      note:       up.querySelector('[data-foreign]')?.textContent ?? null,
      id:         up.dataset.id,
    };
  `)
  if (foreign.skipped) {
    t.ok(true, 'nothing foreign is answering on this machine — nothing to assert')
  } else {
    t.is(foreign.stopHidden, true, `${foreign.id} is answering and offers no stop`)
    t.is(foreign.note, 'started elsewhere', 'and the row says why, rather than being silently button-less')
  }

  /* ── a row this page cannot start is refused by name ──────────────────── */

  // A snapshot generator resolves through its own package rather than off
  // PATH, so this page does not spawn one — and the refusal hands over the
  // line to type instead of failing quietly.
  const notOurs = await t.evaluate(`
    const li = [...document.querySelectorAll('#dash-groups [data-id]')]
      .find(el => el.dataset.id.startsWith('snapshot:'));
    const res  = await fetch('/api/start/' + encodeURIComponent(li.dataset.id), { method: 'POST' });
    return { status: res.status, error: (await res.json()).error };
  `)
  t.is(notOurs.status, 400, 'a generator this page does not run is refused')
  t.ok(/Run it yourself: cd /.test(notOurs.error),
    `and the refusal is the command to type — "${notOurs.error}"`)
}
