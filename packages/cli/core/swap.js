// ─── swap.js — Outpost's container swap, driven over a machine ───────────────
// The swap sequence and the `docker run` flags both deploy paths give a
// release are Outpost's (`@frontierjs/outpost/swap`, `FJS-D1866`); `fli deploy`
// drives the same sequence over ssh, so a put-back cannot drift between them.
// This is the runner that hands Outpost's argv to a machine from
// `core/machine.js`.

import { shQuote } from './machine.js'

export { createSwap, runFlags, DEFAULT_STOP_GRACE_S } from '@frontierjs/outpost/swap'

// A word with nothing the target's shell reads passes bare, so `--dry` and a
// failure's message show the `docker run` line as an operator would type it.
export const shWord = (word) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(word)) ? String(word) : shQuote(word)

/**
 * `run(argv)` for `createSwap`, over a machine: each argument quoted for the
 * target's shell, the script sent on stdin as every machine script is. Answers
 * the exit code rather than throwing, as Outpost's runner does, because the
 * swap reads a refused `docker rm -f` of a name that is not there as nothing.
 */
export const sshRunner = (machine) => async (argv) => {
  try {
    return { exitCode: 0, stdout: machine.capture(argv.map(shWord).join(' ')), stderr: '' }
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr || err.message || '') }
  }
}
