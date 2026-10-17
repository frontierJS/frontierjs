/*
 * png — an element to a PNG, alone and at the scale asked for.
 */
import { printDocument } from '../../index.js'

export const name = 'a PNG'

const pngSize = (bytes) => { const b = Buffer.from(bytes); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } }

export async function run(t) {
  const png = await t.printer.png(printDocument({
    body: '<p>above</p><svg id="chart" width="200" height="100" style="display:block"><rect width="200" height="100" fill="teal"/></svg>',
  }), { selector: '#chart', scale: 2 })
  t.is(Buffer.from(png.slice(1, 4)).toString(), 'PNG', 'is a PNG')
  t.is(JSON.stringify(pngSize(png)), JSON.stringify({ width: 400, height: 200 }), 'the element alone, at the scale asked for')

  let refused = ''
  await t.printer.png(printDocument({ body: '<p>x</p>' }), { selector: '#nope' }).catch((e) => { refused = e.message })
  t.match(refused, /nothing in the document matches #nope/, 'names a selector that matches nothing')
}
