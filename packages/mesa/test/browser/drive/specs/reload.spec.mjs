/*
 * reload — a first page load that the page's own dev server reloads mid-wait.
 *
 * Vite re-optimizes dependencies on a cold cache and reloads the page while
 * navigate() is waiting for load; the evaluate it holds dies with the old
 * document ("Inspected target navigated or closed") and the drive read the
 * reload as a closed target (FJS-4245).
 */
export const name = 'reload — navigate() waits out a reload during the first load'

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(`${t.origin}reloads-once`, 'window.settled')
    t.is(await b.evaluate(`return location.pathname`), '/reloads-once', 'navigate resolves on the reloaded document')
    t.ok(await b.evaluate(`return window.settled === true`), 'and the page it resolved on is the settled one')
  } finally { await b.close() }
}
