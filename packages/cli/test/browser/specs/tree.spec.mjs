/*
 * tree.spec.mjs — what you have changed, on screen.
 *
 * `test/git-status.test.js` covers the model and asserts that every path goes
 * in and comes out exactly once. That property is only half of the answer: the
 * page re-groups the model by role to draw it, off its own `TREE_ROLES` list,
 * and a role missing from that list prints nothing while the header goes on
 * counting the file. A dropped row and a clean file look identical, so the
 * count is asserted HERE against the same model the panel rendered from.
 *
 * Every assertion is about the RULE and not about this machine's working tree.
 * A drive that expects a dirty tree fails on a clean checkout, and one that
 * expects a clean tree fails on every machine anyone is working on.
 */
export const name = 'what you have changed'

export async function run(t) {
  const answer = await t.evaluate(`
    const body = await fetch('/api/status').then(r => r.json());
    return {
      error:  body.error ?? null,
      files:  body.total?.files ?? 0,
      places: body.zones?.length ?? 0,
      branch: body.branch ?? null,
    };
  `)
  t.is(answer.error, null, 'the endpoint answers without an error')

  /* ── the panel agrees with the answer ─────────────────────────────────── */

  // Agreement rather than a value: a clean tree and a dirty one are both
  // legitimate states of the machine this runs on.
  const shown = await t.evaluate(`
    await loadTree();
    return {
      hidden: document.getElementById('tree').hidden,
      note:   document.getElementById('tree-note').textContent,
      places: document.querySelectorAll('#tree-rows > li').length,
      files:  document.querySelectorAll('#tree-rows .gui-file').length,
      bars:   document.querySelectorAll('#tree-rows progress.progress').length,
      divs:   document.querySelectorAll('#tree-rows .gui-churn:not(progress)').length,
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

  t.is(shown.places, answer.places, `one row per place (${answer.places})`)

  // The whole reason this spec exists. The renderer groups by its own role
  // list, so a role the engine answers and the list omits drops its files in
  // silence while the note above still counts them.
  t.is(shown.files, answer.files,
    `every file the model carries is drawn (${answer.files})`)

  t.ok(shown.note.includes(answer.branch), `the note names the branch — "${shown.note}"`)

  /* ── the bar is the kit's, not a second answer to it ──────────────────── */

  // @frontierjs/css ships Progress. A hand-rolled div with a background would
  // render identically today and stop matching the theme the first time one of
  // them moves.
  t.is(shown.bars, answer.places, 'each place carries the kit Progress element')
  t.is(shown.divs, 0, 'and nothing re-implements it')

  /* ── how far a change reaches ─────────────────────────────────────────── */

  // Marked above band 2 and nowhere else. A mark on every file is a column the
  // eye learns to skip, which is the whole reason for the threshold — so the
  // assertion is the COUNT, in both directions: every banded file marked, and
  // nothing below the band marked.
  const reach = await t.evaluate(`
    const body = await fetch('/api/status').then(r => r.json());
    const files = body.zones.flatMap(z => z.files);
    return {
      banded: files.filter(f => f.blast && f.blast.band >= 2).length,
      loud:   files.filter(f => f.blast && f.blast.band >= 3).length,
      read:   files.filter(f => f.blast !== null).length,
      drawn:  document.querySelectorAll('#tree-rows .gui-reach').length,
      drawnLoud: document.querySelectorAll('#tree-rows .gui-reach.loud').length,
      // The name carries the loud band too, but only where no state claims it
      // first — a deleted hub stays danger-toned.
      loudName: document.querySelectorAll('#tree-rows .gui-file.text-warning').length,
      loudPlain: files.filter(f => f.blast && f.blast.band >= 3
        && !f.conflict && !f.untracked && f.index !== 'A' && f.index !== 'D' && f.work !== 'D').length,
    };
  `)

  // A tally that failed to build answers null for everything, and the panel
  // would then be silently unmarked rather than wrong — worth saying out loud.
  t.ok(reach.read > 0, `the tally read ${reach.read} of ${answer.files} file(s)`)
  t.is(reach.drawn, reach.banded, `every file above the band is marked (${reach.banded})`)
  t.is(reach.drawnLoud, reach.loud, `and the loud band is the loud one (${reach.loud})`)
  t.is(reach.loudName, reach.loudPlain,
    `the name goes warning-toned where no state claims it (${reach.loudPlain})`)

  /* ── a file carries its state where a copy-paste keeps it ─────────────── */

  // Tone alone is the whole answer for nobody: it does not survive a copy out
  // of the page, and it is not an answer at all for a reader who cannot tell
  // the tones apart. Asserted only where the tree actually has such a file.
  const marked = await t.evaluate(`
    const body = await fetch('/api/status').then(r => r.json());
    const flagged = body.zones.flatMap(z => z.files)
      .filter(f => f.untracked || f.index === 'A' || f.index === 'D' || f.work === 'D' || f.conflict);
    const drawn = [...document.querySelectorAll('#tree-rows .gui-file')]
      .filter(el => /^[+\\u2212!]/.test(el.textContent));
    return { expected: flagged.length, drawn: drawn.length };
  `)
  if (marked.expected === 0) {
    t.ok(true, 'nothing added, deleted or conflicted in this tree to mark')
  } else {
    t.is(marked.drawn, marked.expected,
      `every added, deleted or conflicted file carries a glyph (${marked.expected})`)
  }
}
