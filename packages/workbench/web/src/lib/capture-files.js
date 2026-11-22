// web/src/lib/capture-files.js -- a capture's bytes for a tag, and onto the clipboard.
//
// GET /capture-file/{name} answers only a signed-in member, and an <img src> sends no
// bearer, so the bytes go through `client.fetch` (which carries the client's own
// credentials) and the page draws a blob URL, as the chat's files do (lib/files.js).
// The page is tauri://localhost in the desktop shell and :5508 in a browser, and the
// API is on another origin in both; `client.fetch` is what knows where.
//
// An image is small and is fetched once per tab, keyed on its size and time so a file
// written over is read again. A recording is not kept: its blob URL belongs to the one
// player that asked, which revokes it when it goes.
import { getClient } from '@frontierjs/sierra/resource'

const api = () => {
  const client = getClient()
  if (!client) throw new Error('This build names no API.')
  return client
}

const pathOf = (name) => `/capture-file/${encodeURIComponent(name)}`

/** The file's bytes as a Blob. Throws the server's message. */
export async function captureBlob(name) {
  return (await api().fetch(pathOf(name))).blob()
}

const images = new Map()

/** A blob URL for an <img>; the same promise for the same file. */
export function captureImageUrl(file) {
  const key = `${file.name}:${file.size}:${file.modifiedAt}`
  if (images.has(key)) return images.get(key)
  const p = captureBlob(file.name).then((b) => URL.createObjectURL(b))
  images.set(key, p)
  p.catch(() => images.delete(key))
  return p
}

/** A blob URL the caller owns and revokes (`URL.revokeObjectURL`): a recording or a call. */
export async function captureMediaUrl(file) {
  return URL.createObjectURL(await captureBlob(file.name))
}

const toPng = async (blob) => {
  if (blob.type === 'image/png') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close?.()
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('the browser would not encode the image'))), 'image/png'))
}

/** Put the image on the clipboard as a PNG, the one type every clipboard takes. A GIF is copied as its first frame. */
export async function copyImage(file) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('This window cannot write an image to the clipboard.')
  const png = await toPng(await captureBlob(file.name))
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

export const fileSize = (n) => n == null ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : n < 1_073_741_824 ? `${(n / 1_048_576).toFixed(1)} MB` : `${(n / 1_073_741_824).toFixed(1)} GB`
