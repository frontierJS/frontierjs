/**
 * build/fs-allow-plugin.js — let the dev server serve sierra's own files from
 * a linked checkout (FJS-1601).
 *
 * An app made with `fli new --source local` reaches `@frontierjs/*` through
 * symlinks into the framework tree, and Vite resolves a symlink to its real
 * path, which is outside the app's workspace root. Most of sierra never notices
 * this, because it arrives through the module graph. The local-db worker
 * doesn't: `new Worker(new URL('./local-db-worker.js', import.meta.url))` is
 * requested as a raw URL, Vite refuses it ("outside of Vite serving allow
 * list"), and in dev the device database never starts. It fails with only a
 * console warning. The worker imports litestone's browser worker, so that
 * package's real directory has to be servable as well.
 *
 * Setting `server.fs.allow` replaces Vite's default, so the workspace root
 * goes first to keep what was allowed before. Vite concatenates arrays when it
 * merges configs, so an app's own `fs.allow` still adds to this list.
 */

import { existsSync, realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { searchForWorkspaceRoot } from 'vite'

const SIERRA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The real directory of `@frontierjs/<name>` as the app would resolve it. */
function linkedPackageDir(root, name) {
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    const pkgDir = resolve(dir, 'node_modules', '@frontierjs', name)
    if (existsSync(pkgDir)) return realpathSync(pkgDir)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

export function fsAllowPlugin() {
  return {
    name: 'sierra:fs-allow',
    apply: 'serve',
    config(userConfig) {
      const root = resolve(userConfig.root ?? process.cwd())
      const allow = [searchForWorkspaceRoot(root), realpathSync(SIERRA_DIR)]
      const litestone = linkedPackageDir(root, 'litestone')
      if (litestone) allow.push(litestone)
      return { server: { fs: { allow } } }
    },
  }
}
