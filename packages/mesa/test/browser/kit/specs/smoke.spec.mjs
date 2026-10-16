/*
 * smoke — the kit drive's harness.
 *
 * Every wrapper answers by `isBrowserClient()`, and under a server render that
 * answer is the wrapper's default. A page that came up with the flag pair
 * wrong would pass every spec here against defaults, so the first thing
 * asserted is that the tab is a browser client. The second is that the
 * subpath an app writes resolves: a fixture failing to import it reads as
 * every wrapper failing at once.
 */
export const name = 'smoke — the kit harness'

export async function run(t) {
  await t.mount('smoke')

  t.is(await t.evaluate(`return document.querySelector('#client').textContent;`), 'true',
    'the drive page is a browser client, so a wrapper answers live rather than its default')
  t.is(await t.evaluate(`return document.querySelector('#kit').textContent;`), 'object',
    "a fixture imports '@frontierjs/mesa/browser' by the specifier an app writes")
}
