// ─── map-view.js — the console's `:map`: which apps, and each one's map ──────
//
// The map is `project:map --json`, run in the app's root. `buildProjectMap`
// lives in that command's module and is the one reader of a project
// (`FJS-1016`), so the console spawns it rather than collecting a second model
// beside it; a spawn costs about a second, the atlas boot included.
//
// An app is a directory with `db/schema.lite`, out of the project root and the
// directories its surfaces run in. A workspace root holds several and an app
// root is one. The pane names an app by that directory, which is looked up in
// this list and never joined onto a path, so a request names only an app the
// tree already shows.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runnables } from './runnables.js'
import { fillSecret } from './env-health.js'

/** `['.', 'example', …]` — every directory here that is an app, root first. */
export function mapApps(root) {
  const dirs = new Set(['.'])
  for (const r of runnables(root)) if (r.kind === 'surface' && r.dir) dirs.add(r.dir)
  return [...dirs].filter(d => existsSync(join(root, d, 'db', 'schema.lite')))
}

const appRoot = (root, dir) => mapApps(root).includes(dir) ? resolve(root, dir) : null

/** The model `project:map --json` prints for one app, or `{ error }`. */
export function readMap(root, dir, { fliRoot }) {
  const at = appRoot(root, dir)
  if (!at) return Promise.resolve({ status: 404, body: { error: `no app ${dir} here` } })
  const argv = [join(fliRoot, 'bin', 'fli.js'), 'project:map', '--json', '--project', at]
  return new Promise((done) => {
    execFile(process.execPath, argv, { cwd: at, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `project:map` prints its refusals as a line on stderr and exits 0.
      try { return done({ status: 200, body: JSON.parse(stdout) }) } catch {}
      const said = String(stderr || err?.message || '').trim().split('\n').filter(Boolean).at(-1)
      done({ status: 500, body: { error: said || `project:map printed no model for ${dir}` } })
    })
  })
}

/** One secret into the app's `.env`, through `fillSecret`'s own list. */
export function fillMapSecret(root, dir, key) {
  const at = appRoot(root, dir)
  if (!at) return { status: 404, body: { error: `no app ${dir} here` } }
  const out = fillSecret(at, String(key ?? ''))
  if (!out) return { status: 400, body: { error: `${key} is not a secret ${dir} names` } }
  return { status: 200, body: { ok: true, ...out } }
}
