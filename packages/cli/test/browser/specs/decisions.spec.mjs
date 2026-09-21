/*
 * decisions.spec.mjs — waiting on you, on screen.
 *
 * `test/decisions.test.js` covers the reader and the writer, and
 * `test/server.test.js` the endpoints. What neither can answer is the panel:
 * that a question's options arrive as buttons with the recommendation marked,
 * that a pick against it asks for a reason, and that pressing *rule* sends the
 * pick the page shows.
 *
 * This drive runs against the repo's own registers, so it must never write one.
 * The panel is handed a question in the page and `/api/decide` is answered in
 * the page too — the send is asserted and nothing leaves the browser.
 */
export const name = 'waiting on you'

export async function run(t) {
  const answer = await t.evaluate(`
    const body = await fetch('/api/decisions').then(r => r.json());
    await loadDecisions();
    return {
      error: body.error ?? null, decidable: body.decidable.length,
      sections: body.sections.length,
      hidden: document.getElementById('decisions').hidden,
    };
  `)
  t.is(answer.error, null, 'the endpoint answers without an error')
  t.ok(answer.sections > 0, `the ruling sections are offered (${answer.sections})`)
  t.is(answer.hidden, answer.decidable === 0,
    answer.decidable === 0 ? 'nothing to pick hides the panel' : `something to pick shows it (${answer.decidable})`)

  /* ── one question, drawn ──────────────────────────────────────────────── */

  // The dashboard's own load can land after this and redraw the real, empty
  // queue over the question drawn here, so the loader is held for the rest.
  const drawn = await t.evaluate(`
    window.loadDecisions = async () => {};
    decisionsBody = {
      decidable: [{
        id: 'views:omit', question: 'Omit encrypted columns?', file: 'IDEAS/views.md', line: 9,
        options: [{ letter: 'A', text: 'omit them' }, { letter: 'B', text: 'expose them' }],
        recommend: { letter: 'A', why: 'nothing leaks' },
      }],
      open: [], ruled: 0, sections: ['Access control', 'Repo conventions'],
    };
    renderDecisions();
    const row = document.querySelector('[data-decision="views:omit"]');
    return {
      options:  [...row.querySelectorAll('[data-option]')].map(b => b.dataset.option),
      pressed:  row.querySelector('[aria-pressed="true"]')?.dataset.option ?? null,
      badge:    row.querySelector('[data-option="A"] .badge')?.textContent ?? null,
      placeholder: document.getElementById('decision-why-0').placeholder,
    };
  `)
  t.is(drawn.options.join(','), 'A,B', 'each option is a button')
  t.is(drawn.pressed, 'A', 'the recommendation is the pick until somebody changes it')
  t.is(drawn.badge, 'recommended', 'and it is marked')
  t.ok(/optional/.test(drawn.placeholder), 'following it asks for no reason')

  /* ── a pick against it ────────────────────────────────────────────────── */

  const against = await t.evaluate(`
    document.getElementById('decision-why-0').value = 'typed before the click';
    pickDecision(0, 'B');
    return {
      pressed: document.querySelector('[aria-pressed="true"]')?.dataset.option ?? null,
      placeholder: document.getElementById('decision-why-0').placeholder,
      kept: document.getElementById('decision-why-0').value,
    };
  `)
  t.is(against.pressed, 'B', 'a click moves the pick')
  t.ok(/required/.test(against.placeholder), 'and against the recommendation the reason is asked for')
  t.is(against.kept, 'typed before the click', 'a reason already typed survives the re-render')

  /* ── the send ─────────────────────────────────────────────────────────── */

  const sent = await t.evaluate(`
    const real = window.fetch;
    let posted = null;
    window.fetch = async (url, init) => {
      if (String(url).endsWith('/api/decide')) {
        posted = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: false, reason: 'held in the page' }), { status: 400 });
      }
      return real(url, init);
    };
    document.getElementById('decision-section-0').value = 'Repo conventions';
    await ruleDecision(0);
    window.fetch = real;
    return { posted, result: document.getElementById('decision-result-0').textContent };
  `)
  t.is(sent.posted?.id, 'views:omit', 'rule sends the question the row shows')
  t.is(sent.posted?.pick, 'B', 'with the pick on screen')
  t.is(sent.posted?.why, 'typed before the click', 'the reason typed')
  t.is(sent.posted?.section, 'Repo conventions', 'and the section chosen')
  t.ok(/held in the page/.test(sent.result), 'a refusal is shown on the row')
}
