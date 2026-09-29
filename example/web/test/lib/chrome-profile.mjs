// web/test/lib/chrome-profile.mjs — the Chrome profile a drive runs in, and
// the only thing that removes it.
//
// A drive's profile runs to ~500MB, and removing it in the drive does not work:
//
//   · removing it straight after chrome.kill() SUCCEEDS, and Chrome's children,
//     still winding down, write it back — so a green run leaks it too.
//   · a throw, a Ctrl-C or a SIGKILL never reaches the removal at all.
//
// So at exit every process holding the profile is killed — children included,
// matched by the profile path on their command line — then the thread waits,
// then the directory goes. And tempDir() reaps the PREVIOUS runs' profiles on
// the way in, the only thing that covers a SIGKILL no handler sees.
//
// mesa's drive owns the same lifecycle (FJS-361) and cannot share this: mesa is
// the leaf and imports no framework package. Change one, ask whether the other
// needs it.

import { spawnSync } from 'node:child_process'
import { rmSync }    from 'node:fs'
import { tempDir }   from '../../../../packages/litestone/src/tmp-dirs.js'

const profiles = new Set()
let installed  = false

/** Block the thread. An exit handler cannot await. */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function sweep() {
  if (!profiles.size) return
  // The pattern starts past the dashes, or pkill reads it as an option.
  for (const p of profiles) spawnSync('pkill', ['-KILL', '-f', `user-data-dir=${p}`])
  // Every browser dies BEFORE any profile is removed: 200ms was measured as
  // enough for a removed profile to stay gone.
  sleepSync(300)
  for (const p of profiles) {
    try { rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch { /* the next run's reap gets it */ }
  }
  profiles.clear()
}

function install() {
  if (installed) return
  installed = true
  process.on('exit', sweep)
  // A signal's default action ends the process without 'exit'. An uncaught
  // throw does not need this: node and bun both still fire 'exit' for it.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143))
  }
}

/** A fresh profile directory for `--user-data-dir`, removed with every Chrome
 *  that holds it when the process exits, however it exits. `prefix` must name
 *  one drive: the reap matches on it. */
export function chromeProfile(prefix) {
  install()
  const profile = tempDir(prefix)
  profiles.add(profile)
  return profile
}
