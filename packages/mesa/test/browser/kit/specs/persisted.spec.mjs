/*
 * persisted — #1, a preference in localStorage, read live.
 *
 * What a green run pins: a write lands under the app's prefix and re-renders
 * this tab; a write from ANOTHER tab re-renders it too (the storage event
 * never fires in the tab that wrote, so one tab cannot prove the cross-tab
 * half); a credential key is refused by name; a refused setItem keeps the
 * value for the tab and warns once; an unparseable stored value reads the
 * fallback and warns once.
 *
 * Every case takes its own key. The once-per-key warning set lives as long as
 * the module, and the module lives as long as the tab.
 */
export const name = 'persisted — a preference in localStorage'

const text = (t) => t.evaluate(`return document.querySelector('#value').textContent;`)

export async function run(t) {
  await t.evaluate(`localStorage.clear(); return true;`)
  await t.mount('persisted', { key: 'rail', fallback: 'open', prefix: 'kit' })

  t.is(await text(t), 'open', 'nothing stored reads the fallback')

  await t.evaluate(`window.kitPref.value = 'closed'; return true;`)
  t.is(await t.evaluate(`return localStorage.getItem('kit:rail');`), '"closed"',
    'a write is stored as JSON under prefix:key')
  await t.eventually(`document.querySelector('#value').textContent`, 'closed',
    'a write re-renders this tab, where the storage event never fires')

  await t.evaluate(`window.kitPersisted('rail', 'other').value = 'two'; return true;`)
  await t.eventually(`document.querySelector('#value').textContent`, 'two',
    'a second handle on the same key, written, re-renders the first')

  const other = await t.tab()
  try {
    await other.evaluate(`localStorage.setItem('kit:rail', JSON.stringify('shut')); return true;`)
    await t.eventually(`document.querySelector('#value').textContent`, 'shut',
      'a write from another tab re-renders this one')

    await other.evaluate(`localStorage.setItem('kit:rail', '{not json'); return true;`)
    await t.eventually(`document.querySelector('#value').textContent`, 'open',
      'an unparseable stored value reads the fallback')
    const parse = (await t.warnings()).filter((w) => w.includes("persisted('rail')") && w.includes('does not parse'))
    t.is(parse.length, 1, 'and warns once, naming the key')

    await other.evaluate(`localStorage.clear(); return true;`)
    await t.evaluate(`window.kitPref.value = 'closed'; return true;`)
    await t.eventually(`document.querySelector('#value').textContent`, 'closed', 'written again')
    await other.evaluate(`localStorage.clear(); return true;`)
    await t.eventually(`document.querySelector('#value').textContent`, 'open',
      'another tab clearing storage reads the fallback')
  } finally {
    await other.close()
  }

  await t.evaluate(`window.kitPref.value = 'closed'; window.kitPref.reset(); return true;`)
  t.is(await t.evaluate(`return localStorage.getItem('kit:rail');`), null, 'reset() removes the stored key')
  await t.eventually(`document.querySelector('#value').textContent`, 'open', 'and reads the fallback')

  t.ok(String(await t.evaluate(`
    try { window.kitPersisted('portal_token', null); return 'accepted'; }
    catch (e) { return e.message; }
  `)).includes('tokenStorage'), 'a credential key is refused, naming the owner of tokens')

  // A full quota: setItem throws, and the toggle must still work for the tab.
  await t.mount('persisted', { key: 'quota', fallback: 'a', prefix: 'kit' })
  const kept = await t.evaluate(`
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError') };
    try {
      window.kitPref.value = 'b';
      window.kitPref.value = 'c';
    } finally { Storage.prototype.setItem = real }
    return localStorage.getItem('kit:quota');
  `)
  t.is(kept, null, 'a refused write stores nothing')
  await t.eventually(`document.querySelector('#value').textContent`, 'c',
    'and the value holds for this tab')
  const quota = (await t.warnings()).filter((w) => w.includes("persisted('quota')") && w.includes('QuotaExceededError'))
  t.is(quota.length, 1, 'warning once, naming the key and the refusal')
}
