// core/loader.ts
// Auto-discovers *.service.ts files recursively under the services/ directory.
// Factory function must be named create*Service.
// Name derived from filename: accounts.service.ts → 'accounts'.
// Manual registration always takes precedence.

import { join }              from 'node:path'
import { createService }     from './service.ts'
import type { Service }     from './service.ts'
import type { ServiceRegistry } from './service.ts'

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
      if (service && typeof service === 'object' && typeof service.hooks !== 'function') {
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
        registry.register(service)
        console.log(`[Loader] Registered service: ${service.name} (${file})`)
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

function deriveName(filename: string): string {
  return filename.replace(/\.service\.ts$/, '')
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
