/*
 * errors — what lands in `browser.errors`, and what `on()` hears instead.
 *
 * A [Mesa] warning is a render the framework survived but corrupted, so it is
 * an error; a page's own warning is chatter, and only a subscriber hears it.
 */
export const name = 'errors — a [Mesa] warning counts, page chatter does not'

const settle = () => new Promise((r) => setTimeout(r, 100))

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(t.origin)
    await b.evaluate(`console.warn('[Mesa] duplicate key'); console.warn('page chatter'); return true`)
    await settle()
    t.is(JSON.stringify(b.errors), JSON.stringify(['console.warn: [Mesa] duplicate key']),
      'a [Mesa] warning is an error and a page warning is not')
  } finally { await b.close() }

  const c = await t.openChrome()
  try {
    await c.navigate(t.origin)
    const heard = []
    const off = c.on('Runtime.consoleAPICalled', (p) => heard.push(`${p.type}: ${p.args[0].value}`))
    await c.evaluate(`console.warn('page chatter'); return true`)
    await settle()
    off()
    await c.evaluate(`console.warn('after'); return true`)
    await settle()
    t.is(JSON.stringify(heard), JSON.stringify(['warning: page chatter']), 'on() hears what the errors pass over, until it unsubscribes')
    t.is(c.errors.length, 0, 'and none of it is an error')
  } finally { await c.close() }
}
