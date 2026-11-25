// web/src/lib/pasted-images.js
// An image pasted into a message box, shrunk to what a Claude run takes.
//
// The API refuses a body over its cap and an image over 5MB
// (`readImages` in `@frontierjs/claude`), and a phone-sized screenshot at full
// resolution is both. 1568px on the long edge is what the model sees anyway.
// The sizes match the dev server's ask panel (cli's core/vite-ask-client.js).

import { fitImage } from '@frontierjs/ui/paste'

const SHOT_EDGE  = 1568
const SHOT_PNG   = 1024 * 1024
const THUMB_EDGE = 120

const canvasOf = (bitmap, edge) => {
  const k = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width  = Math.max(1, Math.round(bitmap.width * k))
  c.height = Math.max(1, Math.round(bitmap.height * k))
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height)
  return c
}
const base64Of = blob => new Promise((ok, no) => {
  const r = new FileReader()
  r.onload  = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1))
  r.onerror = () => no(r.error)
  r.readAsDataURL(blob)
})

/** `{ type, data, thumb }`: data is base64 with no `data:` prefix, thumb a data URL.
 *  The fitting is ui's `fitImage`; the numbers above are this caller's. */
export async function shrinkImage(file) {
  const blob = await fitImage(file, { edge: SHOT_EDGE, maxBytes: SHOT_PNG })
  const bitmap = await createImageBitmap(file)
  const thumb = canvasOf(bitmap, THUMB_EDGE).toDataURL('image/jpeg', 0.7)
  bitmap.close?.()
  return { type: blob.type, data: await base64Of(blob), thumb }
}
