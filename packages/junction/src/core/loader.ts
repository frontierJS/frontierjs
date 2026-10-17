// core/loader.ts
// Auto-discovers *.service.ts files recursively under the services/ directory.
// Each file export-defaults a definition — `export default createService({…})` —
// and the registry builds it (`FJS-D1079`).
// Name derived from filename: accounts.service.ts → 'accounts'.
// Manual registration always takes precedence.
//
// Also loads routes/ (`FJS-D626`): a file's path there is the URL it answers.

import { join } from 'node:path'
import { watch, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ServiceDefinition, ServiceRegistry } from './service.ts'
import { diagnostic }       from './diagnostics.ts'

// ─── Loader ───────────────────────────────────────────────────────────────



export interface LoaderOptions {
  dir:      string               // path to services/ directory
  registry: ServiceRegistry
  exclude?: string[]             // filenames to skip
  /**
   * Where an authoring mistake goes. The same keyed sink `buildService` writes
   * to, read by `start()`'s `check-authoring` phase, which refuses with every
   * finding at once (`FJS-D199`).
   *
   * Everything here used to be a `console.warn` or a `console.error` and a
   * `continue`, so the app booted green with a service missing and the failure
   * arrived later as a 404 against a name somebody had written down. Without a
   * sink the loader keeps that behavior, which is what a direct caller gets.
   */
  report?:  (key: string, finding: string) => void
}

export async function autoloadServices(opts: LoaderOptions): Promise<void> {

  const { dir, registry, exclude = [], report } = opts

  const files = await findServiceFiles(dir)
  // Which file registered a name, so a duplicate can name BOTH of them. Load
  // order is `results.sort()`, so the winner is the first file alphabetically —
  // which nobody wrote down and is not a reason to prefer one.
  const registeredBy = new Map<string, string>()

  for (const file of files) {

    const filename = file.split('/').pop() ?? ''
    if (exclude.some(e => filename.includes(e))) continue

    try {
      const mod = await import(file)
      const def = definitionOf(mod)

      if (!def) {
        const msg = `${file} export-defaults no service definition, so it registers nothing ` +
                    `and the name it would have had answers 404. A service file is ` +
                    `export default createService({ … }); a method reaches the app through ctx.app.`
        if (report) report(`loader:${file}:no-definition`, msg)
        else console.warn(`[Loader] ${msg}`)
        continue
      }

      const name = def.name ?? deriveName(filename)
      if (!registry.has(name)) {
        // The filename's own spelling stays reachable — a URL and an
        // `app.service(…)` written against it are not the app's mistake. Only
        // when it is a spelling of the declared name: `metrics.service.ts`
        // declaring 'metrics-store' is a different word, and aliasing it claims
        // 'metrics' for a service that never answered to it.
        const raw = rawStem(filename)
        registry.register({ ...def, name }, raw !== name && deriveName(filename) === name ? [raw] : [])
        registeredBy.set(name, file)
        // An inventory line, not news — `GET /manifest` answers the same
        // question on demand, and an app with 21 services printed 21 of these
        // before it had done anything. DEBUG=1 brings them back.
        diagnostic(`[Loader] Registered service: ${name} (${file})`)
      } else {
        // Two FILES claiming one name. Reported rather than skipped: one of them
        // is serving and the other is gone, decided by alphabetical order — so
        // the app answers a service nobody chose, and the loser's methods are
        // simply absent.
        //
        // `registeredBy` is what makes that decidable, and the distinction is
        // the whole check: a name already held by a MANUAL registration is this
        // file's header rule — *manual registration always takes precedence* —
        // which is the documented shape and how `basecamp` registers every
        // service it also keeps on disk. Reading that as a duplicate refuses a
        // correct app at boot, which is worse than the silence being fixed here.
        const held = registeredBy.get(name)
        if (!held) {
          // An app doing this for eighteen services must not print eighteen
          // warnings on every boot.
          diagnostic(`[Loader] Skipping ${name} — registered by hand, which wins`)
        } else if (report) {
          report(`loader:name:${name}`,
            `two service files claim the name '${name}': ${file} and ${held}, ` +
            `of which ${held} is the one serving because it sorts first. ` +
            `Rename one, or give one an explicit name.`)
        } else {
          console.warn(`[Loader] Skipping duplicate service: ${name}`)
        }
      }

    } catch (err) {
      // A service file that THREW is not a service this app has. It used to be
      // logged and stepped over, so the app booted green and the failure
      // arrived later as a 404 against a name somebody had written down.
      const msg = `${file} threw while loading, so its service is not registered and ` +
                  `every call to it answers 404: ` +
                  `${err instanceof Error ? err.message : String(err)}`
      if (report) report(`loader:${file}:threw`, msg)
      else console.error(`[Loader] Failed to load: ${file}`, err)
    }
  }
}

