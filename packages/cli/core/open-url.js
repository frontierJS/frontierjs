// ─── open-url.js — a URL in the person's browser ─────────────────────────────
// Detached and argv-only: a URL is never pasted into a shell string, and a
// browser that is still open when fli exits is not fli's child to wait on.

import { spawn } from 'child_process'

const OPENERS = {
  darwin: url => ['open', [url]],
  win32:  url => ['cmd', ['/c', 'start', '', url]],
}

/** Open `url`; a machine with no opener says nothing, as a click on nothing would. */
export function openUrl(url) {
  const [cmd, args] = (OPENERS[process.platform] ?? (u => ['xdg-open', [u]]))(url)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch { /* no opener on this machine */ }
}
