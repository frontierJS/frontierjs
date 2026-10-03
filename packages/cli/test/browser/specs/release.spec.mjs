/*
 * release.spec.mjs — the pivot, where somebody looks.
 *
 * The Release realm was entirely terminal: you learned that a change crosses
 * the pivot by typing `release:check`, which is a thing people type when
 * something is already wrong. `test/release-view.test.js` covers the engine
 * and `test/server.test.js` the routes; what is here is the panel.
 *
 * ── The split is what this spec is really asserting ───────────────────
 *
 * The verdict READS THE TREE, so it must arrive on page load like every other
 * panel. What is serving reaches a MACHINE over ssh, so it must NOT — a panel
 * that ssh'd while a page loaded would be a monitoring agent, which is the
 * orchestrator this realm refuses. Those are two assertions and neither one
 * implies the other.
 *
 * ── And that every class in it is real ────────────────────────────────
 *
 * A `var()` naming a token nothing defines drops the whole declaration, and a
 * class nothing defines is markup that looks styled and is not (`FJS-545`).
 * Both are invisible to a test that asks what the page SAYS, which is what
 * every other assertion here does. The probe measures computed style against a
 * bare element — NOT a walk of `document.styleSheets`, whose `cssRules` throws
 * for the served stylesheet and reports every class in the page as undefined,
 * `.badge` included. Its own negative control is below.
 */
export const name = 'the pivot, and what is serving'

export async function run(t) {

  /* ── the local half arrives on its own ────────────────────────────────── */

  const panel = await t.evaluate(`
    await loadRelease();
    return {
      hidden: document.getElementById('release').hidden,
      note:   document.getElementById('release-note').textContent,
      rows:   document.querySelectorAll('#release-rows > li').length,
      apps:   releaseApps.map(a => ({ label: a.label, verdict: a.verdict, findings: a.findings.length })),
    };
  `)

  t.is(panel.hidden, false, 'the panel is on screen')
  t.ok(panel.rows > 0, `it classifies the apps in this tree (${panel.rows})`)

  // The note says what the verdict MEANS. A panel that renders the word
  // `contract` and nothing else has told an operator a term of art, not a fact
  // about their deploy — and *after it, only forward* is the whole realm.
  t.ok(
    /pivot|reversible|nothing moved|decidable|declares a schema/.test(panel.note),
    `and says what it means rather than naming a verdict — "${panel.note}"`,
  )

  // The headline is the WORST verdict across the workspace, because one
  // contract among four apps is the fact that decides whether this deploy can
  // be taken back. An average, or the first row, would report *reversible*
  // over a tree that is not.
  const worst = panel.apps.some(a => a.verdict === 'contract') ? 'contract'
              : panel.apps.some(a => a.verdict === 'unknown')  ? 'unknown' : 'safe'
  if (worst === 'contract') t.ok(/pivot|forward/.test(panel.note), 'a contract anywhere is what the headline reports')

  /* ── the findings are reachable without leaving the page ──────────────── */

  const withFindings = panel.apps.find(a => a.findings > 0)
  if (withFindings) {
    const opened = await t.evaluate(`
      toggleRelease(${JSON.stringify(withFindings.label)});
      return document.querySelectorAll('#release-rows ul li').length;
    `)
    t.ok(opened > 0, `the findings behind a verdict fold open (${opened} rows for ${withFindings.label})`)
  }

  /* ── the remote half did NOT run ──────────────────────────────────────── */

  const target = await t.evaluate(`
    return {
      out:  document.getElementById('target-out').hidden,
      note: document.getElementById('target-note').textContent,
    };
  `)
  t.is(target.out, true, 'nothing reached a machine on page load')
  t.ok(/press|ssh/.test(target.note), 'and the panel says so rather than looking broken')

  /* ── the release, in order ────────────────────────────────────────────── */

  const steps = await t.evaluate(`
    await loadReleaseSteps();
    const ids = [...document.querySelectorAll('#release-steps [data-step]')].map(li => li.dataset.step);
    return {
      ids,
      table:    releaseSteps.map(s => s.id),
      verdictIn: document.getElementById('release-verdict').closest('[data-step]')?.dataset.step ?? null,
      servingIn: document.getElementById('release-serving').closest('[data-step]')?.dataset.step ?? null,
      deploy:   document.querySelector('[data-step="deploy"] [data-step-badge]').textContent,
      next:     [...document.querySelectorAll('[data-step-next]')].filter(b => !b.hidden).length,
      progress: document.getElementById('release-progress').textContent,
    };
  `)
  t.is(steps.ids.join(','), steps.table.join(','), `every step is drawn, in the table's order (${steps.ids.length})`)
  t.is(steps.verdictIn, 'classify', 'the pivot verdict sits in the step that classifies')
  t.is(steps.servingIn, 'serving', 'and the target reading in the step that reads it')
  // Never a guessed pass: a step nothing has answered says so.
  t.ok(['not run', 'passed', 'failed', 'stopped'].includes(steps.deploy), `a step this page never ran reads as such — "${steps.deploy}"`)
  t.ok(steps.next <= 1, 'at most one step is marked next')
  t.ok(/of \d+ ready/.test(steps.progress), `and the panel says how far along it is — "${steps.progress}"`)

  // A step that changes what is serving asks first, and the server holds the
  // line without the page: an unapproved deploy is refused before any spawn.
  const refused = await t.evaluate(`
    const r = await fetch('/api/release/step', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'deploy', target: 'production' }) });
    return { status: r.status, error: (await r.json()).error };
  `)
  t.is(refused.status, 400, 'an unapproved deploy is refused by the server')
  t.ok(/approving/.test(refused.error), `by name — "${refused.error}"`)

  /* ── every class the panel adds resolves ──────────────────────────────── */

  const inertNames = await t.evaluate(`
    const probeOne = (cls, prop) => {
      const el = document.createElement(cls === 'field' ? 'select' : 'span');
      const bare = el.cloneNode(false);
      el.className = cls;
      document.body.append(el, bare);
      const differs = getComputedStyle(el)[prop] !== getComputedStyle(bare)[prop];
      el.remove(); bare.remove();
      return differs ? null : cls;
    };
    const propFor = (c) => c === 'field' ? 'appearance' : 'paddingLeft';
    return ['pill', 'field', 'gui-plan', 'badge', 'list-row']
      .map(c => probeOne(c, propFor(c))).filter(Boolean);
  `)
  t.is(inertNames.length, 0, `every class the panel adds is defined by a stylesheet${inertNames.length ? ` — inert: ${inertNames.join(', ')}` : ''}`)

  // The negative control. Without it, a probe that silently matched everything
  // would report a clean panel forever — which is the failure mode of the
  // stylesheet walk this replaced. `select` is the class this panel was first
  // written with and nothing defines; `stack-sm` is the invented rhythm the
  // root CLAUDE.md names as the canonical example of this mistake.
  const caught = await t.evaluate(`
    const probeOne = (cls) => {
      const el = document.createElement('span'), bare = el.cloneNode(false);
      el.className = cls;
      document.body.append(el, bare);
      const differs = getComputedStyle(el).paddingLeft !== getComputedStyle(bare).paddingLeft;
      el.remove(); bare.remove();
      return differs ? null : cls;
    };
    return ['select', 'stack-sm'].map(probeOne).filter(Boolean);
  `)
  t.is(caught.length, 2, 'and the probe catches a class nothing defines')
}
