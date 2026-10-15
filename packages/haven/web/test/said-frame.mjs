/**
 * web/test/said-frame.mjs — a line said in the square, drawn headless: the
 * square mounted through Sierra's terminal loader as `stage.mjs` mounts it,
 * the real `Bubbles.mesa` over it, and the bubble's row read back cell by
 * cell from OpenTUI's `captureSpans()`. `emoji.test.js` runs it as a child.
 *
 *   bun web/test/said-frame.mjs '[{ "body": "hi 🙂", "dx": 6, "dy": -4 }]'
 *
 * Each line is said by a member `dx`, `dy` cells from this figure, which
 * stands at the spawn or at `me` (view cells; earshot is 16 across). Prints
 * one JSON row per line: `{ body, by, w, before, after }` — the screen row the
 * bubble sits on, as a list of cells, each a grapheme or `''` for the second
 * cell of a wide one, before the line was said and after.
 *
 * Traps:
 * - A child, never an import: the messages store answers only once a Junction
 *   client exists, and `bun test` shares one module cache across files, so a
 *   resource another test made first would stay the empty one for good.
 * - The client points at a port nobody answers on and holds no token, so it
 *   opens no socket; the store is filled by hand.
 */
import { join } from 'node:path'
import { initJunction } from '@frontierjs/sierra/resource'
import * as tui from '@frontierjs/mesa/runtime/terminal.js'
import { installTerminalLoader } from '../../../sierra/src/terminal/loader.js'
import { stages } from '../src/stage.js'
import { WEB } from './stage.mjs'

// The square's leaves shimmer on the wall clock, so a cell of art read before
// a line is said and again after can differ with no bubble near it.
const FROZEN = Date.now()
Date.now = () => FROZEN

initJunction({ url: 'http://127.0.0.1:9', debug: false })
await installTerminalLoader({ root: WEB })
const Square  = (await import(join(WEB, 'src/scenes/Square.mesa'))).default
const Bubbles = (await import(join(WEB, 'src/components/Bubbles.mesa'))).default
const { messages } = await import(join(WEB, 'src/resources/Message.mesa'))

const settle = async (t) => { await new Promise((r) => setTimeout(r, 20)); await t.renderOnce() }

/**
 * Row `y` of the frame as cells, `''` for the second cell of a wide grapheme.
 * Read off the buffer itself, whose top two bits mark that second cell:
 * `captureSpans()` sums a span's width from its text and counts a skin tone,
 * a flag or a ZWJ sequence a cell or two wider than the engine drew it.
 */
const rowCells = (t, y) => {
  const buf = t.renderer.currentRenderBuffer
  const chars = buf.buffers.char
  const drawn = [...new Intl.Segmenter().segment(t.captureCharFrame().split('\n')[y])].map((g) => g.segment)
  const out = []
  for (let x = 0, k = 0; x < buf.width; x++) out.push(chars[y * buf.width + x] >>> 30 === 3 ? '' : drawn[k++] ?? ' ')
  return out
}

const t = await tui.createHeadlessRenderer({ width: 100, height: 30 })
tui.mount(Square, { renderer: t.renderer })
await settle(t)
const stage = stages.get('square')
const view = stage.view
const spawn = stage.spawn

for (const [i, { body, dx, dy, me = spawn }] of JSON.parse(process.argv[2]).entries()) {
  const them = { userId: 2, connectionId: 'c2', meta: { x: me.x + dx, y: me.y + dy } }
  const here = { get: () => ({ self: { userId: 1 }, others: [them] }) }
  const by = them.meta.y - view.y - 1
  const before = rowCells(t, by)
  messages.store.set([{ id: i + 1, memberId: 2, roomId: 1, body }])
  const m = tui.mount(Bubbles, { renderer: t.renderer, props: { here, x: me.x, y: me.y, view, spawn } })
  await settle(t)
  const after = rowCells(t, by)
  console.log(JSON.stringify({ body, by, w: view.w, before, after }))
  m.dispose()
  await settle(t)
}
process.exit(0)
