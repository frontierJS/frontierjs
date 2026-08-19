// src/autoload.ts
// Scans a directory for *.job.ts files and registers their default exports.
// Mirrors Junction's autoloadServices pattern exactly.
//
// A job in `jobsDir` is NAMED BY ITS FILE. `defineJob` still states the name —
// it is what a dispatch handle carries — but a stated name that disagrees with
// the file is refused here rather than registered: the symptom otherwise is a
// handler answering to `send-emial` while every dispatch says `send-email`, and
// a job that silently never runs is the worst failure this package has.

import type { JobDefinition, JobRegistrar } from './types.ts'

const JOB_SUFFIX = /\.job\.(ts|js)$/

/** The name a job file declares by existing: `jobs/send-email.job.ts` → `send-email`. */
export function jobNameFromFile(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(JOB_SUFFIX, '')
}

/**
 * Autoload all *.job.ts (or *.job.js) files from a directory.
 * Each file must export a default created by defineJob(), named for the file.
 *
 * @example
 * // jobs/send-email.job.ts
 * export default defineJob('send-email', async (ctx) => {
 *   await mailer.send(ctx.data)
 * }, { queue: 'email', maxAttempts: 5 })
 */
export async function autoloadJobs(
  rawDir: string,
  caravan: JobRegistrar,
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

    // Only the import is guarded. A file that cannot be loaded is one file's
    // problem; a file that loads and declares the wrong name is a defect the
    // app must not start with, so the check below throws past this.
    let mod: { default?: unknown }
    try {
      mod = await import(fullPath)
    } catch (err) {
      console.error(`[Caravan] Failed to load ${entry}:`, err)
      continue
    }

    const def = mod.default as JobDefinition | undefined

    if (!def || typeof def !== 'object' || def.__caravanJob !== true) {
      console.warn(`[Caravan] ${entry}: default export is not a defineJob() result — skipped`)
      continue
    }

    const expected = jobNameFromFile(entry)
    if (def.name !== expected) {
      throw new Error(
        `[Caravan] ${entry}: defineJob('${def.name}') does not match the file name. ` +
        `A job in jobsDir is named by its file, so this would register '${def.name}' ` +
        `while every dispatch naming '${expected}' waits for a handler that never arrives. ` +
        `Rename the file to '${def.name}.job.ts', or the job to '${expected}'.`
      )
    }

    // The DEFINITION, not its keys re-listed. `handle()` already reads every
    // field off a definition, and restating them here made this the third
    // whitelist a job file's declaration had to pass — so a `timeout` written in
    // a job file was accepted by `defineJob`, dropped here, and reported as
    // having no bound. A key added to `JobDefinition` now reaches the registry
    // without anyone remembering this line exists.
    caravan.handle(def)

    loaded.push(def.name)
  }

  return loaded
}
