// src/cell.js — put a box on one cell of a scene (`FJS-D978`), in the
// terminal. `#cell` resolves here; a browser takes `cell.browser.js`.
//
// The terminal paints no CSS, so `style:left` places nothing; this writes the
// engine's own fields on the renderable. It is a factory the template calls,
// `{@attach at(m.x, m.y)}`, because an attach that read the coordinates only
// inside its body would never run again when a keyed `{#each}` replaces the
// item, and the figure would stay where it was mounted.
//
// The cell is counted from the box the attached node sits in, so a scene
// keeps its art and its figures in one wrapper. A `size` of `[cols, rows]`
// makes the box a pane over that many cells; without one the box is as big
// as what it holds.
import { StyledText, TextAttributes, TextRenderable } from '@opentui/core'

export const at = (col, row, layer = 10, size = null) => (el) => {
  el.position = 'absolute'
  el.left     = Math.max(0, col)
  el.top      = Math.max(0, row)
  el.zIndex   = layer
  if (size) {
    el.width  = size[0]
    el.height = size[1]
  }
}

// A text that is a terminal hyperlink (OSC 8): the words stay, underlined, and
// the terminal opens `url` when they are clicked. The URL is never printed, so
// a ticket's row is as short as its title. A factory for the reason `at` is;
// the text read is the node's own, so it is attached to the `<p>` that holds it.
// A terminal that does not say it has hyperlinks would show an underlined
// title and lose the URL, so `seen(supported)` is told, and the caller prints
// the URL itself when it is false.
// A text drawn in a color: the node's own `fg`. The terminal paints no CSS, so a
// `style:color` on a `<p>` colors nothing here. Taking the box's first text when
// the attach sits on a wrapper is `linked`'s reading, for the same reason. No
// color leaves the terminal's own ink: an `fg` of undefined is not that. A
// `ground` is the text's `bg`, under every cell of it, its spaces included.
export const tint = (color, ground) => (el) => {
  if (!color && !ground) return
  const text = el instanceof TextRenderable ? el : el.getChildren().find((c) => c instanceof TextRenderable)
  if (!text) return
  if (color)  text.fg = color
  if (ground) text.bg = ground
}

export const linked = (url, seen = () => {}) => (el) => {
  const supported = el.ctx?.capabilities?.hyperlinks === true
  seen(supported)
  if (!supported) return
  const text = el instanceof TextRenderable ? el : el.getChildren().find((c) => c instanceof TextRenderable)
  if (!text) return
  text.content = new StyledText([
    { __isChunk: true, text: text.plainText, attributes: TextAttributes.UNDERLINE, link: { url } },
  ])
}
