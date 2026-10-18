// src/lib/marks.js — a package's mark: one cell and one ink, the terminal's
// cut of its icon in `brand/assets/icons/` (the subject drawn small, in the
// icon's own ink), so the kitchen's ticket, station and 86 board for one
// package are found by eye. Keyed as a bench is (`benchOf` in `#workers`) and
// as the ledger is: a package folder, `example`, or `frontierjs` for the rest
// of the repo. Each glyph is one column wide in a western terminal; a wide
// one would push the rest of its row a cell right.

const BLUE = '#2db8e2', RED = '#f04318', ORANGE = '#f4912a', SAND = '#cbad82', GREEN = '#adc858'

export const MARKS = {
  auth:                { glyph: '∩', ink: BLUE },    // the gate
  basecamp:            { glyph: '⚑', ink: RED },     // the tent's flag
  caravan:             { glyph: '⊛', ink: ORANGE },  // a wagon wheel
  cli:                 { glyph: '›', ink: SAND },    // the prompt
  conduit:             { glyph: '≡', ink: GREEN },   // the wires
  config:              { glyph: '▭', ink: SAND },    // the level
  'create-frontier':   { glyph: '↱', ink: GREEN },   // the signpost
  css:                 { glyph: '≋', ink: SAND },    // the contours
  'email-kit':         { glyph: '⊠', ink: ORANGE },  // the envelope
  example:             { glyph: '⊞', ink: BLUE },
  frontierjs:          { glyph: '§', ink: ORANGE },  // the docs
  'frontierjs-vscode': { glyph: '✎', ink: BLUE },    // the pen
  haven:               { glyph: '⌂', ink: ORANGE },
  jetty:               { glyph: 'π', ink: BLUE },    // the pier
  junction:            { glyph: '⊗', ink: GREEN },   // the crossing
  litestone:           { glyph: '◇', ink: BLUE },    // the gem
  mcp:                 { glyph: '⌁', ink: BLUE },    // the telegraph
  mesa:                { glyph: '∏', ink: ORANGE },  // the mesa
  notifications:       { glyph: 'ψ', ink: RED },     // the campfire
  oracle:              { glyph: '⌕', ink: GREEN },   // the glass
  orion:               { glyph: '✧', ink: RED },     // the stars
  outpost:             { glyph: '♜', ink: ORANGE },  // the tower
  'print-kit':         { glyph: '⎙', ink: SAND },
  sierra:              { glyph: '▲', ink: RED },     // the range
  'site-kit':          { glyph: '¶', ink: GREEN },
  testing:             { glyph: '✓', ink: BLUE },    // the target
  toolbelt:            { glyph: '∡', ink: SAND },    // the dividers
  ui:                  { glyph: '▣', ink: GREEN },   // the window
}

const NONE = { glyph: '·', ink: '#78716c' }

/** The mark of the package `name`; one with none drawn yet gets a dim dot. */
export const markOf = (name) => MARKS[name] ?? NONE
