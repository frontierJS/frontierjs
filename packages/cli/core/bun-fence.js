// bun-fence.js — keeping a run's `bun link` out of the machine's global dir.
//
// `fli new --source local` runs `bun link` in every package it needs, and
// bun keeps ONE global link per name: the last tree to link wins. A CI run in
// a temp clone therefore re-pointed `~/.bun/bin/fli` and every
// `@frontierjs/*` link on the machine into that clone, and the next session
// read its answers off the wrong fli (FJS-1364).
//
// The fence is `BUN_INSTALL`, where bun keeps the global dir. Link and
// consume both happen inside one `fli new` child, so an app still resolves
// its `link:` specs, and the link bun writes into the app points at the
// source tree rather than through the fence, which is why the fence can go
// the moment the run ends. The package cache is left where it was, or every
// install inside the fence starts cold and needs the network.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir }     from 'node:os'
import { join }                from 'node:path'

export function fenceBunGlobal(env = process.env, dir = mkdtempSync(join(tmpdir(), 'fjs-bun-global-'))) {
  const home = env.BUN_INSTALL || join(env.HOME || homedir(), '.bun')
  return {
    dir,
    env: {
      ...env,
      BUN_INSTALL:           dir,
      BUN_INSTALL_CACHE_DIR: env.BUN_INSTALL_CACHE_DIR || join(home, 'install', 'cache'),
    },
  }
}

// Fences this process and every child it spawns, and removes the fence on exit.
export function fenceThisProcess() {
  const { dir, env } = fenceBunGlobal()
  process.env.BUN_INSTALL           = env.BUN_INSTALL
  process.env.BUN_INSTALL_CACHE_DIR = env.BUN_INSTALL_CACHE_DIR
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}
