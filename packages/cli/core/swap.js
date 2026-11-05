// ─── swap.js — Outpost's container swap, driven over a machine ───────────────
// The swap sequence and the `docker run` flags both deploy paths give a
// release are Outpost's (`@frontierjs/outpost/swap`, `FJS-D1866`); `fli deploy`
// drives the same sequence over ssh, so a put-back cannot drift between them.
// This is the runner that hands Outpost's argv to a machine from
// `core/machine.js`.

import { shQuote } from './machine.js'

export { createSwap, runFlags, portOf, livePivot, swapFor, healthBudgetS, checkHealthTimeout, DEFAULT_STOP_GRACE_S, DEFAULT_HEALTH_TIMEOUT_S, STREAM_CLOSE_DELAY, HEALTHY_STATUS, HEALTH_INTERVAL_S, HEALTH_CHECK_TIMEOUT_S } from '@frontierjs/outpost/swap'

// The swaps `deploy.swap` may ask for, spelled as Basecamp's `App.swap` is
// (`FJS-D1882`). A misspelling refused rather than read as stop-first, or an
// owner who asked for the overlap never gets it and nothing says so.
export const SWAP_SETTINGS = ['stopFirst', 'startFirst']

export function swapSetting(deployConf = {}) {
  const asked = deployConf.swap ?? 'stopFirst'
  if (!SWAP_SETTINGS.includes(asked))
    throw new Error(`deploy.swap is ${SWAP_SETTINGS.map(s => `'${s}'`).join(' or ')} — got '${asked}'`)
  return asked
}

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
