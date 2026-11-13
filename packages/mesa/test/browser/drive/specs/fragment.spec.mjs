/*
 * fragment — navigate() to a URL that differs from the page's only by its
 * fragment loads a new document.
 *
 * Chrome treats such a Page.navigate as a same-document navigation: the hash
 * changes and the page under test stays up, so a drive opening a second
 * /share/#token after a first graded the old page (FJS-4238).
 */
export const name = 'fragment — navigate() to a hash-only change remounts the page'

export async function run(t) {
  const b = await t.openChrome()
  try {
    await b.navigate(`${t.origin}fragment#one`)
    await b.evaluate(`window.stale = true; return true`)
    await b.navigate(`${t.origin}fragment#two`)
    t.is(await b.evaluate(`return location.hash`), '#two', 'navigate lands on the new fragment')
    t.is(await b.evaluate(`return window.stale ?? null`), null, 'on a new document, not the old one')

    await b.evaluate(`window.stale = true; return true`)
    await b.navigate(`${t.origin}fragment#two`)
    t.is(await b.evaluate(`return window.stale ?? null`), null, 'the same URL again is a new document too')

    const p = await b.newPage(`${t.origin}fragment#one`)
    try {
      await p.evaluate(`window.stale = true; return true`)
      await p.navigate(`${t.origin}fragment#two`)
      t.is(await p.evaluate(`return location.hash`), '#two', 'a second page lands on the new fragment')
      t.is(await p.evaluate(`return window.stale ?? null`), null, 'on a new document as well')
    } finally { await p.close() }
  } finally { await b.close() }
}
