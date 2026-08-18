/*
 * attach — `{@attach}` on a connected element, with a real animation.
 *
 * `el.animate` does not exist in happy-dom, so the whole path is unreachable
 * from the vitest suites; and an animation started on a DETACHED node returns
 * one that never runs, which is a green test and a blank overlay.
 */
export const name = '{@attach}'
export const covers = ['attach', 'attach-cleanup']

export async function run(t) {
  await t.mount('attach')

  t.is(await t.evaluate(`return document.querySelector('#attached').textContent;`), '1',
    'the attachment ran once')
  t.is(await t.evaluate(`return document.querySelector('#connected').textContent;`), 'true',
    'and ran with the element already in the document')

  // The element is inline-styled to opacity 0 and animated to 1 with
  // `fill: 'forwards'`. An attachment that fired on a detached node leaves an
  // animation that never started, so the assertion is the END value rather
  // than the presence of an animation object.
  const opacity = await t.evaluate(`
    const el = document.querySelector('#faded');
    await Promise.allSettled(el.getAnimations().map(a => a.finished));
    return { v: getComputedStyle(el).opacity };
  `)
  t.is(opacity.v, '1', 'the animation actually ran and held its end value')

  // Cleanup runs when the element leaves — the `{#if}` closing is what a
  // component destroying an overlay does.
  await t.clickAt('#hide')
  await t.eventually(`document.querySelector('#cleaned').textContent`, '1',
    'the returned cleanup ran when the element was removed')
  t.is(await t.evaluate(`return { v: !!document.querySelector('#faded') };`).then((r) => r.v), false,
    'and the element is gone')
}
