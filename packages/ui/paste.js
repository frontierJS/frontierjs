/*
 * paste.js — the files a paste or a drop carries, and a picture fitted to a size
 * (FJS-D2364).
 *
 *   filesOf(transfer)                 the File[] on a DataTransfer — `files`, else
 *                                     the `items` whose kind is 'file'; sync
 *   pastedFiles(event, { read })      Promise<File[]> for a paste event
 *   fitImage(file, { edge, maxBytes}) Promise<Blob> — PNG at `edge` on the long
 *                                     side, a JPEG on white when the PNG is over
 *                                     `maxBytes`
 *
 * Why `pastedFiles` is more than `filesOf(event.clipboardData)`: WebKitGTK (the
 * Tauri shell on Linux) fires a paste of a screenshot with `files`, `items` and
 * `types` all empty. The image is reachable only through the async clipboard,
 * read while the paste is the person's gesture. The rules, in order:
 *
 *   - files on the event are returned, whatever else rides along;
 *   - an event with no files and no text/plain is the WebKitGTK case: `read()`
 *     is called if the host gave one (a desktop shell's own reader, such as
 *     Lathe's `invoke('clipboard_image')` — ui knows nothing of Tauri),
 *     else the image items of `navigator.clipboard.read()` are returned;
 *   - a paste with text never reads the clipboard, which keeps Chrome's
 *     permission prompt away from every ordinary paste;
 *   - `preventDefault()` is called before any await, and only when the paste
 *     has no text/plain, so text always pastes and the files ride along;
 *   - a refused clipboard read THROWS. A caller that swallows it shows nothing.
 *
 * `fitImage` has no default numbers: 1568px and 5MB are Claude's and belong to
 * its callers.
 *
 * packages/cli/core/vite-ask-client.js stays a plain-DOM copy of this on
 * purpose. It is a virtual module served into whatever app runs the dev
 * server, so whether `@frontierjs/ui` resolves from there is unproven
 * (FJS-D2364).
 */

/** @param {DataTransfer | null | undefined} transfer */
export function filesOf(transfer) {
  if (!transfer) return []
  const out = [...(transfer.files ?? [])]
  if (out.length) return out
  for (const item of transfer.items ?? []) {
    if (item.kind === 'file') { const f = item.getAsFile(); if (f) out.push(f) }
  }
  return out
}

const asFile = (blob) => blob instanceof File ? blob : new File([blob], 'image.png', { type: blob.type })

async function clipboardImages() {
  const out = []
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) out.push(new File([await item.getType(type)], 'image.png', { type }))
  }
  return out
}

/**
 * @param {ClipboardEvent} event
 * @param {{ read?: () => Promise<Array<File | Blob>> | Array<File | Blob> }} [opts]
 * @returns {Promise<File[]>}
 */
export async function pastedFiles(event, { read } = {}) {
  const data  = event.clipboardData
  const files = filesOf(data)
  const text  = !!data && ([...(data.types ?? [])].includes('text/plain') || !!data.getData?.('text/plain'))
  if (!text) event.preventDefault()
  if (files.length || text) return files
  const got = read ? await read() : await clipboardImages()
  return [...(got ?? [])].map(asFile)
}

const canvasOf = (bitmap, edge) => {
  const k = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width  = Math.max(1, Math.round(bitmap.width * k))
  c.height = Math.max(1, Math.round(bitmap.height * k))
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height)
  return c
}
const blobOf = (c, type, q) => new Promise((ok, no) =>
  c.toBlob(b => b ? ok(b) : no(new Error('the browser would not encode it')), type, q))

/**
 * A JPEG has no alpha, so a transparent PNG flattened onto one goes black where
 * it was clear; white goes under it first.
 * @param {Blob} file
 * @param {{ edge: number, maxBytes: number }} opts
 * @returns {Promise<Blob>}
 */
export async function fitImage(file, { edge, maxBytes }) {
  const bitmap = await createImageBitmap(file)
  try {
    const c = canvasOf(bitmap, edge)
    const png = await blobOf(c, 'image/png')
    if (png.size <= maxBytes) return png
    const flat = document.createElement('canvas')
    flat.width = c.width; flat.height = c.height
    const g = flat.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, flat.width, flat.height); g.drawImage(c, 0, 0)
    return await blobOf(flat, 'image/jpeg', 0.85)
  } finally { bitmap.close?.() }
}
