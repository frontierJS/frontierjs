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
