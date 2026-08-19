// ─── stack.js — a frame in a command names the .md it was written in ─────────
//
// A command is markdown. It is compiled to an ESM module, written to a temp
// shim and imported, so every frame from a command body names a file the author
// never wrote and which is deleted when the process exits.
//
// The `//# sourceURL` pragma that used to paper over this made it worse rather
// than better: it relabels the PATH in a frame and leaves the LINE alone, so
// Node reported `boom.md:15` for a throw on line 9 of an 11-line file — a
// location that reads as authoritative and does not exist. Bun ignored the
// pragma entirely, and ignores an inline source map and a linked `.map` too, so
// neither runtime was ever going to answer this on its own. All measured.
//
// So fli answers it. It wrote the shim, so it holds both halves of the mapping,
// and `compileCliWithMap` hands back the one integer that relates them —
// `transformMarkdown` turns prose into comments rather than dropping it and
// `stripScriptBlocks` leaves the block's height behind, so the whole map is
// `genLine - offset` wherever in the file the frame is (`FJS-066`).
//
// The rewrite is a STRING pass over `err.stack` rather than an
// `Error.prepareStackTrace` hook. The hook is global and V8-shaped: taking it
// means re-implementing the default formatting for every frame that is not
// ours, on two runtimes that format differently, to fix the handful that are.

/** shim path → the `.md` it came from, and `genLine - mdLine`. */
const shims = new Map()

/**
 * Remember a shim while it exists. Called where the shim is written, which is
 * the only place holding both paths at once.
 */
export function registerShim(shimPath, sourcePath, sourceLineOffset) {
  if (!shimPath || !sourcePath) return
  shims.set(shimPath, { sourcePath, sourceLineOffset })
}

/** Test seam. */
export function _clearShims() { shims.clear() }

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrite every frame naming a known shim to name its `.md` instead, at the
 * line the author wrote.
 *
 * Returns the rewritten string and does NOT mutate — a caller printing the
 * error object assigns it back, and a caller that only wants to read one does
 * not have to change the error it was handed.
 */
export function rewriteStackString(stack) {
  if (typeof stack !== 'string' || !shims.size) return stack

  let out = stack
  for (const [shimPath, { sourcePath, sourceLineOffset }] of shims) {
    // Both spellings: Node prints a file:// URL for an ESM frame, Bun a path.
    for (const form of [shimPath, pathAsUrl(shimPath)]) {
      if (!form || !out.includes(form)) continue
      out = out.replace(
        new RegExp(escape(form) + ':(\\d+)', 'g'),
        (_m, line) => `${sourcePath}:${Math.max(1, Number(line) - sourceLineOffset)}`,
      )
    }
  }
  return out
}

// Built by hand rather than with pathToFileURL: this module is imported on the
// error path and the two spellings are the only thing needed from it.
const pathAsUrl = (p) => (p.startsWith('/') ? `file://${p}` : null)

/**
 * Rewrite an error's stack in place, and its `cause` chain with it — the
 * command loader wraps a failure with the command's path and `cause`, and
 * printing an error prints the chain.
 */
export function rewriteStack(err, seen = new Set()) {
  if (!err || typeof err !== 'object' || seen.has(err)) return err
  seen.add(err)

  const stack = err.stack
  if (typeof stack === 'string') {
    const next = rewriteStackString(stack)
    // Only assign when it changed: `stack` is a getter on some hosts and
    // writing it unconditionally would materialise one for nothing.
    if (next !== stack) { try { err.stack = next } catch { /* frozen */ } }
  }

  if (err.cause) rewriteStack(err.cause, seen)
  return err
}
