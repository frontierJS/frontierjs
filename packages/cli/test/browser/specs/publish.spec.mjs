/*
 * publish.spec.mjs — publishing the packages, walked where somebody looks.
 *
 * `test/publish-view.test.js` covers the engine: the options gate, the order,
 * and a real `ws:pub --dry` over a fixture. What is here is the panel against
 * THIS workspace — that every step is drawn in the table's order, that an
 * untouched selection sends no `--filter` (so the page never narrows a release
 * by having drawn a list), that changing an option clears a plan made with the
 * old one, and that the dry run reaches the console through the same stream a
 * deploy step uses.
 *
 * Nothing here can spend a version: the publish and the push are asserted to
 * be REFUSED without approval, and the only step run is the dry one.
 */
export const name = 'publishing the packages'

export async function run(t) {
  // The page's own /api/check holds this server for ~25s (FJS-1630), and every
  // request below would queue behind it past the harness's 30s per evaluate.
  // Short polls until it lands keep each evaluate under that.
  for (let i = 0; i < 12; i++) {
    if (await t.evaluate(`return checksBody !== null || /could not/.test(document.getElementById('checks-note').textContent);`)) break
    await new Promise(r => setTimeout(r, 5000))
  }

  const panel = await t.evaluate(`
    await loadPublish();
    return {
      hidden:  document.getElementById('publish').hidden,
      ids:     [...document.querySelectorAll('#publish-steps [data-step]')].map(li => li.dataset.step),
      table:   FLOWS.publish.steps.map(s => s.id),
      rows:    document.querySelectorAll('#publish-packages [data-pkg]').length,
      members: publishBody.packages.length,
      opts:    publishOpts(),
      progress: document.getElementById('publish-progress').textContent,
    };
  `)
  t.is(panel.hidden, false, 'this workspace has packages, so the panel is on screen')
  t.is(panel.ids.join(','), panel.table.join(','), `every step is drawn in the table's order (${panel.ids.length})`)
  t.is(panel.rows, panel.members, `every member is listed (${panel.rows})`)
  t.is(panel.opts.packages.length, 0, 'an untouched selection sends no --filter — ws:pub picks')
  t.ok(/of \d+ ready/.test(panel.progress), `and the panel says how far along it is — "${panel.progress}"`)

  // The same step id in two flows is two steps: a lookup that went through the
  // document instead of the flow's list would update the deploy's `commit`.
  const scoped = await t.evaluate(`
    return {
      deploy:  document.querySelectorAll('#release-steps [data-step="commit"]').length,
      publish: document.querySelectorAll('#publish-steps [data-step="commit"]').length,
    };
  `)
  t.is(scoped.publish, 1, 'publish has its own commit step')
  t.ok(scoped.deploy <= 1, 'and the deploy flow keeps its own')

  /* ── a plan answers the options it ran with ──────────────────────────── */

  const cleared = await t.evaluate(`
    stepResults['publish:plan'] = { code: 0, at: Date.now() };
    document.getElementById('publish-bump').value = 'minor';
    onPublishOptions();
    const word = document.querySelector('#publish-steps [data-step="plan"] [data-step-badge]').textContent;
    document.getElementById('publish-bump').value = 'patch';
    onPublishOptions();
    return { kept: 'publish:plan' in stepResults, word };
  `)
  t.is(cleared.kept, false, 'changing the bump clears the plan made with the old one')
  t.is(cleared.word, 'not run', 'and the step says so')

  /* ── unticking a package is what narrows ─────────────────────────────── */

  const picked = await t.evaluate(`
    const first = publishable().find(p => p.affected);
    if (!first) return null;
    togglePublishPackage(first.name, false);
    const o = publishOpts();
    togglePublishPackage(first.name, true);
    const back = publishOpts().packages.length;
    return { name: first.name, sent: o.packages.length, has: o.packages.includes(first.name), back };
  `)
  if (picked) {
    t.ok(picked.sent > 0, 'unticking a package narrows the run by name')
    t.is(picked.has, false, `and the unticked one is not sent (${picked.name})`)
    t.is(picked.back, 0, 'ticking it back is what ws:pub would pick anyway, so no --filter again')
  }

  /* ── the server holds the line without the page ──────────────────────── */

  const refused = await t.evaluate(`
    const post = (b) => fetch('/api/release/step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
      .then(async r => ({ status: r.status, error: (await r.json()).error }));
    return {
      publish: await post({ flow: 'publish', step: 'publish', opts: {} }),
      push:    await post({ flow: 'publish', step: 'push' }),
      tag:     await post({ flow: 'publish', step: 'plan', opts: { tag: 'latest; id' } }),
    };
  `)
  t.is(refused.publish.status, 400, 'an unapproved publish is refused by the server')
  t.ok(/approving/.test(refused.publish.error), `by name — "${refused.publish.error}"`)
  t.is(refused.push.status, 400, 'and an unapproved push')
  t.ok(/dist-tag/.test(refused.tag.error), 'and a tag ws:pub would paste into a shell')

  /* ── the dry run, through the page ───────────────────────────────────── */

  const plan = await t.evaluate(`
    const before = document.querySelectorAll('#output-lines .gui-line').length;
    await runStep('publish', 'plan');
    const lines = [...document.querySelectorAll('#output-lines .gui-line')].slice(before).map(l => l.textContent);
    return {
      word:  document.querySelector('#publish-steps [data-step="plan"] [data-step-badge]').textContent,
      echo:  lines.find(l => l.startsWith('$ ')) ?? null,
      said:  lines.some(l => /Publishing \\d+ package|Nothing to publish|refused/.test(l)),
    };
  `)
  t.ok(['passed', 'failed'].includes(plan.word), `the dry run ends with a verdict — "${plan.word}"`)
  t.ok(/fli ws:pub patch --dry/.test(plan.echo ?? ''), `and the console names the command it ran — "${plan.echo}"`)
  t.ok(plan.said, "and carries ws:pub's own output")
}
