// ─── open-url.js — a URL in the person's browser ─────────────────────────────
// Detached and argv-only: a URL is never pasted into a shell string, and a
// browser that is still open when fli exits is not fli's child to wait on.

import { spawn } from 'child_process'

const OPENERS = {
  darwin: url => ['open', [url]],
  win32:  url => ['cmd', ['/c', 'start', '', url]],
}

/**
 * Open `url`, which may be a file path. Resolves false when this machine has no
 * opener: a missing `xdg-open` is an async `'error'` event, not a throw, so a
 * try/catch alone reports success and then dies on the unhandled event.
 *
 * @returns {Promise<boolean>} never rejects
 */
export function openUrl(url) {
  const [cmd, args] = (OPENERS[process.platform] ?? (u => ['xdg-open', [u]]))(url)
  return new Promise(done => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.on('error', () => done(false))
      child.on('spawn', () => done(true))
      child.unref()
    } catch { done(false) }
  })
}
