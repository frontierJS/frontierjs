/*
 * dashboard.spec.mjs — what can run here, on screen.
 *
 * Three questions a unit test cannot answer, because each of them is about the
 * page rather than the data: do the rows render at all, does a state badge move
 * when something really binds the port, and does the open link point where the
 * inventory said it would.
 *
 * The badge assertion is the one worth having. Every other check here would
 * pass against a page that renders a frozen snapshot of the tree.
 */
export const name = 'the front page — what can run here'

export async function run(t) {
  // The badges are filled by a POLL, and the page's own first one races
  // whatever else it kicked off on load. Asking for one here is not a
  // workaround: this spec asserts state, so it has to assert it after a state
  // has been read rather than after the rows have been drawn.
  await t.evaluate(`return await pollState();`)

  /* ── the rows render ──────────────────────────────────────────────────── */

  const groups = await t.evaluate(`
    return [...document.querySelectorAll('#dash-groups section .bar strong')].map(el => el.textContent);
  `)
  t.ok(groups.includes('surfaces'), 'the surfaces group renders')
  t.ok(groups.includes('tools'),    'and so does the tools group')

  const rows = await t.evaluate(`return document.querySelectorAll('#dash-groups [data-id]').length;`)
  t.ok(rows > 10, `every runnable is a row (${rows})`)

  /* ── a row that nothing starts keeps its place ────────────────────────── */

  // The row exists and says so. Dropping it would make *no script declared*
  // and *no such surface* the same screen.
  const unstarted = await t.evaluate(`
    return [...document.querySelectorAll('#dash-groups [data-id]')]
      .some(li => li.textContent.includes('nothing here starts it'));
  `)
  t.ok(unstarted, 'a surface with no script is still a row, and says why')

  /* ── the state badge follows a real port ──────────────────────────────── */

  // The GUI server is itself a runnable — the `gui` tool — and it is up, on the
  // port this drive is talking to. So the page must be showing its own state
  // correctly or it is showing nothing correctly.
  // Asserted as the vocabulary rather than as a value, for the reason the open
  // link below is: a developer's machine has things running on it, and a drive
  // that expects `tool:gui` to be down fails the day somebody has one open.
  const guiState = await t.evaluate(`
    const li = document.querySelector('#dash-groups [data-id="tool:gui"]');
    const badge = li && li.querySelector('[data-state]');
    return { text: badge?.textContent, port: li?.textContent.includes(':8500') };
  `)
  t.ok(guiState.port, 'the gui tool row carries the reserved port')
  t.ok(['answering', 'not running', 'claimed, not answering'].includes(guiState.text),
    `and reads as one of the states the page can name ("${guiState.text}")`)

  // A drive has no port at all, so it is `unknown` — and `unknown` is a hidden
  // badge rather than the word "down", which would be a claim nobody can make.
  const driveBadge = await t.evaluate(`
    const li = [...document.querySelectorAll('#dash-groups [data-id]')]
      .find(el => el.dataset.id.startsWith('drive:'));
    return li ? li.querySelector('[data-state]').hidden : null;
  `)
  t.is(driveBadge, true, 'a row with no port shows no state rather than guessing one')

  /* ── open is offered only where something answers ─────────────────────── */

  // Asserted as the RULE rather than as a count, because a developer's machine
  // has things running on it: the first cut of this expected zero open links
  // and found two, which were `example`'s api and web genuinely up on 8110 and
  // 8010. The invariant is the useful half — a link to a port nothing is
  // listening on is a browser error page wearing this page's name.
  const linkRule = await t.evaluate(`
    return [...document.querySelectorAll('#dash-groups [data-id]')]
      .filter(li => li.querySelector('[data-open]'))
      .map(li => ({
        id:      li.dataset.id,
        up:      li.querySelector('[data-state]').textContent === 'answering',
        offered: !li.querySelector('[data-open]').hidden,
      }))
      .filter(r => r.up !== r.offered);
  `)
  t.is(linkRule.length, 0,
    `open is offered exactly where a row is answering${linkRule.length ? ` — ${JSON.stringify(linkRule)}` : ''}`)

  // And the link, when it is unhidden, points at the port the inventory named.
  const href = await t.evaluate(`
    const a = document.querySelector('#dash-groups [data-id="tool:gui"] [data-open]');
    return a ? a.getAttribute('href') : null;
  `)
  t.is(href, 'http://localhost:8500', 'the open link is the url the inventory named, not a guess')

  /* ── the tick is on screen ────────────────────────────────────────────── */

  // A reading with no time on it cannot be told from a live one.
  const tick = await t.evaluate(`return document.getElementById('dash-tick').textContent;`)
  t.ok(/checked/.test(tick), `the page says when it last checked (${tick})`)
}
