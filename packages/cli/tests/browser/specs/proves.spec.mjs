/*
 * proves.spec.mjs — what proves this change, on screen.
 *
 * `tests/proofs.test.js` covers the reader and `tests/server.test.js` the
 * endpoint. What neither can answer is whether the answer arrives somewhere a
 * person can act on it: the whole point of the panel is that a target which
 * resolved to a runnable row becomes a button, and one that did not says so
 * instead of quietly rendering as nothing.
 *
 * Every assertion here is about the RULE and not about this machine's working
 * tree. A drive that expects a dirty tree fails on a clean checkout, and one
 * that expects a clean tree fails on every machine anyone is working on.
 */
export const name = 'what proves this change'

export async function run(t) {
  const answer = await t.evaluate(`
    const body = await fetch('/api/proves').then(r => r.json());
    return { files: body.files?.length ?? 0, rows: body.rows?.length ?? 0, error: body.error ?? null };
  `)
  t.is(answer.error, null, 'the endpoint answers without an error')

  /* ── the panel agrees with the answer ─────────────────────────────────── */

  // Asserted as agreement rather than as a value: a clean tree and a dirty one
  // are both legitimate states of the machine this runs on.
  const shown = await t.evaluate(`
    await loadProves();
    return {
      hidden: document.getElementById('proves').hidden,
      note:   document.getElementById('proves-note').textContent,
      rows:   document.querySelectorAll('#proves-rows [data-proof]').length,
    };
  `)
  t.is(shown.hidden, answer.files === 0,
    answer.files === 0
      ? 'a clean tree shows no panel at all'
      : `a dirty tree shows the panel (${answer.files} file(s))`)

  if (answer.files === 0) {
    t.ok(true, 'nothing further to assert on a clean tree')
    return
  }

  t.ok(/file\(s\) changed/.test(shown.note), `the note says what it read — "${shown.note}"`)

  // Files changed and no row matching is a table that is behind, which is the
  // one thing this panel reports that nothing else does. It must still be on
  // screen saying so.
  if (answer.rows === 0) {
    t.ok(/no row of the proof table/.test(shown.note),
      'and says so when the table covers none of them')
    return
  }

  /* ── the cap names its own count ──────────────────────────────────────── */

  // A panel that quietly shows six of twenty-six reads as *these are the six*.
  const cap = await t.evaluate(`
    const more = document.getElementById('proves-more');
    return { hidden: more.hidden, label: document.getElementById('proves-more-btn').textContent };
  `)
  if (answer.rows > 6) {
    t.is(cap.hidden, false, `more rows than fit, so the count is offered (${answer.rows})`)
    t.ok(/show the other \d+/.test(cap.label), `and the button carries it — "${cap.label}"`)

    const all = await t.evaluate(`
      showAllProves();
      return {
        rows:   document.querySelectorAll('#proves-rows [data-proof]').length,
        hidden: document.getElementById('proves-more').hidden,
      };
    `)
    t.is(all.rows, answer.rows, 'and pressing it renders every one of them')
    t.is(all.hidden, true, 'with nothing left to offer')
  } else {
    t.is(cap.hidden, true, 'nothing is hidden, so no count is offered')
  }

  /* ── every row says how strongly it matched ───────────────────────────── */

  const tiers = await t.evaluate(`
    return [...document.querySelectorAll('#proves-rows [data-proof]')].map(li => ({
      tier: li.dataset.proof,
      said: li.querySelector('.text-muted')?.textContent ?? '',
    }));
  `)
  const KNOWN = ['path', 'area', 'symbol', 'package']
  t.ok(tiers.every(r => KNOWN.includes(r.tier)),
    'every row carries one of the four tiers')
  t.ok(tiers.every(r => r.said.length > 0),
    'and says in words how strongly it matched, rather than only in a data attribute')

  // Strongest first, so the top of the panel is the thing to run.
  const order = tiers.map(r => KNOWN.indexOf(r.tier))
  t.ok(order.every((n, i) => i === 0 || order[i - 1] <= n),
    `strongest match first (${tiers.map(r => r.tier).join(' → ')})`)

  /* ── a resolved target is a button, and it presses a real row ─────────── */

  // The reason the panel exists rather than a `fli proves` print-out.
  const targets = await t.evaluate(`
    const ids = new Set([...document.querySelectorAll('#dash-groups [data-id]')].map(li => li.dataset.id));
    const acts = [...document.querySelectorAll('#proves-rows .row-actions')].flatMap(d => [...d.children]);
    const runs = acts.filter(el => el.tagName === 'BUTTON' && el.textContent.startsWith('▶'));
    return {
      acts:    acts.length,
      empty:   acts.filter(el => !el.textContent.trim()).length,
      runs:    runs.length,
      pressable: runs.every(el => {
        const m = /startRow\\("([^"]+)"\\)/.exec(el.getAttribute('onclick') ?? '');
        return m && ids.has(m[1]);
      }),
    };
  `)
  t.ok(targets.acts > 0, `every matched row offers at least one target (${targets.acts})`)
  t.is(targets.empty, 0, 'and none of them renders as nothing')
  t.ok(targets.runs > 0, `at least one resolved to a row this page can press (${targets.runs})`)
  t.is(targets.pressable, true, 'and every ▶ names a row the inventory below actually lists')
}
