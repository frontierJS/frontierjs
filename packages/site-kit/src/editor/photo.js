// src/editor/photo.js — a photo made small in the page before it is sent
// (FJS-D1408). A phone photo is several megabytes, more than basecamp takes in
// one call; basecamp decodes and re-encodes whatever arrives anyway, so this
// is for the size of the upload and never the promise about what reaches git.

/** The longest side a photo is sent at, which basecamp also holds it to. */
export const LONGEST = 2560

const KEPT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/**
 * `file` at most `longest` pixels on its longest side, in its own format when
 * that is JPEG, PNG or WebP and as JPEG otherwise. A file this browser cannot
 * decode (HEIC outside Safari) goes as it is, and basecamp answers for it.
 * @param {File} file
 */
export async function shrink(file, longest = LONGEST) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height))
  const type = KEPT[file.type] ? file.type : 'image/jpeg'
  if (scale === 1 && type === file.type) { bitmap.close(); return file }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.85))
  if (!blob) return file
  return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.' + KEPT[type], { type })
}
