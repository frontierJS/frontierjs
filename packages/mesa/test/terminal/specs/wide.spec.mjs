/*
 * wide — `fixtures/Wide.mesa`: a grapheme of several code points typed into
 * an `<input>` and a `<textarea>`, each written to the engine in one chunk as
 * a terminal writes it (`t.press`, never `t.type`, which splits a string into
 * UTF-16 units and so types half an emoji).
 *
 * A green run pins: the engine reads such a chunk a code point at a time, and
 * the field still ends with its cursor right after the grapheme — the next
 * key lands after it, Left steps over it whole and Backspace takes it whole —
 * for a skin tone, a ZWJ sequence, a flag, a VS16 heart and a combining mark.
 * Without the join the cursor sat a cluster's width past the text, or inside
 * a combining one, and `b` went in before the accent.
 */
export const name = 'wide'

const SAID = ['👍🏽', '👩‍💻', '🇯🇵', '❤️', 'é']

export async function run(t) {
  for (const [field, open, close] of [['input', '[', ']'], ['textarea', '<', '>']]) {
    for (const g of SAID) {
      await t.mount(await t.compile('Wide'), {}, { width: 40, height: 10 })
      await t.settle()
      await t.tab()
      if (field === 'textarea') await t.tab()
      await t.press('a')
      await t.press(g)
      const [col] = await t.cursor()
      t.is(col, 1 + Bun.stringWidth(`a${g}`), `${field}: the cursor stands right after ${JSON.stringify(g)}`)
      await t.press('b')
      t.expectFrame(await t.frame(), [`${open}a${g}b${close}`], `${field}: ${JSON.stringify(g)} typed, then b after it`)
      await t.press('ARROW_LEFT')
      await t.press('ARROW_LEFT')
      await t.press('c')
      t.expectFrame(await t.frame(), [`${open}ac${g}b${close}`], `${field}: Left steps over ${JSON.stringify(g)} whole`)
      await t.press('ARROW_RIGHT')
      await t.press('BACKSPACE')
      t.expectFrame(await t.frame(), [`${open}acb${close}`], `${field}: Backspace takes ${JSON.stringify(g)} whole`)
    }
  }
  await t.unmount()
}
