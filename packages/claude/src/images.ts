// src/images.ts — a pasted image, checked, and the stdin that carries it.
//
// A pasted image cannot ride a text prompt, so an ask carrying one goes in as
// one stream-json user message instead — the prompt as its text block, each
// image a base64 block after it. Measured on 2.1.296, a resume included.

import { IMAGE_TYPES, MAX_IMAGE, MAX_IMAGES } from './limits.ts'

/** A pasted image as the API takes it: a media type and base64 with no `data:` prefix. */
export type Image = { type: string, data: string }

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** `[{ type, data }]`, data base64 with no `data:` prefix, or `{ error }`. */
export function readImages(list: unknown): Image[] | { error: string } {
  if (list == null) return []
  if (!Array.isArray(list)) return { error: 'images is a list' }
  if (list.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images in one message` }
  const out: Image[] = []
  for (const [i, img] of list.entries()) {
    const type = String(img?.type ?? ''), data = img?.data
    if (!(IMAGE_TYPES as readonly string[]).includes(type)) return { error: `image ${i + 1} is ${type.slice(0, 40) || 'of no type'} — paste a PNG, JPEG, GIF or WebP` }
    if (typeof data !== 'string' || !BASE64.test(data)) return { error: `image ${i + 1} is not base64` }
    if (data.length > MAX_IMAGE) return { error: `image ${i + 1} is over ${MAX_IMAGE >> 20}MB` }
    out.push({ type, data })
  }
  return out
}

/** What goes on stdin: the prompt as is, or with images one stream-json message. */
export function askInput(prompt: string, images: readonly Image[] = []): string {
  if (!images.length) return prompt
  const content = [
    { type: 'text', text: prompt },
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } })),
  ]
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}
