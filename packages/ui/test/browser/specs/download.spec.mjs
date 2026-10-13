/*
 * download.spec.mjs — `download()` from utils, saved by a real Chrome.
 *
 * Only the browser can say a file was saved: the anchor, the object URL and
 * the click are all invisible to a DOM test, and a URL revoked too early
 * cancels the save with nothing thrown. What is asserted is the file Chrome
 * wrote — its name and its bytes.
 */
export const name = 'download — a Blob saved under its name; a non-Blob refused'
export const covers = []

export async function run(t) {
  await t.mount('download')

  const saved = t.nextDownload()
  await t.clickAt('#save')
  const file = await saved
  t.is(file.name, 'orders.csv', 'the file is saved under the name given')
  t.is(file.text, 'id,total\n1,100\n', 'with the bytes of the Blob')
  t.is(await t.evaluate(`return document.querySelectorAll('a[download]').length;`), 0,
    'and the anchor it clicked is not left in the document')

  await t.clickAt('#wrong')
  await t.eventually(`document.getElementById('refused').textContent.includes('await res.blob()')`, true,
    'a Response is refused, naming the call that turns it into a Blob')
}
