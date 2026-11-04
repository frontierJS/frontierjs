// web/src/lib/commands.js -- the rows a screen adds to the ⌘K palette.
//
// The palette lives in routes/_module.mesa and holds the app-wide rows (the
// nav, the themes, sign out); what a screen can do -- stage a checkout, Focus
// -- is that screen's state. A screen hands over a function rather than rows:
// the palette mounts fresh on every open and calls it then, so the rows are
// never older than the open.

let source = null

/** Returns the release; call it on destroy, or a later screen's palette offers this one's rows. */
export function providePageCommands(fn) {
  source = fn
  return () => { if (source === fn) source = null }
}

export function pageCommands() {
  try { return source?.() ?? [] } catch { return [] }
}
