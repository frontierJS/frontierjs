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
    ? 'wl-paste --no-newline 2>/dev/null || xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null'
    : 'xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null',
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

/** The clipboard's text, or null when no tool could read it. */
export function readClipboard() {
  const cmd = PASTERS[process.platform]?.()
  if (!cmd) return null
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 })
  } catch {
    return null
  }
}
