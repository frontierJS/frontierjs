// core/loader.ts
// Auto-discovers *.service.ts files recursively under the services/ directory.
// Factory function must be named create*Service.
// Name derived from filename: accounts.service.ts → 'accounts'.
// Manual registration always takes precedence.

import { join } from 'node:path'
import { createService, isBuiltService } from './service.ts'
import type { Service }     from './service.ts'
import type { ServiceRegistry } from './service.ts'
import { diagnostic }       from './diagnostics.ts'

// ─── Loader ───────────────────────────────────────────────────────────────



export interface LoaderOptions {
  dir:      string               // path to services/ directory
  app:      unknown              // passed to every factory
  registry: ServiceRegistry
  exclude?: string[]             // filenames to skip
}

export async function autoloadServices(opts: LoaderOptions): Promise<void> {

  const { dir, app, registry, exclude = [] } = opts

  const files = await findServiceFiles(dir)

  for (const file of files) {

    const filename = file.split('/').pop() ?? ''
    if (exclude.some(e => filename.includes(e))) continue

    try {
      const mod     = await import(file)
      const factory = findFactory(mod)

      if (!factory) {
        console.warn(`[Loader] No create*Service factory found in: ${file}`)
        continue
      }

      let service = factory(app) as Service

      // Bare method object (e.g. a factory returning createBaseService(...)
      // directly, without createService) — wrap it into a full service with
      // the filename-derived name. This makes the minimal service file:
      //
      //   export function createPostsService() {
      //     return createBaseService({ model: 'posts' })
      //   }
      //
      // fully registrable: name from the filename, db from app.db.
      //
      // The test is a MARKER createService stamps, not the shape of one field.
      // It used to ask `typeof service.hooks !== 'function'` — answering "was
      // this built?" by inspecting a single key's type, which is the same
      // by-exclusion reasoning the method table exists to replace, and which
      // wrapped anything that happened to carry a `hooks` map.
      if (service && typeof service === 'object' && !isBuiltService(service)) {
        service = createService({
          name: deriveName(filename),
          ...(service as unknown as Record<string, unknown>),
        })
      }

      if (!service?.name) {
        // Derive name from filename if not set on the service
        const derived = deriveName(filename)
        ;(service as { name: string }).name = derived
      }

      if (!registry.has(service.name)) {
        // The filename's own spelling stays reachable — a URL and an
        // `app.service(…)` written against it are not the app's mistake.
        const raw = rawStem(filename)
        registry.register(service, raw === service.name ? [] : [raw])
        // An inventory line, not news — `GET /manifest` answers the same
        // question on demand, and an app with 21 services printed 21 of these
        // before it had done anything. DEBUG=1 brings them back.
        diagnostic(`[Loader] Registered service: ${service.name} (${file})`)
      } else {
        console.warn(`[Loader] Skipping duplicate service: ${service.name}`)
      }

    } catch (err) {
      console.error(`[Loader] Failed to load: ${file}`, err)
    }
  }
}

// ─── Recurse into services/ looking for *.service.ts ─────────────────────
// Bun.Glob handles recursion natively — no per-file stat() calls.

async function findServiceFiles(dir: string): Promise<string[]> {
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

// ─── Find factory function in module exports ──────────────────────────────
// Looks for: createXxxService, createXxx, or 'default' if it's a factory

function findFactory(mod: Record<string, unknown>): ((app: unknown) => Service) | null {

  // Named export: createAccountsService, createUsersService, etc.
  for (const key of Object.keys(mod)) {
    if (/^create\w+Service$/.test(key) && typeof mod[key] === 'function') {
      return mod[key] as (app: unknown) => Service
    }
  }

  // Default export that is a function
  if (typeof mod.default === 'function') {
    return mod.default as (app: unknown) => Service
  }

  // Default export that is already a service object
  if (
    mod.default &&
    typeof mod.default === 'object' &&
    'name' in mod.default &&
    'find' in mod.default
  ) {
    const service = mod.default as Service
    return () => service
  }

  return null
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
 * singularises to `product-variant`, which is not the accessor — which is why
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
  app:      unknown,
  registry: ServiceRegistry
): Promise<void> {
  const mod     = await import(path)
  const factory = findFactory(mod)

  if (!factory) throw new Error(`No factory found in: ${path}`)

  const service = factory(app) as Service
  registry.register(service)
}
