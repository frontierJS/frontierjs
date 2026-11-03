// ─── clipboard.js — text onto and off the person's clipboard ─────────────────
// The text goes on stdin, never into a shell string: it is a key or a link with
// a decryption key in its fragment, and a shell string puts it in `ps`.

import { execSync } from 'child_process'

// Wayland first where a session has one: xclip there writes to XWayland's
// selection, which a native app does not read.
const COPIERS = {
  darwin: () => 'pbcopy',
  win32:  () => 'clip',
  linux:  () => process.env.WAYLAND_DISPLAY
    ? 'wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null'
    : 'xclip -selection clipboard 2>/dev/null || xsel --clipboard --input 2>/dev/null',
}

const PASTERS = {
  darwin: () => 'pbpaste',
  win32:  () => 'powershell -NoProfile -Command Get-Clipboard',
  linux:  () => process.env.WAYLAND_DISPLAY
    ? 'wl-paste --no-newline --type text 2>/dev/null || xclip -selection clipboard -o -t UTF8_STRING 2>/dev/null'
    : 'xclip -selection clipboard -o -t UTF8_STRING 2>/dev/null || xsel --clipboard --output 2>/dev/null',
}

// A clipboard holding only an image answers a text read with the PNG's bytes
// on X (the owner picks what to serve), so the offered types are asked first.
const LISTERS = {
  linux: () => process.env.WAYLAND_DISPLAY
    ? 'wl-paste --list-types 2>/dev/null || xclip -selection clipboard -o -t TARGETS 2>/dev/null'
    : 'xclip -selection clipboard -o -t TARGETS 2>/dev/null',
}
const TEXT_TYPE = /^(text\/plain|UTF8_STRING|STRING|TEXT)\b/
// The type goes into a shell string, and the clipboard's owner names it.
const IMAGE_TYPE = /^image\/[\w.+-]+$/
const IMAGE_PASTERS = {
  linux: (type) => process.env.WAYLAND_DISPLAY
    ? `wl-paste --type ${type} 2>/dev/null || xclip -selection clipboard -o -t ${type} 2>/dev/null`
    : `xclip -selection clipboard -o -t ${type} 2>/dev/null`,
}

/** The tools a failed copy or paste should name, for this platform. */
export const clipboardTools = () =>
  process.platform === 'linux' ? 'wl-clipboard, xclip or xsel' : COPIERS[process.platform]?.() ?? null

/** Copy `text`; answers whether it landed. */
export function copyToClipboard(text) {
  const cmd = COPIERS[process.platform]?.()
  if (!cmd) return false
  try {
    execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * `{ text }`, or `{ image, type }` — the bytes and their MIME type — for a
 * clipboard offering no text and an image (Linux only); null when it holds
 * neither or no tool could read it. Text wins where both are offered, as a
 * spreadsheet's copied cells are. `max` caps an image's bytes.
 */
export function readClipboard({ max = 1 << 20 } = {}) {
  const cmd = PASTERS[process.platform]?.()
  if (!cmd) return null
  try {
    const list = LISTERS[process.platform]?.()
    const types = list ? execSync(list, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map(t => t.trim()) : null
    if (types && !types.some(t => TEXT_TYPE.test(t))) {
      const type = types.includes('image/png') ? 'image/png' : types.find(t => IMAGE_TYPE.test(t))
      if (!type) return null
      const image = execSync(IMAGE_PASTERS[process.platform](type), { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: max })
      return image.length ? { image: new Uint8Array(image), type } : null
    }
    return { text: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 }) }
  } catch {
    return null
  }
}
