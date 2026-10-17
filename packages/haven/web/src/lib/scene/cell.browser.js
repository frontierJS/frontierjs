// src/cell.browser.js — put a box on one cell of a scene, in a browser
// (`FJS-D978`). `#cell` resolves here under the `browser` condition and to
// `cell.js` in the terminal, so `Scene.mesa` writes `{@attach at(x, y)}` once.
//
// A cell is `1ch` wide and `1lh` tall, the units the art's `<pre>` is laid in
// (`paint.browser.js`). Both units are read off the PLACED element's own font
// and line height, so the box inherits them from the scene's box rather than
// taking a paragraph's; and a margin or a surface's padding would move its
// glyph off the cell the art has there.
//
// A factory the template calls, for the reason `cell.js` gives: an attach that
// read the coordinates inside its body would not re-run when a keyed
// `{#each}` replaces the item.
export const at = (col, row, layer = 10, size = null) => (el) => {
  const s = el.style
  s.position   = 'absolute'
  s.left       = `${Math.max(0, col)}ch`
  s.top        = `${Math.max(0, row)}lh`
  s.zIndex     = String(layer)
  s.margin     = '0'
  s.padding    = '0'
  s.font       = 'inherit'
  s.lineHeight = 'inherit'
  s.whiteSpace = 'pre'
  if (size) {
    s.width    = `${size[0]}ch`
    s.height   = `${size[1]}lh`
    s.overflow = 'hidden'
  }
}

// A text in a color, in a browser: the element's own `color`, and `ground` its
// `background`, over the surface's own.
export const tint = (color, ground) => (el) => {
  el.style.color = color ?? ''
  el.style.background = ground ?? ''
}

// A text that is a link, in a browser: the words become an anchor to `url`.
// (`cell.js` has the terminal's.) Reachable only where a command ran on the
// machine, which a page cannot, so no ticket reaches it today.
export const linked = (url, seen = () => {}) => (el) => {
  seen(true)
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.textContent = el.textContent
  el.replaceChildren(a)
}
