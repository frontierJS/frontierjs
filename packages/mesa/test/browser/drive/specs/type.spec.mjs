/*
 * type — text typed through the input pipeline arrives whole.
 *
 * A character outside the BMP is two UTF-16 units. `type` walks code points, so
 * the unit a key sees is a surrogate pair of length 2, which a `k.length === 1`
 * test reads as a named key and sends no `text` (FJS-2880).
 */
export const name = 'type — a character outside the BMP is typed, not dropped'

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(t.origin)
    await b.evaluate(`
      const i = document.createElement('input');
      i.id = 'f'; document.body.append(i); i.focus();
      return true;
    `)
    await b.type('a🙂b')
    t.is(await b.evaluate(`return document.getElementById('f').value`), 'a🙂b', 'an emoji between two letters is typed')
    await b.type('👩‍💻')
    t.is(await b.evaluate(`return document.getElementById('f').value`), 'a🙂b👩‍💻', 'a ZWJ sequence arrives whole')
  } finally { await b.close() }
}
