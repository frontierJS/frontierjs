/*
 * hmr — a component swapped in place, twice.
 *
 * This is the gap `FJS-024` names. Everything up to the frame Vite sends is
 * proven in Node; what happens after it — the client finding a registered
 * instance, clearing between the marker and the anchor, and re-running the new
 * function — has only ever been read.
 *
 * Three things are asserted per edit, and they fail apart:
 *
 *   the edited component shows the new content     — the update arrived
 *   the page did not navigate                      — it was not a full reload
 *   the neighbour kept its state                   — it was a SWAP
 *
 * The second edit is not a repetition. `__setMark` is set on the NEW function,
 * and setting it on the old module's leaves the new `__hmrMark` undefined: the
 * first update then registers with `hmrMark: undefined` and the second drops
 * the entry as stale. HMR that works once per page load and then stops is
 * indistinguishable from HMR that works, unless something edits twice.
 *
 * Note what does NOT survive: the edited component's own state. The client is
 * explicit that its signals are rebuilt, and the win is everything around it.
 *
 * ── An update is not a microtask ──────────────────────────────────────
 *
 * Every wait here is seconds. The round trip is a file watcher, a recompile
 * and a socket, and it is not fast: the second write to one file was measured
 * arriving ~4.5s after it was made. The default 2s window reports working HMR
 * as an update that never came, which is the same red as the defect this spec
 * is looking for and would send the next person to the wrong package.
 */
export const name = 'hmr — a component swaps in place'
export const covers = ['hmr-boundary', 'hmr-client', 'handleHotUpdate']

const ARRIVES = 15000

/** Wait for the edited component to show `want`, then report what it cost. */
async function afterEdit(t, want, label) {
  await t.eventually(`document.querySelector('#counter-version')?.textContent`, want,
    `${label}: the edited component shows the new content`, ARRIVES)
  t.is(await t.boots(), 1, `${label}: and the page did not reload to get it`)
  t.is(await t.evaluate(`return document.querySelector('#sibling-count').textContent;`), '2',
    `${label}: the neighbour kept its state`)
}

export async function run(t) {
  // State in the component that is NOT edited. If this is 0 afterwards, the
  // page reloaded — which is precisely the outcome HMR exists to avoid, and
  // which leaves the DOM looking completely correct.
  await t.clickAt('#sibling')
  await t.clickAt('#sibling')
  await t.eventually(`document.querySelector('#sibling-count').textContent`, '2',
    'the neighbour holds state before any edit')

  await t.edit('src/Counter.mesa', '>v1<', '>v2<')
  await afterEdit(t, 'v2', 'first edit')

  // Twice. Once per page load is the failure shape the boundary was written
  // against, and it reports itself only through a console warning.
  await t.edit('src/Counter.mesa', '>v2<', '>v3<')
  await afterEdit(t, 'v3', 'second edit')

  const log = await t.log()
  t.ok(log.some((l) => /Mesa HMR.*Counter\.mesa/.test(l)),
    'the client reported the swap it made')
  t.ok(!log.some((l) => /No registered instances|no connected instances/.test(l)),
    'and never fell back to a reload because it could not find the instance')

  // A style-only edit needs no separate path: the rules are inlined into the
  // module being invalidated, and `addStyles` keys on a content hash, so the
  // edited block arrives under an id the page has not seen.
  await t.edit('src/Counter.mesa', 'rgb(1, 2, 3)', 'rgb(4, 5, 6)')
  await t.eventually(`getComputedStyle(document.querySelector('#counter-version')).color`,
    'rgb(4, 5, 6)', 'a style-only edit reaches the page as a style, not a reload', ARRIVES)
  t.is(await t.boots(), 1, 'still without navigating')
}
