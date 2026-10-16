/*
 * tab — #8, `tab.online`, `tab.visible`, `tab.focused`, each flipped for real.
 *
 * What a green run pins: the network going down re-renders `online` and fires
 * a `$: tab.online` handler; another tab in front re-renders `visible` and
 * `focused`, and bringing this one back restores both; the listeners go on at
 * the first read and a second reader adds none; a write is refused by name.
 */
export const name = 'tab — online, visible, focused'

const read = (t) => t.evaluate(`return {
  online:  document.querySelector('#online').textContent,
  visible: document.querySelector('#visible').textContent,
  focused: document.querySelector('#focused').textContent,
};`)

export async function run(t) {
  // Counted from before the first read: the kit is armed by reading a fact,
  // so nothing earlier in this tab has added a listener yet.
  await t.evaluate(`
    window.kitAdded = []
    const real = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (['online', 'offline', 'focus', 'blur', 'visibilitychange'].includes(type) &&
          (this === window || this === document)) window.kitAdded.push(type)
      return real.call(this, type, ...rest)
    }
    window.kitRestoreAdd = () => { EventTarget.prototype.addEventListener = real }
    return true;
  `)
  try {
    await t.mount('tab')
    await t.mount('tab')
  } finally {
    await t.evaluate(`window.kitRestoreAdd(); return true;`)
  }
  const added = await t.evaluate(`return window.kitAdded.slice();`)
  t.is(added.filter((e) => e === 'visibilitychange').length, 1,
    'the first read arms one listener set, and a second reader adds none')
  t.is(added.length, 5, 'online, offline, focus, blur and visibilitychange, once each')

  t.is(JSON.stringify(await read(t)), JSON.stringify({ online: 'true', visible: 'true', focused: 'true' }),
    'a tab in front, on the network, reads all three true')

  await t.offline(async () => {
    await t.eventually(`document.querySelector('#online').textContent`, 'false',
      'the network going down re-renders tab.online')
    await t.eventually(`document.querySelector('#went-offline').textContent`, '1',
      'and fires the $: tab.online handler')
  })
  await t.eventually(`document.querySelector('#online').textContent`, 'true',
    'the network coming back re-renders it')

  await t.hidden(async () => {
    await t.eventually(`document.querySelector('#visible').textContent`, 'false',
      'another tab in front makes this one hidden')
    await t.eventually(`document.querySelector('#focused').textContent`, 'false',
      'and blurred')
  })
  await t.eventually(`document.querySelector('#visible').textContent`, 'true',
    'brought back to the front, it is visible')
  await t.eventually(`document.querySelector('#focused').textContent`, 'true',
    'and focused')

  t.ok(String(await t.evaluate(`
    try { window.kitTab.online = false; return 'accepted'; }
    catch (e) { return e.message; }
  `)).includes("browser's to say"), 'a write is refused by name')
}
