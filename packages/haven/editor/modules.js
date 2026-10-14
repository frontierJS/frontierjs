// editor/modules.js — Haven's scenes and shared pieces, as the modules
// Haven itself evaluates: each scene is its component, mounted on the page as
// the preview, and a shared piece is one a click can place. A scene file
// saved here is a module Vite is serving, so the editor is swapped onto it as
// written. Which directory they come from is the editor's Vite config's
// (`SCENES_DIR`).
import { sceneModules, pieceModules } from 'virtual:haven-scenes'

/** Each scene by its file name, `Square.mesa` → its component. */
export const scenes = Object.fromEntries(Object.entries(sceneModules).map(([path, mod]) => [path.split('/').pop(), mod.default]))

/**
 * The pieces `pieces/` exports, `[{ ident, file, piece }]` — one per export,
 * so a stamp names the ident its tag writes and the file its import names.
 * `frame` is left out: a scene has one.
 */
export const shared = Object.entries(pieceModules).flatMap(([path, mod]) => {
  const file = path.split('/').pop()
  return Object.entries(mod)
    .filter(([ident, v]) => ident !== 'frame' && v && typeof v === 'object' && Array.isArray(v.cells))
    .map(([ident, piece]) => ({ ident, file, piece }))
})
