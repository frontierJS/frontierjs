/*
 * hotkey — #5, one binding over `keys()` (`IDEAS/keys.md` 2.2), pressed
 * through CDP's input pipeline so `e.key`, focus and a field's typing are the
 * browser's own.
 *
 * What a green run pins: a hotkey with no scope fires with nothing focused,
 * and every hotkey on one root shares one keydown listener, gone with the
 * last dispose; of two bindings of one key the newest answers and disposing it
 * hands the key back; `when` false parks a binding so the key falls through;
 * a sequence fires; a scoped hotkey answers only with focus inside its
 * delegation root; a letter types in a field, Ctrl fires there; a chord in the
 * web's spelling throws at the call, as does one the browser takes first, in
 * hotkey() and at keys()'s attach, while a key a page may cancel binds.
 */
export const name = 'hotkey — one binding in a root\'s keymap'

const CTRL = 2
const log = (t) => t.evaluate(`return window.kitLog.join(' ');`)
const blur = (t) => t.evaluate(`document.activeElement?.blur(); return true;`)

export async function run(t) {
  await t.evaluate(`
    window.kitListeners = 0
    const add = EventTarget.prototype.addEventListener
    const remove = EventTarget.prototype.removeEventListener
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (type === 'keydown' && this === document) window.kitListeners++
      return add.call(this, type, ...rest)
    }
    EventTarget.prototype.removeEventListener = function (type, ...rest) {
      if (type === 'keydown' && this === document) window.kitListeners--
      return remove.call(this, type, ...rest)
    }
    return true;
  `)
  await t.mount('hotkey')

  await t.evaluate(`
    window.kitOff = {
      palette: kitHotkey('<C-k>', () => kitLog.push('palette')),
      lower: kitHotkey('<Esc>', () => kitLog.push('lower')),
      upper: kitHotkey('<Esc>', () => kitLog.push('upper')),
    }
    return true;
  `)
  t.is(await t.evaluate(`return window.kitListeners;`), 1, 'three hotkeys on document add one keydown listener')

  await blur(t)
  await t.press('k', CTRL)
  t.is(await log(t), 'palette', 'a hotkey with no scope fires with nothing focused')

  await t.press('Escape')
  t.is(await log(t), 'palette upper', 'of two bindings of <Esc> the newest answers, and only it')
  await t.evaluate(`kitOff.upper(); return true;`)
  await t.press('Escape')
  t.is(await log(t), 'palette upper lower', 'disposing the newest hands the key to the one under it')

  await t.evaluate(`
    window.kitOpen = false
    kitOff.parked = kitHotkey('<Esc>', () => kitLog.push('parked'), { when: () => kitOpen })
    kitLog.length = 0
    return true;
  `)
  await t.press('Escape')
  t.is(await log(t), 'lower', 'when false parks the newest, so the key falls to the one under it')
  await t.evaluate(`kitOpen = true; return true;`)
  await t.press('Escape')
  t.is(await log(t), 'lower parked', 'when true, read at the key, gives it back')

  await t.evaluate(`kitOff.go = kitHotkey('gd', () => kitLog.push('go')); kitLog.length = 0; return true;`)
  await t.press('g')
  t.is(await log(t), '', 'g is pending: the start of gd')
  await t.press('d')
  t.is(await log(t), 'go', 'gd fires as a sequence')

  await t.evaluate(`
    kitOff.scoped = kitHotkey('x', () => kitLog.push('scoped'), { scope: document.querySelector('#inside') })
    kitLog.length = 0
    return true;
  `)
  await blur(t)
  await t.press('x')
  t.is(await log(t), '', 'a scoped hotkey is silent with focus outside its delegation root')
  await t.clickAt('#inside')
  await t.press('x')
  t.is(await log(t), 'scoped', 'and fires with focus inside it')
  t.is(await t.evaluate(`return window.kitLast;`), 'taken', 'a key it took is prevented for a listener further up, on window')
  t.is(await t.evaluate(`return window.kitListeners;`), 1, 'the scoped one listens on its root, not on document')

  await t.clickAt('#field')
  await t.type('x')
  t.is(await t.evaluate(`return document.querySelector('#value').textContent;`), 'x', 'in a field a bound letter types')
  t.is(await log(t), 'scoped', 'and fires nothing')
  await t.press('k', CTRL)
  t.is(await log(t), 'scoped palette', 'a Ctrl chord fires inside the field')

  const refused = await t.evaluate(`try { kitHotkey('mod+k', () => {}); return 'bound' } catch (e) { return e.message }`)
  t.ok(/web's spelling/.test(refused), `a chord in the web's spelling throws at the call — ${refused}`)

  const owned = await t.evaluate(`try { kitHotkey('<Mod-w>', () => {}); return 'bound' } catch (e) { return e.message }`)
  t.ok(/presses <D-w> on a Mac, which closes the tab in every browser/.test(owned), `a chord the browser takes throws at the call, naming it — ${owned}`)
  t.is(await t.evaluate(`return window.kitListeners;`), 1, 'and binds nothing')
  const attached = await t.evaluate(`try { kitKeys({ gg: 'top', '<C-Tab>': 'next' })(document.querySelector('#inside')); return 'attached' } catch (e) { return e.message }`)
  t.ok(/^keys\(\): '<C-Tab>' on a Mac switches tabs in every browser/.test(attached), `keys() refuses one at the attach — ${attached}`)
  const cancelable = await t.evaluate(`const off = kitHotkey('<Mod-s>', () => {}); off(); return 'bound';`)
  t.is(cancelable, 'bound', 'a key the browser lets a page cancel binds')

  await t.evaluate(`for (const off of Object.values(kitOff)) off(); return true;`)
  t.is(await t.evaluate(`return window.kitListeners;`), 0, 'the last dispose on document removes its listener')
  await t.press('k', CTRL)
  t.is(await log(t), 'scoped palette', 'and a disposed hotkey fires nothing')
}
