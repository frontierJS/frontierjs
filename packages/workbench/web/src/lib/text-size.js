// web/src/lib/text-size.js -- the root font size, in px.
//
// Every type and space token in @frontierjs/css is rem, so one number on <html>
// scales the whole app. Like the theme it is a fact about this browser, kept
// under the app's storage prefix and not on the member.

import { persisted } from '@frontierjs/mesa/browser'

export const TEXT_SIZE = { min: 12, max: 22, step: 1, fallback: 16 }

const stored = persisted('text-size', TEXT_SIZE.fallback, {
  parse: (raw) => {
    const n = Number(raw)
    return n >= TEXT_SIZE.min && n <= TEXT_SIZE.max ? n : TEXT_SIZE.fallback
  },
  format: String,
})

/** The size in px, tracked. */
export const textSize = () => stored.value

/** Put the stored size on <html>. Boot calls it once; `setTextSize` calls it after. */
export function applyTextSize() {
  document.documentElement.style.fontSize = `${stored.value}px`
}

export function setTextSize(px) {
  stored.value = px
  applyTextSize()
}

export function resetTextSize() {
  stored.reset()
  applyTextSize()
}

/** A px size that is a fixed number elsewhere (xterm's), scaled with the root. */
export const scaled = (px) => Math.round(px * stored.value / TEXT_SIZE.fallback)
