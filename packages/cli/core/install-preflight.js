// core/install-preflight.js
// "Is every package this app declares installed?" — asked before a dev server starts.
//
// The failure this exists for: a fresh clone has no node_modules, `fli dev`
// starts both surfaces anyway, and each fails in its own words — the web
// surface with `vite: command not found`, the API with `Cannot find module
// '@frontierjs/junction/…'` — neither of which says *run install*. A pull that
// added a dependency fails the same way one package at a time.
//
// Per package rather than "is there a node_modules", because the second case
// has one.
//
// ─── how a package is looked for ─────────────────────────────────────────────
//
// `<dir>/node_modules/<name>/package.json`, walking UP from the app — the
// directories node and bun both search, so a workspace member whose packages
// are hoisted to the root reads as installed. Never `require.resolve`, which
// bun answers from its global cache (`FJS-666`), and never an import, which
// would run the package.
//
// ─── `link:` ─────────────────────────────────────────────────────────────────
//
// `fli new --source local` writes `link:@frontierjs/x`, which resolves through
// THIS machine's `bun link` registry. A clone moved to a machine that never ran
// `bun link` in those packages fails `bun install` itself, so those are named
// before the install is offered rather than after it fails.

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Every package the manifest declares that is not installed where the app
 * would resolve it from.
 *
 * @returns {string[]} names, sorted; empty when there is no manifest
 */
export function missingPackages(appRoot) {
  const manifest = readManifest(appRoot)
  if (!manifest) return []
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  return declared.filter(name => !isInstalled(appRoot, name)).sort()
}

function isInstalled(appRoot, name) {
  let dir = appRoot
  for (;;) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * The `link:` dependencies this machine's bun has no registration for.
 * `bunGlobal` is the registry directory; the default is bun's own.
 *
 * @returns {string[]}
 */
export function unregisteredLinks(appRoot, { bunGlobal = defaultBunGlobal() } = {}) {
  const manifest = readManifest(appRoot)
  if (!manifest) return []
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('link:'))
    .map(([name, spec]) => spec.slice('link:'.length) || name)
    .filter(target => !existsSync(join(bunGlobal, target)))
    .sort()
}

function defaultBunGlobal() {
  const home = process.env.BUN_INSTALL || resolve(homedir(), '.bun')
  return resolve(home, 'install', 'global', 'node_modules')
}

function readManifest(appRoot) {
  try {
    return JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
  } catch { return null }
}
