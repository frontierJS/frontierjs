/*
 * next.spec.mjs — the open register ranked, on screen.
 *
 * `test/next.test.js` covers the ranking and `test/server.test.js` the
 * endpoint. What is here is that the panel draws the ranking it was handed, in
 * its order, with the terms that scored each row beside it — a ranking whose
 * reasons do not reach the page is one nobody can argue with.
 */
export const name = 'next up'

export async function run(t) {
  const answer = await t.evaluate(`
    const body = await fetch('/api/next').then(r => r.json());
    await loadNext();
    return {
      error: body.error ?? null,
      ids:   body.ready.map(r => r.id),
      scores: body.ready.map(r => String(r.score)),
      readyCount: body.readyCount,
      hidden: document.getElementById('next').hidden,
      shown: [...document.querySelectorAll('#next-rows [data-next]')].map(li => ({
        id: li.dataset.next,
        score: li.querySelector('[data-score]').textContent,
        terms: li.querySelector('.text-muted').textContent,
      })),
    };
  `)
  t.is(answer.error, null, 'the endpoint answers without an error')
  t.ok(answer.readyCount > 0, `this repo keeps a register, so something is ranked (${answer.readyCount})`)
  t.is(answer.hidden, false, 'and the panel is on screen')
  t.is(answer.shown.map(r => r.id).join(','), answer.ids.join(','), 'the rows are drawn in the ranking\'s order')
  t.is(answer.shown.map(r => r.score).join(','), answer.scores.join(','), 'each with its score')
  t.ok(answer.shown.every(r => /\+\d+/.test(r.terms)), 'and the terms that make it up')
}
