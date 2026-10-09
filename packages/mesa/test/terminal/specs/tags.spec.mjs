/*
 * tags — `fixtures/Tags.mesa`: a table, a rule, a definition list and a key.
 *
 * A terminal has no auto table layout, so a cell takes an equal share of its
 * row and the columns line up because every row divides the same width the
 * same way. What a green run pins is the alignment, read off the frame as a
 * column index: a header and every body row put their second cell at one
 * column, including a row added after mount whose first cell is wider than
 * the header's. An auto flex basis passes the first frame and fails the
 * second, since each row then sizes to its own content.
 */
export const name = 'tags'

const col = (frame, text) => {
  const line = frame.split('\n').find((l) => l.includes(text))
  return line ? line.indexOf(text) : -1
}

export async function run(t) {
  await t.mount(await t.compile('Tags'))
  const before = await t.frame()
  t.expectFrame(before, ['Name', 'Qty', 'Widget', '3', '────', 'Term', 'meaning', 'Press', 'Enter', '[ Add ]'])
  t.is(col(before, '3'), col(before, 'Qty'), 'a body cell sits under its header')
  t.is(col(before, 'meaning'), col(before, 'Term') + 2, '<dd> is indented under its <dt>')

  await t.tab()
  await t.enter()
  const after = await t.frame()
  t.expectFrame(after, ['Widget', 'Gadget', '10'], 'the row added live is painted')
  t.is(col(after, '10'), col(after, 'Qty'), 'a row wider than the header keeps its column')
}
