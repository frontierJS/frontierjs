// ─── paths.js — where fli keeps a person's files ─────────────────────────────
//
// The only place a per-user fli root is computed (`FJS-D1990`). Four roots, one
// per class of file, so a backup tool, `rm -rf` of a cache and `ls` of the run
// state each reach what they mean:
//
//   configDir()  $XDG_CONFIG_HOME/fli   .env, commands/, basecamps.json, config.json, autopilot.json
//   dataDir()    $XDG_DATA_HOME/fli     backups
//   cacheDir()   $XDG_CACHE_HOME/fli    the registry cache; safe to delete
//   stateDir()   ~/.fli                 holds, lanes, registers, loop logs, sessions.lock, frontier/, haven/
//
// Each reads its variable per call, not at import: a test points it at a temp
// dir, or the developer's own files leak into the suite and the suite's into
// theirs. `home` pins a root under that directory and ignores the XDG variable,
// for a caller that was handed a home (`globalEnvPath(home)`).

import { homedir } from 'node:os'
import { join } from 'node:path'

export function configDir({ home } = {}) {
  if (home) return join(home, '.config', 'fli')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fli')
}

export function dataDir({ home } = {}) {
  if (home) return join(home, '.local', 'share', 'fli')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'fli')
}

export function cacheDir({ home } = {}) {
  if (home) return join(home, '.cache', 'fli')
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'fli')
}

/** Run state: not config, not data, not a cache. Stays one dot-directory a person can `ls` and `fli top` reads. */
export function stateDir({ home } = {}) {
  return join(home ?? homedir(), '.fli')
}

/** The four roots by class, for `fli doctor` and a test. */
export const roots = () => ({ config: configDir(), data: dataDir(), cache: cacheDir(), state: stateDir() })
