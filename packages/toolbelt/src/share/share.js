/*
 * share.js — page state carried in a URL's fragment.
 *
 * A page that keeps its state in `#s=…` answers three questions, and three
 * apps answered them alone (`FJS-3771`): how long a link can be before a
 * browser will not open it, how far a link may inflate, and what to do with a
 * state that arrived from someone else.
 *
 * The state is JSON, deflated, base64url — the one codec, so a link made by one
 * page reads in another. `encodeShare` refuses a link past `SHARE_MAX` with a
 * sentence, since a broken link copied to a clipboard fails far from the
 * person who copied it. `decodeShare` stops inflating at `SHARE_INFLATED_MAX`,
 * because a 108 KB link can inflate to 80 MB and nothing upstream sees inside
 * it, and answers null for anything that is not one.
 *
 * What comes back is DATA. A state that arrived in a link is foreign: read it
 * with `readFields`, field by field with a malformed field dropped, and never
 * run code it carries until the viewer asks. SRC compiled a link's transform
 * on open, in the page's origin.
 */

/** Chrome's URL limit. The most encoded text `encodeShare` will answer. */
export const SHARE_MAX = 2_000_000

/** The most a link may inflate to; `toolbelt/frontier` caps a file at 24 MiB, a state is text and gets more. */
export const SHARE_INFLATED_MAX = 64 * 1024 * 1024

const CHUNK = 0x8000

/**
 * `value` as link text. Throws a sentence when the text passes `max`, the
 * caller saying what was being shared.
 */
export async function encodeShare(value, { max = SHARE_MAX } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(value))
  const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
  let bin = ''
  for (let at = 0; at < deflated.length; at += CHUNK) bin += String.fromCharCode(...deflated.subarray(at, at + CHUNK))
  const text = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  if (text.length > max) throw new Error(`This is ${text.length} characters as a link and a browser opens at most ${max}. Share less of it.`)
  return text
}

/** The value link text holds, or null for anything that is not a link's text or inflates past `inflatedMax`. */
export async function decodeShare(text, { inflatedMax = SHARE_INFLATED_MAX } = {}) {
  try {
    const bytes = Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
    const parts = []
    let total = 0
    for (let read; !(read = await reader.read()).done;) {
      total += read.value.length
      if (total > inflatedMax) { await reader.cancel(); return null }
      parts.push(read.value)
    }
    return JSON.parse(await new Blob(parts).text())
  } catch {
    return null
  }
}

/** The text of `name=` in a location hash, or null. */
export function shareParam(hash, name = 's') {
  const found = String(hash).match(new RegExp(`[#&]${name.replace(/[^\w-]/g, '')}=([^&]+)`))
  return found ? found[1] : null
}

/**
 * The fields of a foreign object that its readers accept. Each reader takes
 * the field's value and answers what to keep, or `undefined` to drop it; one
 * that throws drops it too. A field with no reader is dropped, and the answer
 * is a new object built by own-key definition, so a `__proto__` member is a
 * field like any other and not a prototype. Null when `value` is not an object.
 */
export function readFields(value, readers) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  for (const [key, read] of Object.entries(readers)) {
    if (!Object.hasOwn(value, key)) continue
    let kept
    try { kept = read(value[key]) } catch { continue }
    if (kept !== undefined) Object.defineProperty(out, key, { value: kept, enumerable: true, writable: true, configurable: true })
  }
  return out
}
