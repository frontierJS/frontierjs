// src/core/site-photo.ts — an owner's uploaded photo, as the bytes a draft
// commits (`FJS-D1408`).
//
// Whatever the page sent is decoded and encoded again here: a file that is not
// an image is refused rather than served from the site's own origin under a
// photo's name, and a phone photo's EXIF, which often holds where it was taken,
// does not survive into a public site.

/** The longest side a committed photo has — the editor's `LONGEST` too. */
export const LONGEST = 2560

const QUALITY = 85

/** The formats kept as they came; anything else Bun.Image reads (HEIC, GIF, TIFF…) becomes a JPEG. */
const KEPT: Record<string, 'jpg' | 'png' | 'webp'> = { jpeg: 'jpg', png: 'png', webp: 'webp' }

export class PhotoRefused extends Error {}

/** `bytes` decoded, held to `LONGEST`, and encoded again with no metadata: the bytes and their extension. */
export async function reencodePhoto(bytes: Uint8Array): Promise<{ bytes: Uint8Array, ext: 'jpg' | 'png' | 'webp', width: number, height: number }> {
  const Image = (globalThis as { Bun?: { Image?: any } }).Bun?.Image
  if (!Image) throw new PhotoRefused('this server has no image decoder, so it cannot take a photo')
  let meta: { width: number, height: number, format: string }
  try {
    meta = await new Image(bytes).metadata()
  } catch {
    throw new PhotoRefused('that file is not a photo this site can show — send a JPEG, PNG or WebP')
  }
  const scale = Math.min(1, LONGEST / Math.max(meta.width, meta.height))
  const width = Math.max(1, Math.round(meta.width * scale))
  const height = Math.max(1, Math.round(meta.height * scale))
  const ext = KEPT[meta.format] ?? 'jpg'
  let image = new Image(bytes)
  if (scale < 1) image = image.resize(width, height)
  const out = ext === 'png' ? image.png() : ext === 'webp' ? image.webp({ quality: QUALITY }) : image.jpeg({ quality: QUALITY })
  return { bytes: await out.bytes(), ext, width, height }
}
