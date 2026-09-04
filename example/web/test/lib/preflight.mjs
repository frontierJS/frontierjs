// web/test/lib/preflight.mjs — is the process this drive is about to test the
// one this tree describes?
//
// Every drive here opens by checking that its servers answer. That check is
// necessary and it is not sufficient: a server answering on port 8110 may be a
// process started before the change under test — `bun run api` spawns a CHILD,
// so a harness that kills the wrapper leaves the app holding its ports, the
// next `bun run api` exits EADDRINUSE into a log nobody reads, and the drive's
// own readiness poll is satisfied by the stale process. The drive then reports
// on code that is not in the tree, in either direction: a green run that proves
// nothing, or a red one blamed on the change that is actually absent from the
// process (`FJS-740`).
//
// So reachability and freshness are asked together, because separating them is
// how the second one stops being asked. Freshness is `uptime` — which junction's
// own `/health` already answers, in seconds since `app.start()` — against the
// newest mtime under the directories that make up the app. An app that booted
// before its own newest source file is serving something else.
//
// It is deliberately NOT a build stamp. There is no build step in dev, the
// comparison has to hold for a process somebody started by hand in another
// terminal, and mtime is the only fact both sides can see.

import { readdirSync, statSync } from 'node:fs'
import { join, dirname }         from 'node:path'
import { fileURLToPath }         from 'node:url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// What the API process is built from. `web/` is absent on purpose: the SPA is
// served by vite, which reloads its own graph, and a browser drive's page is
// fetched fresh every run.
const SOURCE_DIRS = ['api', 'db']
const SOURCE_EXT  = ['.ts', '.js', '.mjs', '.lite', '.json']

// A generated or written-at-runtime file is not a change to the app: the seed
// writes databases and their sidecars on every run, so counting them would make
// every drive report the app as stale the moment it seeded.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'audit'])
const SKIP_FILE = /\.(db|db-wal|db-shm|jsonl|snapshot\.\w+)$/

function newestSourceMtime(root = APP_ROOT) {
  let newest = 0

  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (SKIP_FILE.test(entry.name)) continue
      if (!SOURCE_EXT.some(ext => entry.name.endsWith(ext))) continue
      try {
        const at = statSync(join(dir, entry.name)).mtimeMs
        if (at > newest) newest = at
      } catch { /* raced with a write; another file will do */ }
    }
  }

  for (const dir of SOURCE_DIRS) walk(join(root, dir))
  return newest
}

// `uptime` is whole seconds, so a process started in the same second as the
// last edit reads as up to a second older than it is. Two seconds of slack
// rather than one, because the boot itself takes some.
const SLACK_MS = 2_000

/**
 * Check every server answers, and that any of them reporting an `uptime` was
 * started after the newest change to the app's source. Exits 1 naming the
 * process that is missing or stale — a drive has nothing useful to say once
 * either is true.
 *
 * @param servers [name, url][] — the url is what is fetched, so an API entry
 *   should point at `/api/health`, which is the endpoint carrying `uptime`.
 */
export async function requireServers(servers) {
  for (const [name, url] of servers) {
    let res
    try {
      res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      console.error(`Cannot reach ${name} at ${url} — ${e.message}`)
      process.exit(1)
    }

    const uptime = await uptimeOf(res)
    if (uptime === null) continue

    const bootedAt = Date.now() - uptime * 1000
    const newest   = newestSourceMtime()
    if (newest > bootedAt + SLACK_MS) {
      const age = Math.round((newest - bootedAt) / 1000)
      console.error(
        `${name} at ${url} started ${age}s before the newest change under api/ or db/ — ` +
        `it is serving code that is not in this tree.\n` +
        `Restart it. If a restart says the port is in use, an older run is still holding it: ` +
        `\`bun run api\` spawns a child, so killing the wrapper leaves the app running.`,
      )
      process.exit(1)
    }
  }
}

async function uptimeOf(res) {
  try {
    const body = await res.clone().json()
    return typeof body?.uptime === 'number' ? body.uptime : null
  } catch {
    return null   // not a health endpoint — nothing to compare
  }
}