// ─── A new service file under `bun --watch` (`FJS-D1121`) ───────────────
// `bun --watch run api/index.ts` restarts on files already IMPORTED, and a new
// service file is imported by nobody, so its name answered 404 until the
// server was restarted by hand and nothing said so. This is the one place that
// knows which files are services, so it is the one place that notices a new
// one. Bun ignores an mtime-only touch; rewriting the entry with its own bytes
// is what restarts.

export interface ServiceWatchOptions {
  dir:       string
  /** Service files already loaded — an edit to one is bun's own restart. */
  known:     string[]
  /** Defaults to whether this process was started with `--watch` or `--hot`. */
  watching?: boolean
  entry?:    string | null
  restart?:  () => void
  say?:      (line: string) => void
}

export function watchForNewServices(opts: ServiceWatchOptions): { close(): void } | null {
  const watching = opts.watching ?? (process.execArgv.includes('--watch') || process.execArgv.includes('--hot'))
  if (!watching) return null

  const entry = opts.entry ?? (typeof Bun !== 'undefined' ? Bun.main : null)
  const restart = opts.restart ?? (() => { if (entry) writeFileSync(entry, readFileSync(entry)) })
  const say = opts.say ?? ((line: string) => console.log(line))

  const seen = new Set(opts.known)
  let pending = false
  let watcher: ReturnType<typeof watch>
  try {
    watcher = watch(opts.dir, { recursive: true }, (_event, filename) => {
      if (!filename || !String(filename).endsWith('.service.ts')) return
      const file = join(opts.dir, String(filename))
      if (seen.has(file) || !existsSync(file)) return
      seen.add(file)
      if (pending) return
      pending = true
      say(`[Loader] new service file ${filename} — restarting to register it`)
      // A save is often several events; let them land before the one restart.
      setTimeout(restart, 50)
    })
  } catch {
    return null   // directory gone — nothing to watch
  }
  watcher.unref?.()
  return { close: () => watcher.close() }
}

// ─── Recurse into services/ looking for *.service.ts ─────────────────────
// Bun.Glob handles recursion natively — no per-file stat() calls.

export async function findServiceFiles(dir: string): Promise<string[]> {
  // Glob.scan() throws if the directory doesn't exist — we catch that below.
  const glob    = new Bun.Glob('**/*.service.ts')
  const results: string[] = []

  try {
    for await (const file of glob.scan({ cwd: dir, absolute: false })) {
      results.push(join(dir, file))
    }
  } catch {
    return []   // directory doesn't exist — not an error
  }

  return results.sort()  // consistent load order across platforms
}

// ─── The definition a file export-defaults ───────────────────────────────
// A function is refused rather than called: a factory runs code at import and
// closes over an app the definition cannot be read without.

function definitionOf(mod: Record<string, unknown>): ServiceDefinition | null {
  const def = mod.default
  return def && typeof def === 'object' && !Array.isArray(def) ? def as ServiceDefinition : null
}

// ─── Derive service name from filename ───────────────────────────────────
// accounts.service.ts → 'accounts'
// user-profiles.service.ts → 'user-profiles'

/**
 * The canonical service name a filename derives.
 *
 * `accounts.service.ts` → `accounts`, and **`product-variants.service.ts` →
 * `productVariants`** (`FJS-570`). A kebab or snake filename is a FOURTH
 * spelling of a name Invariant 2 says three resolvers must agree on, and until
 * this it was reconciled nowhere: `deriveModelName('product-variants')`
 * singularizes to `product-variant`, which is not the accessor — which is why
 * all six multi-word services in `example` hand-write `model:` — and Sierra's
 * `serviceNameFor('ProductVariant')` answers `productVariants`, which matched
 * nothing, so every relation picker onto a multi-word model offered an empty
 * list and read as *there are none*.
 *
 * The file keeps its kebab name; the SERVICE gets one spelling. The old name is
 * registered as an alias, so `/product-variants` and
 * `app.service('product-variants')` keep working — nothing on the wire moves.
 */
