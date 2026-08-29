/*
 * last-run.spec.mjs — does it pass, not just is it running.
 *
 * `tests/children.test.js` covers the record through the `spawnFn` seam. What
 * it cannot answer is whether the page ever shows it: the badge only appears on
 * a poll AFTER a process this page started has finished, and a record nobody
 * renders is the same as no record.
 *
 * So this one runs a real row to completion. `packages/toolbelt`'s suite is the
 * one used elsewhere in this drive for the same reason — it runs, prints, exits
 * 0, needs no network and owns nothing anybody else is using.
 */
export const name = 'how the last run went'

const ROW = 'suite:packages/toolbelt'

const badge = (id, part) =>
  `document.querySelector('#dash-groups [data-id="${id}"] [${part}]')`

/** Poll the page's own state until a started row has finished, or give up. */
async function untilFinished(t, id, ms = 60_000) {
  const until = Date.now() + ms
  for (;;) {
    const done = await t.evaluate(`
      await pollState();
      const s = (await fetch('/api/state').then(r => r.json())).state[${JSON.stringify(id)}];
      return Boolean(s && s.last && !(s.pid && !s.exit));
    `)
    if (done) return true
    if (Date.now() > until) return false
    await new Promise(r => setTimeout(r, 500))
  }
}

export async function run(t) {
  /* ── before it has ever run here ──────────────────────────────────────── */

  // The state badge for a row with no port is `unknown` forever, which is the
  // whole reason this second badge exists.
  const before = await t.evaluate(`
    await pollState();
    const el = ${badge(ROW, 'data-last')};
    return { present: Boolean(el), hidden: el ? el.hidden : null };
  `)
  t.is(before.present, true, 'every row carries the badge element')
  t.is(before.hidden, true, 'and a row this page has never run shows nothing rather than "never passed"')

  /* ── run it ───────────────────────────────────────────────────────────── */

  const started = await t.evaluate(`
    const res = await fetch('/api/start/' + encodeURIComponent(${JSON.stringify(ROW)}), { method: 'POST' });
    return { status: res.status, pid: (await res.json()).pid };
  `)
  t.is(started.status, 200, 'the suite starts')

  const finished = await untilFinished(t, ROW)
  t.is(finished, true, 'and finishes within the time this drive will wait')

  /* ── the verdict, and it is a verdict ─────────────────────────────────── */

  const after = await t.evaluate(`
    await pollState();
    const el = ${badge(ROW, 'data-last')};
    const st = ${badge(ROW, 'data-state')};
    return {
      hidden: el.hidden,
      text:   el.textContent,
      tone:   el.className,
      state:  { hidden: st.hidden, text: st.textContent },
    };
  `)
  t.is(after.hidden, false, 'the badge appears once there is a run to describe')
  t.ok(/^passed · /.test(after.text), `a suite that exited 0 passed — "${after.text}"`)
  t.ok(/success/.test(after.tone), 'and it is toned as a pass rather than as neutral state')
  t.ok(/\d+(ms|s) · /.test(after.text), 'it says how long it took')
  t.ok(/ago$/.test(after.text), 'and when, because a verdict with no time on it is one nobody can date')

  // The two badges answer one fact each. A single badge saying `exited 0` had
  // to choose between *is it running* and *did it pass*, and chose the one that
  // disappears.
  t.ok(after.state.hidden || after.state.text !== after.text,
    'the state badge is not saying the same thing')

  /* ── the output outlives the process ──────────────────────────────────── */

  // Sixty lines saying why a drive failed are worth nothing if they are dropped
  // the moment it does — which is what stopping the row used to do.
  const kept = await t.evaluate(`
    await fetch('/api/stop/' + encodeURIComponent(${JSON.stringify(ROW)}), { method: 'POST' });
    const before = document.querySelectorAll('#output-lines .gui-line').length;
    await showLast(${JSON.stringify(ROW)}, 'toolbelt');
    return [...document.querySelectorAll('#output-lines .gui-line')]
      .slice(before).map(el => el.textContent).join('\\n');
  `)
  t.ok(/last run here/.test(kept), 'the kept tail can be printed after the process is gone')
  t.ok(kept.split('\n').length > 2, `and it is the output rather than an empty header (${kept.split('\n').length} lines)`)

  /* ── and the verdict survives the stop ────────────────────────────────── */

  const survived = await t.evaluate(`
    await pollState();
    const el = ${badge(ROW, 'data-last')};
    return { hidden: el.hidden, text: el.textContent };
  `)
  t.is(survived.hidden, false, 'stopping the row does not erase how its last run went')
  t.ok(/^passed/.test(survived.text), `it still reads as a pass — "${survived.text}"`)
}
