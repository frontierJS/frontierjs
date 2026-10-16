/*
 * now — #2, the time on one timer per resolution, parked while the tab is
 * hidden.
 *
 * What a green run pins: two readers of one resolution share one interval and
 * read one instant; a tick lands on a whole multiple of `every`; the reader
 * that started the clock unmounting leaves it running and still parked by
 * visibility for the reader that stays; another tab in front clears the
 * interval and the value stops; brought back, a minute
 * clock ticks at once rather than at the next minute; the last reader gone
 * clears every timer; a bad `every` is refused by name.
 *
 * The timers are counted by wrapping setInterval and clearInterval before the
 * mount, so the count is the clock's: nothing else on the drive page runs an
 * interval.
 */
export const name = 'now — one timer per resolution, parked while hidden'

const text = (t, id) => t.evaluate(`return document.querySelector('#${id}').textContent;`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const live = (t) => t.evaluate(`return window.kitIntervals.size;`)

export async function run(t) {
  await t.evaluate(`
    window.kitIntervals = new Map()
    window.kitIntervalCalls = []
    const set = window.setInterval, clear = window.clearInterval
    window.setInterval = function (fn, ms, ...rest) {
      const id = set.call(window, fn, ms, ...rest)
      window.kitIntervals.set(id, ms)
      window.kitIntervalCalls.push(ms)
      return id
    }
    window.clearInterval = function (id) {
      window.kitIntervals.delete(id)
      return clear.call(window, id)
    }
    return true;
  `)
  await t.mount('now')

  const first = Number(await text(t, 'a'))
  t.ok(Math.abs(first - Date.now()) < 5000, 'the first read is the time now')
  t.is(await text(t, 'b'), String(first), 'a second reader of 1000 ms reads the same instant')

  await t.eventually(`document.querySelector('#a').textContent !== '${first}'`, true,
    'the value advances on its own', 2500)
  const ticked = Number(await text(t, 'a'))
  t.is(await text(t, 'b'), String(ticked), 'both readers move on the one tick')
  t.ok(ticked % 1000 < 250, `a tick lands on a whole second (${ticked % 1000} ms past)`)
  t.is(JSON.stringify(await t.evaluate(`return window.kitIntervalCalls.slice();`)), '[1000]',
    'two readers of 1000 ms run one interval')

  await t.evaluate(`window.kitDropFirst(); return true;`)
  await t.eventually(`document.querySelector('#a') === null`, true, 'the reader that started the clock unmounts')
  const kept = await text(t, 'b')
  await t.eventually(`document.querySelector('#b').textContent !== '${kept}'`, true,
    'and the reader that stays still advances', 2500)

  const slowBefore = await text(t, 'slow')
  await t.hidden(async () => {
    await t.eventually(`document.visibilityState`, 'hidden', 'another tab in front hides this one')
    t.is(await live(t), 0, 'hidden, the interval is cleared')
    const held = await text(t, 'b')
    await sleep(2200)
    t.is(await text(t, 'b'), held, 'and the value holds while hidden')
  })
  await t.eventually(`document.querySelector('#slow').textContent !== '${slowBefore}'`, true,
    'brought back, a 60 s clock ticks at once rather than at the next minute', 1000)
  await t.eventually(`window.kitIntervals.size`, 1,
    'and the 1000 ms interval runs again', 2500)

  await t.evaluate(`window.mesaUnmount(); return true;`)
  await t.eventually(`window.kitIntervals.size`, 0, 'the last reader gone clears the interval')

  t.ok(String(await t.evaluate(`
    try { window.kitNow({ every: 0 }); return 'accepted'; }
    catch (e) { return e.message; }
  `)).includes('positive number'), 'every: 0 is refused by name')
}
