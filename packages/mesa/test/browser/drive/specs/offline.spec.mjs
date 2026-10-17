/*
 * offline — `createNetwork` refuses the network and severs the app's socket,
 * and leaves vite-hmr alone, because a dev server that loses its socket reloads
 * the page the drive is asserting on.
 */
export const name = 'offline — the network refused, the app socket severed, vite-hmr kept'

export async function run(t) {
  const b = await t.openChrome()
  try {
    const net = await t.createNetwork(b)
    await b.navigate(t.origin + 'sockets', 'window.app.readyState === 1 && window.hmr.readyState === 1')
    t.is(await b.evaluate(`return await reach()`), 'reached', 'the page reaches its server online')

    const inside = await net.withOffline(() => b.evaluate(`
      return reach().then((r) => ({ r, app: app.readyState, hmr: hmr.readyState }))
    `))
    t.is(inside.r, 'refused', 'offline refuses the network')
    t.ok(inside.app >= 2, 'and severs the app socket')
    t.is(inside.hmr, 1, 'but not vite-hmr')
    t.is(net.severed, 1, 'and counts what it severed')

    // The page opened no new socket, so there is none to wait for.
    await b.evaluate(`window.app = null; return true`)
    t.is(await net.waitOnline({ tries: 20 }), true, 'waitOnline returns once back online')
    t.is(await b.evaluate(`return await reach()`), 'reached', 'and the page reaches its server again')
  } finally { await b.close() }

  const c = await t.openChrome()
  try {
    await c.navigate(t.origin + 'sockets', 'window.app.readyState === 1')
    const net = await t.createNetwork(c)
    t.is(await net.goOffline(), null, 'a page loaded before createNetwork has no registry, and goOffline says so')
    await net.goOnline()
  } finally { await c.close() }
}
