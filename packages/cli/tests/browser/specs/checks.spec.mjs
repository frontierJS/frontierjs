/*
 * checks.spec.mjs — the rules, and the machine, where somebody looks.
 *
 * `fli check` is the arch-test surface and `fli doctor` asks whether this
 * machine can run fli at all. Both engines existed and neither was anywhere a
 * person looks, which for a set of rules that are silent when broken is most of
 * the value gone.
 *
 * `tests/checks.test.js` and `tests/doctor.test.js` cover the engines,
 * `tests/server.test.js` the endpoints. What is here is the panel: that a clean
 * project says so rather than showing nothing, that a finding arrives with the
 * rule that raised it and the file it is in, and that the machine's own answer
 * goes FIRST — nothing else on the page matters if fli cannot run here.
 */
export const name = 'the rules, and the machine'

export async function run(t) {
  const answer = await t.evaluate(`
    const [c, d] = await Promise.all([
      fetch('/api/check').then(r => r.json()),
      fetch('/api/doctor').then(r => r.json()),
    ]);
    return {
      errors: c.errors, warns: c.warns,
      ran:    (c.scopes || []).reduce((n, s) => n + s.ran, 0),
      machineOk: d.ok, blocked: d.blocked,
    };
  `)
  t.ok(answer.ran > 0, `rules ran over this project (${answer.ran})`)

  /* ── the panel says what it read ──────────────────────────────────────── */

  const panel = await t.evaluate(`
    await loadChecks();
    return {
      hidden: document.getElementById('checks').hidden,
      note:   document.getElementById('checks-note').textContent,
      rows:   document.querySelectorAll('#checks-rows [data-finding]').length,
    };
  `)

  // Unlike the proves panel above it, this one does not hide when it is happy.
  // *Nothing changed* is noise; *this project passes its own rules* is not, and
  // hiding it makes `clean` and `never ran` the same screen.
  t.is(panel.hidden, false, 'the panel is on screen whether or not there is anything wrong')
  t.ok(/rule run\(s\)/.test(panel.note), `and says how many rules ran — "${panel.note}"`)

  const total = answer.errors + answer.warns + (answer.machineOk ? 0 : 1)
  if (total === 0) {
    t.ok(/nothing to report/.test(panel.note), 'a clean project says so rather than showing an empty list')
    t.is(panel.rows, 0, 'with no rows')
    return
  }

  t.ok(panel.rows > 0, `and renders what it found (${panel.rows} shown of ${total})`)

  /* ── a finding names the rule and the place ───────────────────────────── */

  const rows = await t.evaluate(`
    return [...document.querySelectorAll('#checks-rows [data-finding]')].map(li => ({
      severity: li.dataset.finding,
      rule:     li.querySelector('.badge').textContent,
      where:    li.querySelector('code').textContent,
      message:  li.querySelector('.gui-clamp').textContent,
      full:     li.querySelector('.gui-clamp').title,
    }));
  `)
  t.ok(rows.every(r => ['error', 'warn'].includes(r.severity)),
    'every row carries a severity the page can tone')
  t.ok(rows.every(r => r.rule.length > 0), 'and the rule that raised it, by name')
  t.ok(rows.every(r => r.where.length > 0), 'and where — a file, or the scope when the rule is about no one file')

  // A rule explains what BREAKS, which is what makes it worth reading and too
  // long for a row. The clamp is visual; the whole of it has to survive.
  t.ok(rows.every(r => r.full.length >= r.message.length),
    'the message is clamped for the row and kept whole in the title')

  // Nobody can click an absolute path, and it names the machine it was read on.
  t.ok(rows.every(r => !r.where.startsWith('/')),
    'a path is relative to the project')

  /* ── errors first ─────────────────────────────────────────────────────── */

  const order = rows.map(r => (r.severity === 'error' ? 0 : 1))
  t.ok(order.every((n, i) => i === 0 || order[i - 1] <= n),
    `what is on screen is in order (${rows.map(r => r.severity).join(' → ')})`)

  // And the rule itself, against a list that HAS both. This project currently
  // raises no errors at all, so the assertion above is true whether or not the
  // ordering is applied — which is exactly what a mutation of it proved.
  const sorted = await t.evaluate(`
    return sortFindings([
      { severity: 'warn',  rule: 'a' },
      { severity: 'error', rule: 'b' },
      { severity: 'warn',  rule: 'c' },
      { severity: 'error', rule: 'd' },
    ]).map(f => f.severity + ':' + f.rule);
  `)
  t.is(sorted.join(' '), 'error:b error:d warn:a warn:c',
    'errors come first, and the order within a severity is left alone')

  /* ── the machine goes first when it has something to say ──────────────── */

  if (!answer.machineOk) {
    const first = await t.evaluate(`
      const li = document.querySelector('#checks-rows [data-finding]');
      return { where: li.querySelector('code').textContent, severity: li.dataset.finding };
    `)
    t.is(first.where, 'this machine', 'the machine is the first row, because nothing else matters if fli cannot run here')
    // Blocked is system and config only: a missing CLOUDFLARE_TOKEN blocks that
    // namespace and nothing else, and grading it as an error would make almost
    // every machine read as broken.
    t.is(first.severity, answer.blocked ? 'error' : 'warn',
      `and is graded on whether it STOPS fli, not on whether something is absent (blocked=${answer.blocked})`)
  } else {
    t.ok(/machine ok/.test(panel.note), 'a machine with nothing wrong is one word in the header, not a row')
  }

  /* ── the cap names its own count ──────────────────────────────────────── */

  const cap = await t.evaluate(`
    return { hidden: document.getElementById('checks-more').hidden,
             label:  document.getElementById('checks-more-btn').textContent };
  `)
  if (total > 6) {
    t.is(cap.hidden, false, `more findings than fit, so the count is offered (${total})`)
    const all = await t.evaluate(`
      showAllChecks();
      return { rows: document.querySelectorAll('#checks-rows [data-finding]').length,
               hidden: document.getElementById('checks-more').hidden };
    `)
    t.is(all.rows, total, 'and pressing it renders every one of them')
    t.is(all.hidden, true, 'with nothing left to offer')
  } else {
    t.is(cap.hidden, true, 'nothing is hidden, so no count is offered')
  }
}
