/**
 * served-path.js — what file does this URL name, and is it inside the root?
 *
 * One question, two servers — the same reason `hashed-asset.js` is here.
 * `site/serve.js` and `widget/serve.js` publish different things to different
 * audiences and give different cache answers, but *what may this request
 * reach* is one question in both, and it was written twice with a hole in each
 * copy:
 *
 *   • **A URL that is not a URL.** `decodeURIComponent('/%')` throws `URIError`.
 *     Both servers decoded outside any `try`, inside an `async` handler, so one
 *     unauthenticated request killed the process under node and hung the socket
 *     forever under bun (`FJS-784`). A malformed escape is a 400 — it is a
 *     request nobody can honour, not a file nobody has.
 *
 *   • **A path that stays inside the root is not the same as a FILE that does.**
 *     Refusing what a URL can SAY (`..`, a NUL byte) is the whole of what
 *     `normalize` answers; a symlink INSIDE the root pointing out of it says the
 *     rest. Junction settled this for its own static server as `FJS-746` —
 *     realpath compared against the realpath of the root, 404 rather than 403,
 *     `allowOutside` as the declared escape — and neither Sierra origin was
 *     brought along (`FJS-783`). The rule is lifted here rather than copied
 *     into each, so the next server gets it by calling this.
 */

import { realpath } from 'node:fs/promises'
import { normalize, resolve, sep } from 'node:path'

/**
 * The root-relative path a URL names, or `null` when the URL is not a URL.
 *
 * `null` is a 400 and never a 404: a caller who sent `%zz` has not asked for a
 * file that is missing, they have sent something that cannot be decoded, and
 * answering 404 tells them the origin looked.
 *
 * @param {string} urlPath  the path portion, query and fragment already cut
 * @returns {string|null}
 */
export function relativePathFor(urlPath) {
  let decoded
  try { decoded = decodeURIComponent(urlPath) }
  catch { return null }

  // A NUL truncates the path at the syscall, so `/a.txt\0.png` reaches a.txt
  // through an extension check that read `.png`.
  if (decoded.includes('\0')) return null

  return normalize(decoded)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '')
}

// The realpath of each declared root. A root is a configured constant and
// resolving it is a syscall, so it is resolved once; the FILE is resolved on
// every request, because a symlink can be repointed under a running server and
// a cached answer would go on serving what it used to be.
const _realRoots = new Map()

async function realRoot(root) {
  if (_realRoots.has(root)) return _realRoots.get(root)
  let real
  try   { real = await realpath(resolve(root)) }
  catch { real = null }   // the root itself is gone — nothing can be inside it
  _realRoots.set(root, real)
  return real
}

function contains(dir, path) {
  return path === dir || path.startsWith(dir + sep)
}

const _warned = new Set()

function warnEscape(filePath, real, base) {
  if (_warned.has(filePath)) return
  _warned.add(filePath)
  console.warn(
    `[Sierra] '${filePath}' resolves to '${real}', which is outside the published root ` +
    `'${base}' — refused, and answered as not found. A symlink out of the root is served to ` +
    `anyone who can guess the URL, so it is refused rather than followed. Name the directory ` +
    `in 'allowOutside' if it is meant to be published.`
  )
}

/**
 * Is the file this request resolved to really inside the published root?
 *
 * An escape answers the same 404 a missing file does, deliberately — a 403
 * would confirm to the caller that they found a way out. The OPERATOR is told
 * instead, once per path, because a symlinked asset directory is a real
 * deployment shape and silently serving nothing would be a day lost.
 *
 * @param {string}   root          the published directory
 * @param {string}   filePath      the path this request resolved to
 * @param {string[]} [allowOutside] directories a link inside the root may
 *                                  legitimately resolve into. `dist/assets →
 *                                  /srv/shared/assets` is a real deployment,
 *                                  and refusing it with no way to say otherwise
 *                                  is how a check like this gets turned off
 *                                  wholesale. Anything not named is refused.
 * @returns {Promise<boolean>}
 */
export async function withinRoot(root, filePath, allowOutside = []) {
  if (!root) return true

  const base = await realRoot(root)
  if (!base) return false

  let real
  try   { real = await realpath(filePath) }
  catch { return false }   // vanished between the stat and here

  if (contains(base, real)) return true

  // Compared as REALPATHS, or a declared directory that is itself a link never
  // matches the resolved file underneath it — which reads as the allowance
  // being ignored.
  for (const allowed of allowOutside) {
    const dir = await realRoot(allowed)
    if (dir && contains(dir, real)) return true
  }

  warnEscape(filePath, real, base)
  return false
}
