/*
 * download.spec.mjs — `download()` from utils, saved by a real Chrome.
 *
 * Only the browser can say a file was saved: the anchor, the object URL and
 * the click are all invisible to a DOM test, and a URL revoked too early
 * cancels the save with nothing thrown. What is asserted is the file Chrome
 * wrote — its name and its bytes.
 */
export const name = 'download — a Blob saved under its name, a Response under the server\'s; openFile into its tab or, blocked, saved; a non-file refused'
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

  const named = t.nextDownload()
  await t.clickAt('#response')
  const answered = await named
  t.is(answered.name, 'résumé q3.csv', 'a Response is saved under the filename* it names, decoded')
  t.is(answered.text, 'id,total\n2,200\n', 'with the bytes of its body')

  const kept = t.nextDownload()
  await t.clickAt('#blocked')
  const fallback = await kept
  t.is(fallback.name, 'invoice.pdf', 'openFile with its popup blocked saves the file under name')

  await t.clickAt('#shown')
  await t.eventually(`document.getElementById('tab').textContent`, 'blob:',
    'openFile points the tab it opened on the click at the file')
  await t.clickAt('#failed')
  await t.eventually(`document.getElementById('tab').textContent`, 'closed',
    'a fetch that throws closes the blank tab')
  await t.eventually(`document.getElementById('refused').textContent`, 'no such invoice',
    'and the failure reaches the caller')

  await t.clickAt('#wrong')
  await t.eventually(`document.getElementById('refused').textContent.includes('a Blob or a Response')`, true,
    'a string is refused, naming what download takes')
}
