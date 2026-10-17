/*
 * evaluate — a call held until the page settles, flags passed through, and the
 * browser-level `send()`.
 */
export const name = 'evaluate — held until settled; args and send() reach Chrome'

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(t.origin)
    t.is(await b.evaluate(`return await new Promise((r) => setTimeout(() => r(globalThis.__driveHeld.size), 10))`), 1,
      'an evaluate is held by the page until it settles')
    t.is(await b.evaluate(`return globalThis.__driveHeld.size`), 0, 'then released')
  } finally { await b.close() }

  const c = await t.openChrome({ args: ['--user-agent=fjs-drive-probe'] })
  try {
    await c.navigate(t.origin)
    t.is(await c.evaluate(`return navigator.userAgent`), 'fjs-drive-probe', 'args reach Chrome')
    const { targetInfos } = await c.send('Target.getTargets')
    t.ok(targetInfos.some((x) => x.type === 'page' && x.url === t.origin), 'send() is the browser-level call')
  } finally { await c.close() }
}
