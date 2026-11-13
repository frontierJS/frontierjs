// web/src/lib/pasted-images.js
// An image pasted into a message box, shrunk to what a Claude run takes.
//
// The API refuses a body over its cap and an image over 5MB (cli's
// core/ask-claude.js readImages), and a phone-sized screenshot at full
// resolution is both. 1568px on the long edge is what the model sees anyway.
// The sizes match the dev server's ask panel (cli's core/vite-ask-client.js).

const SHOT_EDGE  = 1568
const SHOT_PNG   = 1024 * 1024
const THUMB_EDGE = 120

/** The image files on a paste, and whether the paste is images only. Copying
 *  from a page can put text and an image on the clipboard together; then the
 *  text still pastes. */
export function pastedImages(e) {
  const files = [...(e.clipboardData?.items ?? [])]
    .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
    .map(i => i.getAsFile()).filter(Boolean)
  return { files, only: files.length > 0 && !e.clipboardData.types.includes('text/plain') }
}

/** The image files on the clipboard, read through the async API. WebKitGTK
 *  (the Tauri shell on Linux) fires the paste event with no items for an image,
 *  so the event alone cannot find it; the clipboard read can. */
export async function clipboardImages() {
  const out = []
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) out.push(await item.getType(type))
  }
  return out
}

const canvasOf = (bitmap, edge) => {
  const k = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width  = Math.max(1, Math.round(bitmap.width * k))
  c.height = Math.max(1, Math.round(bitmap.height * k))
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height)
  return c
}
const blobOf = (c, type, q) => new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('the browser would not encode it')), type, q))
const base64Of = blob => new Promise((ok, no) => {
  const r = new FileReader()
  r.onload  = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1))
  r.onerror = () => no(r.error)
  r.readAsDataURL(blob)
})

/** `{ type, data, thumb }`: data is base64 with no `data:` prefix, thumb a data URL.
 *  A JPEG has no alpha, so a transparent PNG flattened onto one goes black
 *  where it was clear; white goes under it first. */
export async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file)
  const c = canvasOf(bitmap, SHOT_EDGE)
  let blob = await blobOf(c, 'image/png')
  if (blob.size > SHOT_PNG) {
    const flat = document.createElement('canvas')
    flat.width = c.width; flat.height = c.height
    const g = flat.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, flat.width, flat.height); g.drawImage(c, 0, 0)
    blob = await blobOf(flat, 'image/jpeg', 0.85)
  }
  const thumb = canvasOf(bitmap, THUMB_EDGE).toDataURL('image/jpeg', 0.7)
  bitmap.close?.()
  return { type: blob.type, data: await base64Of(blob), thumb }
}
