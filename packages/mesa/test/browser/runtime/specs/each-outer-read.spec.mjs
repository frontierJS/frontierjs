/*
 * A block inside {#each} that reads an OUTER reactive `let`.
 *
 * Found on `example`'s payments panel: the rows re-rendered, a text
 * interpolation reading the outer list re-rendered, and the {#if} beside it —
 * reading the SAME variable — never re-evaluated, so a per-row detail block
 * that should have appeared simply did not. No error, no warning; the screen
 * just said the provider had told us nothing.
 *
 * Three readers in one row, so a regression says which kind stopped tracking.
 */
export const name = '{#each} — a child block reading an outer let'
export const covers = ['each-outer-read']

export async function run(t) {
  await t.mount('each-outer-read')

  t.is(await t.evaluate(`return document.querySelector('#rows .text').textContent;`), '0',
    'nothing to start with')
  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-inline') };`).then(r => r.v), false,
    'and no conditional block')

  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-before') };`).then(r => r.v), true,
    'the sibling above it starts out rendered')

  // The reload: the outer list is reassigned, then the inner one. The sibling
  // above goes TRUE → FALSE in the same flush these go FALSE → TRUE.
  await t.clickAt('#load')

  await t.eventually(`document.querySelector('#rows .text').textContent`, '2',
    'a text interpolation inside the each sees the outer change')

  t.is(await t.evaluate(`return document.querySelectorAll('.note').length;`), 2,
    'a nested {#each} over a slice of the outer variable renders its rows')

  // ── FJS-468, asserted BROKEN ─────────────────────────────────────────────
  //
  // These two should be `true`. They are not: an {#if} inside the {#each},
  // whose condition reads the outer `notes`, does not render — while the text
  // interpolation above and the nested {#each} below, reading the same
  // variable in the same row, both do.
  //
  // Pinned as the current behaviour rather than skipped, on litestone's matrix
  // convention: a known defect asserted still-broken turns the suite RED when
  // somebody fixes it, where a skip goes stale in silence. Flip both to `true`
  // and delete this block when it is fixed.
  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-inline') };`).then(r => r.v), false,
    'FJS-468: an {#if} reading the outer variable does NOT re-evaluate (should be true)')
  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-fn') };`).then(r => r.v), false,
    'FJS-468: nor does one that reaches it through a function (should be true)')
  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-before') };`).then(r => r.v), false,
    'and the sibling that went the other way is gone')

  // ── The same two assignments, ONE FLUSH APART ────────────────────────────
  //
  // Which is what any async reload does: the rows come back from one request
  // and the second list from the next. The {#each} re-renders on the first
  // flush, and the question is whether the {#if} inside it is still tracking
  // the outer variable when the second one lands.
  await t.mount('each-outer-read')
  await t.clickAt('#load-async')

  await t.eventually(`document.querySelector('#rows .text').textContent`, '2',
    'the text interpolation still sees it across two flushes')
  t.is(await t.evaluate(`return document.querySelectorAll('.note').length;`), 2,
    'and so does a nested {#each} over a slice of it')
  t.is(await t.evaluate(`return { v: !!document.querySelector('.if-inline') };`).then(r => r.v), true,
    'and the {#if} — which is the one that stops')
}