export function deriveName(filename: string): string {
  const stem = filename.replace(/\.service\.(ts|js|mts|mjs)$/, '')
  return stem.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** The filename's own spelling, for the alias — `product-variants`. */
function rawStem(filename: string): string {
  return filename.replace(/\.service\.(ts|js|mts|mjs)$/, '')
}

// ─── Manual service file loader ───────────────────────────────────────────
// For when you want to control load order explicitly.

export async function loadServiceFile(
  path:     string,
  registry: ServiceRegistry
): Promise<void> {
  const def = definitionOf(await import(path))
  if (!def) throw new Error(`${path} export-defaults no service definition — export default createService({ … })`)
  registry.register({ ...def, name: def.name ?? deriveName(path.split('/').pop() ?? '') })
}

// ─── Routes ───────────────────────────────────────────────────────────────
// `routes/hooks/calendar.ts` answers `/hooks/calendar`, and each of its `GET`,
// `POST`, `PUT`, `PATCH` and `DELETE` exports is that method's handler. A
// `[id]` segment is the `{id}` capture, and `index` is its folder. A file or
// folder beginning `_` is private to the files beside it.

const ROUTE_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export interface RouteLoaderOptions {
  dir:     string
  app:     Record<string, unknown>
  report?: (key: string, finding: string) => void
}

/** `files/[id]/index.ts` → `/files/{id}`; null when the file is not a route. */
export function routeUrlFor(rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').replace(/\.(ts|js|mts|mjs)$/, '').split('/')
  if (parts.some(p => p.startsWith('_'))) return null
  if (parts[parts.length - 1] === 'index') parts.pop()
  return '/' + parts.map(p => p.replace(/^\[(\w+)\]$/, '{$1}')).join('/')
}

// Param NAMES are erased for the same reason the router erases them: `/a/{id}`
// and `/a/{slug}` accept the same requests, so two files claiming them are one
// URL claimed twice.
const urlShape = (url: string) => url.replace(/\{\w+\}/g, '{}')

export async function autoloadRoutes(opts: RouteLoaderOptions): Promise<void> {
  const { dir, app, report } = opts
  const fail = (key: string, finding: string) => {
    if (report) report(key, finding)
    else console.error(`[Loader] ${finding}`)
  }

  const files: string[] = []
  try {
    for await (const f of new Bun.Glob('**/*.{ts,js,mts,mjs}').scan({ cwd: dir })) {
      if (/\.(d|test|spec)\.[mc]?[tj]s$/.test(f)) continue
      files.push(f)
    }
  } catch { return }
  files.sort()

  const claimedBy = new Map<string, string>()

  for (const rel of files) {
    const url = routeUrlFor(rel)
    if (!url) continue
    const file = join(dir, rel)

    try {
      const shape = urlShape(url)
      const held  = claimedBy.get(shape)
      if (held) {
        fail(`loader:route:${shape}`,
          `two route files answer ${url}: ${join('routes', rel)} and ${held}. ` +
          `A file's path is its URL, so one of them has to move.`)
        continue
      }
      claimedBy.set(shape, join('routes', rel))

      const mod  = await import(file)
      const verbs = ROUTE_VERBS.filter(v => typeof mod[v] === 'function')
      if (verbs.length === 0) {
        fail(`loader:${file}:no-verb`,
          `${join('routes', rel)} exports none of ${ROUTE_VERBS.join(', ')}, so ${url} answers 404. ` +
          `Export each method's handler by its verb, e.g. export const GET = (ctx) => …`)
        continue
      }
      for (const v of verbs) {
        const register = app[v.toLowerCase()] as (path: string, handler: unknown) => unknown
        register.call(app, url, mod[v])
      }
    } catch (err) {
      fail(`loader:${file}:threw`,
        `${join('routes', rel)} threw while loading, so ${url} answers 404: ` +
        `${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
