// src/autoload.ts
// Scans a directory for *.job.ts files and registers their default exports.
// Mirrors Junction's autoloadServices pattern exactly.

import type { CaravanInstance, RegisteredHandler } from './types.ts'

/**
 * Autoload all *.job.ts (or *.job.js) files from a directory.
 * Each file must export a default created by defineJob().
 *
 * @example
 * // jobs/send-email.job.ts
 * export default defineJob('send-email', async (job) => {
 *   await mailer.send(job.data)
 * }, { queue: 'email', maxAttempts: 5 })
 */
export async function autoloadJobs(
  rawDir: string,
  caravan: Pick<CaravanInstance, 'handle'>,
): Promise<string[]> {
  const loaded: string[] = []

  // `dir` must outlive the try — the loop below builds absolute paths from it.
  let dir: string
  let entries: string[]
  try {
    const glob = new Bun.Glob('**/*.job.{ts,js}')
    const { resolve } = await import('node:path')
    dir = resolve(process.cwd(), rawDir)
    entries = await Array.fromAsync(glob.scan({ cwd: dir }))
  } catch {
    // Directory doesn't exist or isn't readable — silent skip
    return loaded
  }

  for (const entry of entries) {
    const fullPath = `${dir}/${entry}`
    try {
      const mod = await import(fullPath)
      const def = mod.default

      if (!def || typeof def !== 'object' || def.__caravanJob !== true) {
        console.warn(`[Caravan] ${entry}: default export is not a defineJob() result — skipped`)
        continue
      }

      const handler = def as RegisteredHandler & { __caravanJob: true }
      caravan.handle(handler.name, handler.handler, {
        queue:       handler.queue,
        maxAttempts: handler.maxAttempts,
        retryDelay:  handler.retryDelay,
      })

      loaded.push(handler.name)
    } catch (err) {
      console.error(`[Caravan] Failed to load ${entry}:`, err)
    }
  }

  return loaded
}
