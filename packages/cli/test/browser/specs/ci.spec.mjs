/*
 * ci.spec.mjs — the CI run log, on screen.
 *
 * `test/ci-log.test.js` covers the log and the counts, `test/server.test.js`
 * the endpoint. What is here is that the panel draws them: the repo's own log
 * first, then a scripted body for the states a real log cannot be made to hold
 * on demand — a run in the middle of a suite, a suite that ran zero tests, a
 * count that covers only part of its script.
 */
export const name = 'ci'

const NOW = 1_800_000_000_000

const SCRIPTED = {
  available: true,
  now: NOW,
  active: {
    id: 'live', at: NOW - 90_000, lastAt: NOW - 1000, status: 'running', ms: null, scope: 'full', argv: [],
    planned: ['hygiene', 'tests'], done: 1, phase: 'tests', phaseAt: NOW - 60_000,
    current: { phase: 'tests', key: 'packages/b', at: NOW - 20_000 }, failures: [], commit: 'abc1234', dirty: true,
  },
  selected: {
    id: 'live', status: 'running', argv: [], notes: ['registry offline — skipped'],
    phases: [
      { name: 'hygiene', at: NOW - 90_000, ms: 30_000, ok: true, steps: [] },
      { name: 'tests', at: NOW - 60_000, ms: null, ok: null, steps: [
        { key: 'packages/a', status: 'ok', label: 'packages/a', ms: 40_000, counts: { pass: 0, fail: 0, skip: 0, partial: false, failed: [] }, at: NOW - 20_000 },
      ] },
    ],
  },
  usualRunMs: 300_000,
  usual: { hygiene: 28_000, tests: 200_000 },
  latest: [
    { kind: 'phase', phase: 'hygiene', key: 'hygiene', status: 'ok', ms: 28_000, at: NOW - 3_600_000, commit: 'old', scope: 'full', usualMs: 28_000 },
    { kind: 'phase', phase: 'tests', key: 'tests', status: 'fail', ms: 200_000, at: NOW - 3_600_000, commit: 'old', scope: 'full', usualMs: 200_000 },
    { kind: 'step', phase: 'tests', key: 'packages/a', status: 'ok', ms: 30_000, at: NOW - 3_600_000, commit: 'old', scope: 'full', usualMs: 30_000,
      counts: { pass: 10, fail: 0, skip: 0, partial: false, failed: [] } },
    { kind: 'step', phase: 'tests', key: 'packages/b', status: 'fail', ms: 50_000, at: NOW - 3_600_000, commit: 'old', scope: 'full', usualMs: 5_000,
      label: 'packages/b test exited 1', counts: { pass: 7, fail: 2, skip: 0, partial: true, failed: ['grp > breaks'] } },
  ],
  lastFull: { id: 'old', at: NOW - 3_600_000, status: 'failed' },
  runs: [],
  phases: ['hygiene', 'tests'],
}

export async function run(t) {
  const real = await t.evaluate(`
    const body = await fetch('/api/ci').then(r => r.json());
    await loadCi();
    return {
      available: body.available,
      phases: body.phases,
      hidden: document.getElementById('ci').hidden,
      rows: [...document.querySelectorAll('#ci-rows [data-ci-phase]')].map(li => li.dataset.ciPhase),
    };
  `)
  t.is(real.available, true, 'the workspace has scripts/ci.mjs, so the panel is available')
  t.is(real.hidden, false, 'and on screen')
  t.ok(real.phases.every(p => real.rows.includes(p)), `every phase the log knows is a row (${real.rows.length})`)

  const drawn = await t.evaluate(`
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => String(url).endsWith('/api/ci')
      ? new Response(JSON.stringify(${JSON.stringify(SCRIPTED)}))
      : realFetch(url, opts);
    try {
      ciOpen.clear();
      await loadCi();
      toggleCiPhase('tests');
      const row = name => document.querySelector('#ci-rows [data-ci-phase="' + name + '"]');
      const step = key => row('tests').querySelector('[data-ci-step="' + key + '"]');
      return {
        live:      document.getElementById('ci-live').hidden ? null : document.getElementById('ci-live').textContent,
        stop:      document.getElementById('ci-stop').hidden,
        fullOff:   document.getElementById('ci-full').disabled,
        hygiene:   row('hygiene').querySelector('.badge').textContent,
        hygieneFrom: row('hygiene').textContent,
        tests:     row('tests').querySelector('.badge').textContent,
        zero:      step('packages/a')?.textContent ?? null,
        partial:   step('packages/b')?.textContent ?? null,
        rerunOff:  step('packages/a')?.querySelector('button')?.disabled ?? null,
        notes:     document.getElementById('ci-notes-wrap').hidden,
      };
    } finally {
      window.fetch = realFetch;
      clearTimeout(ciTimer);
    }
  `)
  t.ok(drawn.live && /phase 2\/2/.test(drawn.live), 'a run in progress says which phase it is in, of how many')
  t.ok(/packages\/b/.test(drawn.live) && /usually/.test(drawn.live), 'which suite is running now, against how long it usually takes')
  t.is(drawn.stop, false, 'it can be stopped')
  t.is(drawn.fullOff, true, 'and a second run cannot be started beside it')
  t.is(drawn.hygiene.trim(), 'ok', 'a phase this run finished shows this run\'s answer')
  t.ok(/this run/.test(drawn.hygieneFrom), 'and says it came from this run, not the last full one')
  t.is(drawn.tests.trim(), 'running', 'the phase in progress reads as running')
  t.ok(drawn.zero && /0 tests/.test(drawn.zero), 'a suite that ran zero tests is marked, not counted as a pass')
  t.ok(drawn.partial && /running/.test(drawn.partial), 'the suite running now is marked in the list')
  t.is(drawn.rerunOff, true, 'a suite cannot be rerun while a run is going')
  t.is(drawn.notes, false, 'the run\'s notes are offered')
}
