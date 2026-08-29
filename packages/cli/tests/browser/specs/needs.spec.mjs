/*
 * needs.spec.mjs — a drive's preamble, on screen and pressed.
 *
 * `tests/preflight.test.js` covers the parse and the resolution. What it cannot
 * answer is the half this feature exists for: that the preamble is VISIBLE
 * before the button is pressed, and that pressing it walks the steps rather than
 * running the drive on its own.
 *
 * ── Why nothing here spawns a step ─────────────────────────────────────────
 *
 * The steps are real rows on a developer's real machine. `example`'s `stop` is
 * `pkill -f 'bun.*api/index.ts'` and `db:seed` rewrites a database somebody may
 * be looking at, so a spec that presses one to watch it succeed is a spec that
 * takes the machine away from its owner.
 *
 * So the success path is driven through the branch that matters most and costs
 * nothing: a step that is ALREADY ANSWERING is skipped, which is what makes this
 * the only start button a drive needs. This file binds a port to put a row in
 * that state — and if the port is already taken, the row is answering for real
 * and the branch is exercised either way.
 */
import { createServer } from 'node:http'

export const name = 'a drive that says what to start first'

/** A row that is answering, however it got that way. Null if we cannot make one. */
async function occupy(port) {
  const server = createServer((_, res) => res.end('ok'))
  try {
    await new Promise((ok, no) => {
      server.once('error', no)
      server.listen(port, '0.0.0.0', ok)
    })
    return () => new Promise(r => server.close(r))
  } catch {
    // Already bound — somebody's real server. Nothing to clean up, and the row
    // is in exactly the state this needs.
    return () => Promise.resolve()
  }
}

export async function run(t) {
  /* ── the preamble is on screen ────────────────────────────────────────── */

  const shown = await t.evaluate(`
    const withNeeds = dashRows.filter(r => r.kind === 'drive' && r.needs.length);
    const one = withNeeds[0];
    const li  = one && document.querySelector('#dash-groups [data-id="' + one.id + '"]');
    return {
      count:  withNeeds.length,
      needs:  one ? one.needs.map(n => n.script) : [],
      text:   li ? (li.querySelector('[data-needs]') || {}).textContent ?? null : null,
      button: li ? (li.querySelector('[data-start]') || {}).textContent ?? null : null,
    };
  `)

  t.ok(shown.count > 5, `drives carry a preamble read off CLAUDE.md (${shown.count})`)
  t.ok(shown.text, `and the row shows it before anything is pressed — "${shown.text}"`)
  for (const step of shown.needs) {
    t.ok(shown.text.includes(step), `the preamble names ${step}`)
  }

  // The label is the promise: this is not the bare start the other rows carry,
  // and somebody about to press it should be able to tell.
  t.ok(/start it all/.test(shown.button ?? ''), `the button says so — "${shown.button}"`)

  /* ── a drive with no preamble keeps the plain button ──────────────────── */

  const plain = await t.evaluate(`
    const bare = dashRows.find(r => r.kind === 'drive' && !r.needs.length);
    const li = bare && document.querySelector('#dash-groups [data-id="' + bare.id + '"]');
    return {
      needs:  li ? Boolean(li.querySelector('[data-needs]')) : null,
      button: li ? (li.querySelector('[data-start]') || {}).textContent ?? null : null,
    };
  `)
  t.is(plain.needs, false, 'a drive the table gives no preamble shows none, rather than an empty line')
  t.is(plain.button, 'start', 'and keeps the plain start button')

  /* ── a step that is already answering is skipped ──────────────────────── */

  const target = await t.evaluate(`
    const r = dashRows.find(r => r.kind === 'surface' && r.port && r.start);
    return r ? { id: r.id, port: r.port, script: r.start.replace('bun run ', '') } : null;
  `)
  t.ok(target, `a surface to stand in for a preamble step (${target?.id})`)

  const release = await occupy(target.port)
  try {
    const skipped = await t.evaluate(`
      await pollState();
      const before = document.querySelectorAll('#output-lines .gui-line').length;
      const ok = await ensureNeed(
        { id: ${JSON.stringify(target.id)}, script: ${JSON.stringify(target.script)},
          run: 'bun run ${target.script}', port: ${target.port} },
        { name: 'fake', dir: 'example' },
      );
      const said = [...document.querySelectorAll('#output-lines .gui-line')]
        .slice(before).map(el => el.textContent).join(' ');
      const started = await fetch('/api/output/' + encodeURIComponent(${JSON.stringify(target.id)}))
        .then(r => r.json());
      return { ok, said, child: started.child };
    `)
    t.is(skipped.ok, true, 'a step already answering is satisfied')
    t.ok(/already answering/.test(skipped.said), `and says so rather than silently doing nothing — "${skipped.said.trim()}"`)
    // The assertion that makes the branch worth having: nothing was spawned.
    t.is(skipped.child, null, 'and nothing was started, because something is already there')
  } finally {
    await release()
  }

  /* ── a step that cannot run stops the sequence ────────────────────────── */

  // The assertion the whole thing turns on. A seed that failed leaves a database
  // the drive will read and disagree with for reasons three steps away, so the
  // walk must not reach the drive — and it must say which step it was.
  const stopped = await t.evaluate(`
    const before = document.querySelectorAll('#output-lines .gui-line').length;
    const ok = await ensureNeed(
      { id: 'task:example/nope', script: 'nope', run: 'bun run nope', port: null },
      { name: 'fake', dir: 'example' },
    );
    return { ok, said: [...document.querySelectorAll('#output-lines .gui-line')]
      .slice(before).map(el => el.textContent).join(' ') };
  `)
  t.is(stopped.ok, false, 'a step that cannot be started answers false rather than carrying on')
  t.ok(/nope/.test(stopped.said), `and names the step — "${stopped.said.trim().slice(0, 90)}"`)

  /* ── an unresolvable step never reaches the server ────────────────────── */

  // `id: null` is the `drive-preamble` finding at run time: the table names a
  // script the directory does not declare. The page has to say that rather than
  // POST an id it does not have, which comes back as a 404 about something else.
  const unresolved = await t.evaluate(`
    dashRows.push({ id: 'drive:fake/verify', kind: 'drive', name: 'verify', dir: 'fake',
                    start: 'bun run verify', argv: ['bun','run','verify'], port: null,
                    needs: [{ script: 'ghost', run: 'bun run ghost', id: null, kind: null, port: null }] });
    const before = document.querySelectorAll('#output-lines .gui-line').length;
    await startWithNeeds('drive:fake/verify');
    return [...document.querySelectorAll('#output-lines .gui-line')]
      .slice(before).map(el => el.textContent).join(' ');
  `)
  t.ok(/ghost/.test(unresolved), 'a step that resolves to no row is reported by name')
  t.ok(/declares no such script/.test(unresolved),
    `and says what is wrong with it — "${unresolved.trim().slice(0, 110)}"`)
}
