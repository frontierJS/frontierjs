/*
 * clock — a page opened with `newPage({ clock: true })` moves only when the
 * drive advances it (`FJS-D2061`, IDEAS/mesa-clock.md Phase 4).
 *
 * A green run pins: a declared flash clears at exactly its delay and a
 * declared poll ticks on its cadence, both under `page.clock(ms)`; a plain
 * `setInterval` from a script that never heard of Mesa holds still too; the
 * page's `Date.now()` is the start plus what was advanced; `settle` throws on
 * an armed `$.every` and settles once it is off; real time flows only between
 * `clock('real')` and `clock('hold')`; a navigation opens on the same virtual
 * time; a browser opened with `openChrome({ clock })` holds its FIRST page,
 * whose trusted clicks drive the same flash. Nothing here waits on Node's clock: the only real waits are in-page,
 * through `__fjsClock.native`, and they exist to prove that time did NOT move.
 */
export const name = 'clock — a held page moves only when the drive advances it'

const AT = Date.UTC(2030, 0, 1)
const FIXTURE = '/mesa/test/browser/drive/fixtures/clock.mesa'

// Real time passing in the page, on the native timer the fake leaves alone.
const realWait = (ms) => `await new Promise((r) => __fjsClock.native.setTimeout(r, ${ms}));`

export async function run(t) {
  const b = await t.openChrome()
  try {
    await rawTimers(t, b)
    await declaredTimers(t, b)
    await unheld(t, b)
  } finally { await b.close() }
  await mainPage(t)
}

async function rawTimers(t, b) {
  const page = await b.newPage({ url: t.origin + 'clock-raw', clock: { at: AT } })
  try {
    t.is(await page.evaluate('return Date.now()'), AT, 'Date.now() opens at the clock start')
    t.is(await page.evaluate('return window.opened'), AT, 'a page script read the held time, so the clock went in first')
    t.is(await page.evaluate(`${realWait(250)} return window.ticks`), 0,
      'a third-party setInterval holds still while real time passes')
    t.ok(await page.evaluate('return window.lap >= 1e12'), 'its id is a fake one, told apart from a native id')
    t.is(await page.clock(1000), AT + 1000, 'clock(ms) answers the new now')
    t.is(await page.evaluate('return window.ticks'), 10, 'and the interval fired once per 100 ms on the way')
    t.is(await page.evaluate('return Date.now()'), AT + 1000, 'Date.now() is the start plus what was advanced')
    t.is(await page.evaluate('return new Date().getTime()'), AT + 1000, 'and so is new Date()')
    t.is(await page.evaluate('return performance.now()'), 1000, 'performance.now() counts from the start')
    t.is(await page.clock(), AT + 1000, 'clock() reads now without moving it')

    let threw = null
    try { await page.clock('settle') } catch (e) { threw = e.message }
    t.match(threw, /still armed.*setInterval\(100ms\)/, 'settle throws naming the interval it cannot settle')

    await page.clock('real')
    const moved = await page.evaluate(`${realWait(300)} return window.ticks`)
    t.ok(moved > 10, `clock('real') lets the interval run on real time (${moved} ticks)`)
    const held = await page.clock('hold')
    const after = await page.evaluate(`${realWait(250)} return window.ticks`)
    t.is(await page.clock(), held, `clock('hold') stops virtual time where it was`)
    t.ok(after - moved <= 1, 'and the interval with it')

    await page.navigate(t.origin + 'clock-raw')
    t.is(await page.evaluate('return window.opened'), held, 'a navigation opens on the same virtual time')
    t.is(await page.evaluate(`${realWait(150)} return window.ticks`), 0, 'and held')
  } finally { await page.close() }
}

async function declaredTimers(t, b) {
  const page = await b.newPage({ url: t.mesa + '/', ready: 'window.mesaMount', clock: { at: AT } })
  const text = (sel) => page.evaluate(`return { v: document.querySelector(${JSON.stringify(sel)})?.textContent ?? null }`).then((r) => r.v)
  const click = (sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); return true`)
  try {
    await page.evaluate(`
      const { mount } = await import('@frontierjs/mesa/runtime');
      const { default: C } = await import(${JSON.stringify(FIXTURE)});
      const stage = document.getElementById('stage');
      const anchor = document.createComment('clock');
      stage.appendChild(anchor);
      mount(anchor, C, { props: {}, root: stage });
      return true;
    `)
    t.is((await page.clock('settle')).settled, true, 'a mounted fixture arms nothing until asked')

    await click('#save')
    t.is(await text('#flash'), 'Saved', 'the flash shows on Save')
    await page.clock(2999)
    t.is(await text('#flash'), 'Saved', 'and is still there at 2999 ms')
    await page.clock(1)
    t.is(await text('#flash'), null, 'and gone at 3000 ms')

    await click('#run')
    await page.clock(4500)
    t.is(await text('#ticks'), '3', 'the poll ticks three times in 4500 ms')
    const armed = await page.clock('settle', { allowArmed: true })
    t.is(JSON.stringify(armed), JSON.stringify({ settled: false, armed: ['$.every'] }),
      'settle names the declared poll as what is still armed')
    await click('#run')
    t.is(JSON.stringify(await page.clock('settle')), JSON.stringify({ settled: true, armed: [] }),
      'and settles once the poll is off')
    t.is(await page.evaluate('return Date.now()'), AT + 7500, 'the page read every advance and nothing else')
  } finally { await page.close() }
}

async function unheld(t, b) {
  const page = await b.newPage(t.origin + 'clock-raw')
  try {
    let threw = null
    try { await page.clock(10) } catch (e) { threw = e.message }
    t.match(threw, /newPage\(\{ clock: true \}\)/, 'a page opened without a clock says how to get one')
    t.is(await page.evaluate('return typeof globalThis.__fjsClock'), 'undefined', 'and its timers are the real ones')
  } finally { await page.close() }
}

// The first page held, so a spec reaches it through `clickAt` — a trusted
// click, through hit-testing — rather than an `el.click()` in the page; and
// `mesaMount`'s own wait and the `ready` poll run on the native clock.
async function mainPage(t) {
  const b = await t.openChrome({ clock: { at: AT } })
  try {
    await b.navigate(t.mesa + '/', 'window.mesaMount')
    t.is(await b.evaluate('return Date.now()'), AT, 'the first page opens on the held clock')
    t.is(await b.evaluate(`return await window.mesaMount(${JSON.stringify(FIXTURE)})`), true,
      'mesaMount returns on a held page')
    const text = (sel) => b.evaluate(`return { v: document.querySelector(${JSON.stringify(sel)})?.textContent ?? null }`).then((r) => r.v)
    await b.clickAt('#save')
    t.is(await text('#flash'), 'Saved', 'a trusted click on Save shows the flash')
    await b.clock(2999)
    t.is(await text('#flash'), 'Saved', 'and it is still there at 2999 ms')
    await b.clock(1)
    t.is(await text('#flash'), null, 'and gone at 3000 ms')
    await b.clickAt('#run')
    await b.clock(3000)
    t.is(await text('#ticks'), '2', 'a trusted click starts the poll, which ticks on the held clock')
    await b.clickAt('#run')
    t.is((await b.clock('settle')).settled, true, 'and settles once a second click stops it')
  } finally { await b.close() }
}
