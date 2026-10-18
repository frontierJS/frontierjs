// src/lib/study/images.js — an image in a study line (`IDEAS/study.md` 2.4),
// as the blocks a stream-json user line carries. A terminal pastes text and
// never a picture, so a dragged file arrives as its path and a copied picture
// is read off the clipboard by the desktop's own tool.
//
// A path stays in the line as typed, so a line about `a.png` still names it;
// a pasted picture has no text, so it is `[Image #n]` in the line, Claude
// Code's own spelling, and deleting that drops it.
//
// Terminal only, like `session.js`.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The longest an image's base64 may be: the API refuses a larger one, and the turn with it. */
export const MOST_BYTES = 5 * 1024 * 1024

const EXT = /\.(png|jpe?g|gif|webp)$/i

/** The media type `buf`'s first bytes name, or null. An extension can lie, and a mislabeled image fails the turn. */
export function mediaOf(buf) {
  const at = (from, to) => buf.toString('latin1', from, to)
  if (buf[0] === 0x89 && at(1, 4) === 'PNG') return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (at(0, 4) === 'GIF8') return 'image/gif'
  if (at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** `buf` as an image block. Throws naming `name` for what cannot be sent. */
export function blockOf(buf, name) {
  const media_type = mediaOf(buf)
  if (!media_type) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP`)
  const data = buf.toString('base64')
  if (data.length > MOST_BYTES) throw new Error(`${name} is ${(data.length / 2 ** 20).toFixed(1)} MB encoded, over the 5 MB an image may be`)
  return { type: 'image', source: { type: 'base64', media_type, data } }
}

/** The tag a pasted picture stands as in the line. */
export const pastedTag = (n) => `[Image #${n}]`
const TAG = /\[Image #(\d+)\]/g

// A dragged file as terminals paste it: bare, quoted, its spaces escaped, or a file:// URL.
const TOKEN = /'[^']+'|"[^"]+"|(?:\\.|\S)+/g

/** The file `token` names when it names an image by its extension, else null. */
export function pathOf(token, cwd) {
  let p = /^(['"]).+\1$/.test(token) ? token.slice(1, -1) : token.replace(/[.,;:!?)]+$/, '').replace(/\\(.)/g, '$1')
  if (p.startsWith('file://')) { try { p = fileURLToPath(p) } catch { return null } }
  if (!EXT.test(p)) return null
  if (p.startsWith('~/')) p = homedir() + p.slice(1)
  return isAbsolute(p) ? p : resolve(cwd, p)
}

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }

/** Each existing image file `text` names, in order, once. */
export function imagePaths(text, cwd) {
  const out = []
  for (const [t] of String(text).matchAll(TOKEN)) {
    const p = pathOf(t, cwd)
    if (p && !out.includes(p) && isFile(p)) out.push(p)
  }
  return out
}

/**
 * The image blocks line `text` carries: each pasted picture whose tag is
 * still in it (`pasted[n - 1]` for `[Image #n]`), then each image file it
 * names. Throws naming the file that cannot be sent, so the line is kept
 * rather than sent without it.
 */
export function imagesOf(text, { cwd, pasted = [] }) {
  const blocks = []
  const seen = new Set()
  for (const [, n] of String(text).matchAll(TAG)) {
    if (seen.has(n) || !pasted[n - 1]) continue
    seen.add(n)
    blocks.push(pasted[n - 1])
  }
  for (const p of imagePaths(text, cwd)) blocks.push(blockOf(readFileSync(p), p))
  return blocks
}

// Each desktop's reader, the first whose session is running tried alone.
const READERS = [
  { on: (env) => !!env.WAYLAND_DISPLAY, argv: ['wl-paste', '--no-newline', '--type', 'image/png'] },
  { on: (env) => !!env.DISPLAY, argv: ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'] },
  { on: () => process.platform === 'darwin', argv: ['pngpaste', '-'] },
]

/** The clipboard's picture as an image block. Throws saying why there is none. */
export function clipboardImage({ env = process.env } = {}) {
  const reader = READERS.find((r) => r.on(env))
  if (!reader) throw new Error('no clipboard here: no Wayland or X display, and not macOS')
  const [bin] = reader.argv
  let out
  try {
    // A clipboard owner that never answers would hang the pane, so it is given two seconds.
    out = Bun.spawnSync(reader.argv, { stdout: 'pipe', stderr: 'pipe', timeout: 2000, env })
  } catch {
    throw new Error(`${bin} is not installed, and it reads the clipboard here`)
  }
  if (!out.success || !out.stdout?.length) throw new Error('the clipboard holds no image')
  return blockOf(Buffer.from(out.stdout), 'the clipboard')
}
