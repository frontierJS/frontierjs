// src/plugins/declared.ts
// The plugins `junction.config.js` may DECLARE rather than construct (`FJS-D256`).
//
// Here rather than in core/app.ts because this table names batteries, and the
// core names none (`FJS-D639`): the start phase imports this one module, and
// this module knows the rest.

import type { App, Plugin } from '../core/app.ts'
import type { AppConfig }   from '../config/index.ts'

/**
 * Install the plugins `config.plugins` declares.
 *
 * The line between this and `app.configure()` is what the option TAKES: data is
 * declared, code is constructed (`FJS-D256`). `health.checks`, `health.authFn`
 * and `manifest.db` are the three options here that are not data — an app
 * needing one configures the plugin by hand and declares nothing, and
 * `manifest.db` is not even a gap, since a manifest installed from here is
 * handed `app.db` already.
 *
 * Declaring a plugin here AND configuring it by hand is refused by name: two
 * registrations mount two routes on one path, and which answers is the order
 * they were added in.
 */
export async function applyConfiguredPlugins(app: App, config: AppConfig, configured: Plugin[]): Promise<void> {
  const declared = (config.plugins ?? {}) as Record<string, unknown>
  const byHand   = new Set(configured.map(p => p.name))

  const clash = Object.keys(declared).filter(k => declared[k] && byHand.has(k))
  if (clash.length) {
    throw new Error(
      `[Junction] ${clash.map(c => `'${c}'`).join(', ')} ` +
      `${clash.length === 1 ? 'is' : 'are'} declared in config AND configured by hand. ` +
      `One owner: declare it in junction.config.js's \`plugins:\`, or call ` +
      `app.configure() and leave it out of the file. Configure by hand where the ` +
      `plugin needs CODE — health's \`checks\`/\`authFn\` cannot be written in config.`
    )
  }

  const opts = (k: string): Record<string, unknown> =>
    typeof declared[k] === 'object' ? declared[k] as Record<string, unknown> : {}

  // Imported on demand: an app declaring none would otherwise still load
  // openapi's reference page and devtools' second server.
  if (declared.health) {
    const { healthPlugin } = await import('../transport/health.ts')
    app.configure(healthPlugin(opts('health')))
  }
  // `db` is derived rather than declared: the manifest wants the client the app
  // was built with, and there is exactly one.
  if (declared.manifest) {
    const { manifestPlugin } = await import('./manifest/index.ts')
    app.configure(manifestPlugin({ ...opts('manifest'), ...(app.db ? { db: app.db } : {}) }))
  }
  if (declared.openapi) {
    const { openapi } = await import('./openapi/index.ts')
    const o = opts('openapi')
    app.configure(openapi({
      title:   (o.title   as string) ?? (config.name as string | undefined) ?? 'API',
      version: (o.version as string) ?? '1.0.0',
      ...o,
    } as Parameters<typeof openapi>[0]))
  }
  if (declared.devtools) {
    const { devtools } = await import('./devtools/index.ts')
    app.configure(devtools(opts('devtools')))
  }
}
