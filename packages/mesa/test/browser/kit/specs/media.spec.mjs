/*
 * media — #3, a media query as a signal, and the two the kit names.
 *
 * What a green run pins: a width query flips with the real viewport; two
 * readers of one query add one `change` listener between them; the reader
 * that started the list unmounting leaves the other still flipping;
 * `reducedMotion` and `colorScheme` follow the emulated preference both ways;
 * the last reader gone removes every listener; an empty query is refused by
 * name.
 *
 * Listeners are counted by wrapping `MediaQueryList.prototype`'s add and
 * remove before the mount, keyed by the list's query, so the count is the
 * wrapper's: nothing else on the drive page listens to a media query.
 */
export const name = 'media — a query as a signal, one listener per query'

const text = (t, id) => t.evaluate(`return document.querySelector('#${id}').textContent;`)
const listeners = (t, q) => t.evaluate(`return window.kitMediaListeners[${JSON.stringify(q)}] || 0;`)
const total = (t) => t.evaluate(`return Object.values(window.kitMediaListeners).reduce((a, b) => a + b, 0);`)

const WIDE = '(min-width: 768px)'

export async function run(t) {
  await t.evaluate(`
    window.kitMediaListeners = {}
    const proto = MediaQueryList.prototype
    const add = proto.addEventListener, remove = proto.removeEventListener
    proto.addEventListener = function (type, fn, opts) {
      if (type === 'change') window.kitMediaListeners[this.media] = (window.kitMediaListeners[this.media] || 0) + 1
      return add.call(this, type, fn, opts)
    }
    proto.removeEventListener = function (type, fn, opts) {
      if (type === 'change') window.kitMediaListeners[this.media] -= 1
      return remove.call(this, type, fn, opts)
    }
    return true;
  `)

  await t.viewport(1024, async () => {
    await t.mount('media')
    t.is(await text(t, 'wide'), 'true', 'at 1024 px, (min-width: 768px) matches')
    t.is(await text(t, 'wide2'), 'true', 'and a second reader of it agrees')
    t.is(await listeners(t, WIDE), 1, 'two readers of one query add one change listener')
  })
  await t.viewport(600, async () => {
    await t.eventually(`document.querySelector('#wide').textContent`, 'false', 'at 600 px it stops matching')
    t.is(await text(t, 'wide2'), 'false', 'for both readers')

    await t.evaluate(`window.kitDropFirst(); return true;`)
    await t.eventually(`document.querySelector('#wide') === null`, true, 'the reader that started the list unmounts')
  })
  await t.viewport(900, async () => {
    await t.eventually(`document.querySelector('#wide2').textContent`, 'true',
      'and the reader that stays still flips at 900 px')
    t.is(await listeners(t, WIDE), 1, 'on the one listener it had')
  })

  t.is(await text(t, 'motion'), 'false', 'with no preference, reducedMotion is false')
  await t.media({ 'prefers-reduced-motion': 'reduce' }, async () => {
    await t.eventually(`document.querySelector('#motion').textContent`, 'true', 'asked for less motion, it is true')
  })
  await t.eventually(`document.querySelector('#motion').textContent`, 'false', 'and false again when the ask is gone')

  await t.media({ 'prefers-color-scheme': 'dark' }, async () => {
    await t.eventually(`document.querySelector('#scheme').textContent`, 'dark', 'a dark OS reads dark')
  })
  await t.media({ 'prefers-color-scheme': 'light' }, async () => {
    await t.eventually(`document.querySelector('#scheme').textContent`, 'light', 'a light one reads light')
  })

  await t.evaluate(`window.mesaUnmount(); return true;`)
  await t.eventually(`Object.values(window.kitMediaListeners).reduce((a, b) => a + b, 0)`, 0,
    'the last reader gone removes every listener')
  t.is(await total(t), 0, 'none left on any query')

  t.ok(String(await t.evaluate(`
    try { window.kitMedia(''); return 'accepted'; }
    catch (e) { return e.message; }
  `)).includes('non-empty string'), 'an empty query is refused by name')
}
