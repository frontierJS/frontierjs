/*
 * cell-wrap — `fixtures/CellWrap.mesa`: two cells, the second holding
 * paragraphs that wrap, each followed by a one-line marker (`FJS-3413`).
 *
 * At a width the cells do not divide, the engine gives each a fraction of a
 * column, measures a text at that width and paints it one column wider, so
 * the lines it paints are not the lines it was laid out with: a blank row is
 * left before the marker, or the marker is drawn over the paragraph's last
 * line. What a green run pins is that the second cell paints no blank row
 * between its first line and its last, read off the frame at odd widths and
 * after a resize from an even one. Equal flex shares alone fail at 45 and 47.
 */
export const name = 'cell-wrap'

/** The second cell's rows, from the first to the last marker. */
const cell = (frame) => {
  const lines = frame.split('\n')
  const x = lines[0].indexOf('one')
  const rows = lines.map((l) => l.slice(x).trimEnd())
  return rows.slice(0, rows.findIndex((r) => r === 'END-TWO') + 1)
}

const check = (t, frame, at) => {
  const rows = cell(frame)
  t.ok(rows.at(-1) === 'END-TWO' && rows.includes('END-ONE'), `${at}: both markers stand on rows of their own`)
  t.is(rows.filter((r) => r === '').length, 0, `${at}: no blank row inside the cell`)
}

export async function run(t) {
  const CellWrap = await t.compile('CellWrap')
  for (const width of [41, 45, 47]) {
    await t.mount(CellWrap, {}, { width, height: 20 })
    check(t, await t.frame(), `${width} columns`)
  }
  await t.mount(CellWrap, {}, { width: 46, height: 20 })
  await t.resize(45, 20)
  check(t, await t.frame(), 'resized from 46 to 45')
}
