/*
 * click — a click lands on an element that moved after it was measured.
 *
 * `clickAt` reads the element's box and presses there. A disclosure closing
 * above a control animates for ~100ms, so a box read at its first frame is a
 * point the control has left by the time the press arrives, and the click
 * lands on whatever replaced it (FJS-3577). Under load the animation outlasts
 * the round trips before the press, which is the only condition it shows in.
 *
 * Here the page moves the control inside the first box read, so a press at
 * that box misses every time and a press where the control settles does not.
 */
export const name = 'click — a control that moves after it is measured is clicked where it settles'

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(t.origin)
    await b.evaluate(`
      document.body.innerHTML = '<button id="hit" style="position:relative;left:0;width:40px;height:30px">hit</button>';
      const hit = document.getElementById('hit');
      window.hits = 0;
      hit.addEventListener('click', () => { window.hits++ });
      const read = hit.getBoundingClientRect;
      let moved = false;
      hit.getBoundingClientRect = function () {
        const r = read.call(this);
        if (!moved) { moved = true; hit.style.left = '400px' }
        return r;
      };
      return true;
    `)
    await b.clickAt('#hit')
    t.is(await b.evaluate(`return window.hits`), 1, 'a control moved by its own first measurement is clicked once')
  } finally { await b.close() }
}
