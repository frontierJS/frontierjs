/*
 * {@html} — the construct RULE 33 attaches a security warning to, executed.
 *
 * Nothing anywhere ran it. A grep for `setInnerHTML` across the suite returned
 * two `toContain` assertions on emitted JavaScript, a comment, and a regex over
 * the REPL example — so the one place in the package that parses caller data as
 * markup had no executed assertion under it, and the line that removes the
 * previously injected nodes could be deleted with the suite still green
 * (FJS-869).
 *
 * Every assertion here is about what is IN THE DOM after a re-run, because that
 * is the half a substring match cannot reach. The anchor is a comment, the
 * injected nodes are its siblings, and `before`/`after` are text nodes on either
 * side that must never move — a removal walking the wrong range takes them.
 */
export const name = '{@html} replaces what it injected (FJS-869)'
export const covers = ['html', 'setInnerHTML']

const marks = `[...document.querySelectorAll('#host .mark')].map(e => e.tagName + ':' + e.textContent).join(',')`
const text  = `document.getElementById('host').textContent`

export async function run(t) {
  await t.mount('html')

  t.is(await t.evaluate(`return ${marks};`), 'B:one', 'the markup was parsed rather than escaped')
  t.is(await t.evaluate(`return ${text};`), 'beforeoneafter', 'and it landed between the text on either side')

  // The assertion the row is about. An append-instead-of-replace bug reads as
  // 'B:one,I:two' here and is invisible to anything grading the emitted module.
  await t.clickAt('#replace')
  await t.eventually(marks, 'I:two', 'a re-run REPLACES what the previous run injected')
  t.is(await t.evaluate(`return ${text};`), 'beforetwoafter',
    'and the text on either side of the anchor is untouched')

  // More than one node, because the removal tracks a LIST and a fix that kept
  // only the last reference would pass every single-node assertion above.
  await t.clickAt('#grow')
  await t.eventually(marks, 'B:a,B:b', 'a value that parses to several nodes injects all of them')
  await t.clickAt('#replace')
  await t.eventually(marks, 'I:two', 'and every one of them is removed on the next run')

  // Empty and nullish are the two the runtime guards separately.
  await t.clickAt('#clear')
  await t.eventually(marks, '', 'an empty string removes the injected nodes')
  t.is(await t.evaluate(`return ${text};`), 'beforeafter', 'leaving the surrounding text alone')

  await t.clickAt('#replace')
  await t.eventually(marks, 'I:two', 'and the block recovers after being emptied')
  await t.clickAt('#nullify')
  await t.eventually(marks, '', 'null removes them too')

  t.is(await t.evaluate(`return document.getElementById('runs').textContent;`), '6',
    'all of that was six reactive runs of one block, not six mounts')

  t.is((await t.warnings()).length, 0, 'no warning anywhere in it')
}
