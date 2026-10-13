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
 * The same holds for every other linked package. Vite serves a file outside
 * the list once an importer it has transformed resolves to it, so ui, css and
 * toolbelt work on a warm server, and 403 when the browser asks first: a page
 * reloaded from cached module URLs after a restart. So every `@frontierjs/*`
 * the app links is allowed, not only the two the worker needs.
 *
 * Setting `server.fs.allow` replaces Vite's default, so the workspace root
 * goes first to keep what was allowed before. Vite concatenates arrays when it
 * merges configs, so an app's own `fs.allow` still adds to this list.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Vite's own `searchForWorkspaceRoot`, without importing `vite` for it. A
 * linked sierra resolves that import to ITS vite, the app's config loader
 * already holds the app's, and the dev server runs two copies of vite in one
 * process: rolldown's 18 MB native binding loaded twice, 150 ms of every
 * start, and two versions of one package sharing one server.
 *
 * The nearest ancestor that is a workspace root (`workspaces` in its
 * package.json, or a `pnpm-workspace.yaml`), else the nearest package root.
 */
function workspaceRoot(start) {
  let packageRoot = null
  for (let dir = start; ; dir = dirname(dir)) {
    const manifest = resolve(dir, 'package.json')
    if (existsSync(manifest)) {
      packageRoot ??= dir
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir
      } catch { /* unreadable manifest is not a workspace root */ }
    }
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    if (dirname(dir) === dir) return packageRoot ?? start
  }
}

/** The real directory of every `@frontierjs/*` package, as the app would resolve it. */
function linkedPackageDirs(root) {
  let dir = resolve(root)
  for (let i = 0; i < 6; i++) {
    const scope = resolve(dir, 'node_modules', '@frontierjs')
    if (existsSync(scope)) {
      return readdirSync(scope)
        .map(name => resolve(scope, name))
        .filter(existsSync)
        .map(p => realpathSync(p))
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return []
}

export function fsAllowPlugin() {
  return {
    name: 'sierra:fs-allow',
    apply: 'serve',
    config(userConfig) {
      const root = resolve(userConfig.root ?? process.cwd())
      const allow = [workspaceRoot(root), realpathSync(SIERRA_DIR)]
      for (const dir of linkedPackageDirs(root)) if (!allow.includes(dir)) allow.push(dir)
      return { server: { fs: { allow } } }
    },
  }
}
