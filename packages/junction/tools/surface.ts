#!/usr/bin/env bun
// tools/surface.ts
// The API surface as a committed file — `junction surface`.
//
// The Data realm has two of these already (`litestone access`, `litestone ddl`).
// This is the API realm's: what services exist, what each will answer, which
// hooks run around it in what ORDER, what it broadcasts on, and every path the
// router actually mounted.
//
// None of that is derivable from the source text. `collectCustomMethods` decides at
// construction whether a key is an option or an action, `svc.pipelines()`
// resolves the chain, `apiPrefix` moves every route the app registers, and a
// plugin mounts paths nobody wrote down. So the surface is read off a BUILT
// app — `describe()` and `buildRoutes()`, the declared owners — rather than
// scanned, which is the one thing that makes the file worth committing.
//
// Usage:
//   junction surface --app src/core/app.ts [--export buildApp]
//   junction surface --app src/core/app.ts --check     ← exit 1 if stale (CI)
//   junction surface --app src/core/app.ts --stdout
//
// The app module must expose the app WITHOUT listening: a built `App`, or a
// factory returning one. That is the same contract `@frontierjs/testing` takes
// as `api:`, and an entry that calls `app.start()` at module scope satisfies
// neither — guard it with `import.meta.main`.

import { writeFileSync }             from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

// The loader, the arg helpers and the `--check` compare are shared with
// `junction jobs` — see tools/app-module.ts.
import { flag, getFlag, rel, fatal, loadApp, checkSnapshot } from './app-module.ts'

import { buildRoutes, serializeHookMap } from '../src/plugins/manifest/index.ts'
import type { App }                      from '../src/core/app.ts'

const argv = Bun.argv.slice(2)

// ─── the surface ──────────────────────────────────────────────────────────────

export interface SurfaceService {
  name:          string
  model:         string
  methods:       string[]
  customMethods: string[]
  channel:       string[]
  transactional: string[]
  softDelete:    string | null
  cache:         boolean
  idField:       string
  allowBulk:     boolean
  bulkMax:       number
  hooks:         Record<string, Record<string, string[]>>
}

export interface Surface {
  prefix:    string
  plugins:   string[]
  appHooks:  Record<string, Record<string, string[]>>
  services:  SurfaceService[]
  routes:    { method: string; path: string; kind: string }[]
}

export function describeSurface(app: App): Surface {
  const cfg = app.config as Record<string, unknown>

  const services = [...app.services.values()].map(svc => {
    const d = svc.describe()
    // `channel` is a service field rather than part of describe() — normalised
    // to a list because the declaration takes one name or several.
    const channel = svc.channel == null ? []
      : Array.isArray(svc.channel) ? [...svc.channel] as string[]
      : typeof svc.channel === 'string' ? [svc.channel]
      : ['(computed)']

    return {
      name:          d.name,
      model:         d.model,
      methods:       d.methods,
      customMethods: d.customMethods,
      channel,
      transactional: d.transactional,
      softDelete:    d.softDelete,
      cache:         d.cache,
      idField:       d.idField,
      allowBulk:     d.allowBulk,
      bulkMax:       d.bulkMax,
      hooks:         serializeHookMap(d.hooks) as unknown as Record<string, Record<string, string[]>>,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  return {
    prefix:   (cfg.apiPrefix as string) ?? '',
    // `app._plugins` is already the names, in configure order.
    plugins:  [...(app._plugins ?? [])],
    appHooks: serializeHookMap(app._appHooks ?? {}) as unknown as Record<string, Record<string, string[]>>,
    services,
    routes:   buildRoutes(app),
  }
}

// ─── rendering ────────────────────────────────────────────────────────────────
//
// Ordering is the whole point in two places and must not be sorted away: a hook
// chain runs in the order it is listed, and the plugin list is configure order,
// which `requires:` is checked against.

const PHASES = ['before', 'around', 'after', 'error'] as const

function hookRows(map: Record<string, Record<string, string[]>>): string[] {
  const rows: string[] = []
  for (const phase of PHASES) {
    for (const [method, chain] of Object.entries(map[phase] ?? {})) {
      if (!chain?.length) continue
      rows.push(`| ${phase} | \`${method}\` | ${chain.map(h => `\`${h}\``).join(' → ')} |`)
    }
  }
  return rows
}

export function renderSurfaceSnapshot(surface: Surface, opts: { source?: string; command?: string } = {}): string {
  const { source = 'app.ts', command = `junction surface --app ${source}` } = opts
  const out: string[] = []

  out.push('# API surface snapshot')
  out.push('')
  // The machine half: scripts/ci.mjs reads this line and reruns the command
  // with --check from this file's own directory.
  out.push(`<!-- generated by: ${command} -->`)
  out.push('')
  out.push(`Generated from \`${source}\` by \`junction surface\`. **Do not edit.**`)
  out.push('')
  out.push('What the API answers, read off a BUILT app rather than scanned: the methods')
  out.push('each service will serve, its custom methods, the hook chain in the order it runs,')
  out.push('and every path the router actually mounted. None of it is visible in the source —')
  out.push('an option key and a method look identical, `apiPrefix` moves every route, and')
  out.push('a plugin mounts paths nobody wrote. Regenerate after a change and read the diff.')
  out.push('')
  out.push('```')
  out.push(`${surface.services.length} services · ${surface.routes.length} routes · ` +
           `${surface.plugins.length} plugins · prefix ${surface.prefix || '(none)'}`)
  out.push('```')
  out.push('')

  // ── App hooks ──
  const appRows = hookRows(surface.appHooks)
  out.push('## App hooks')
  out.push('')
  out.push('Run around EVERY service call, machine-facing endpoints included. `all` is not')
  out.push('a method — it applies to each one.')
  out.push('')
  if (appRows.length) {
    out.push('| Phase | Method | Chain |')
    out.push('| --- | --- | --- |')
    out.push(...appRows)
  } else {
    out.push('The app declares none.')
  }
  out.push('')

  // ── Services ──
  out.push('## Services')
  out.push('')
  out.push('`methods` is policy-applied — what the service will answer, not what it')
  out.push('defines. A custom method is a non-CRUD one `collectCustomMethods` resolved at')
  out.push('construction; a name that stopped being one is a line that disappears here.')
  out.push('`model` is what the service reports for the result envelope, which is its own')
  out.push('name when it declares none.')
  out.push('')

  for (const svc of surface.services) {
    out.push(`### \`${svc.name}\`${svc.model ? ` · model \`${svc.model}\`` : ''}`)
    out.push('')
    out.push(`- **methods** — ${svc.methods.length ? svc.methods.map(m => `\`${m}\``).join(', ') : '(none)'}`)
    if (svc.customMethods.length) out.push(`- **custom methods** — ${svc.customMethods.map(a => `\`${a}\``).join(', ')}`)
    if (svc.channel.length)       out.push(`- **broadcasts on** — ${svc.channel.map(c => `\`${c}\``).join(', ')}`)
    if (svc.transactional.length) out.push(`- **transactional** — ${svc.transactional.map(m => `\`${m}\``).join(', ')}`)
    if (svc.softDelete)           out.push(`- **soft delete** — \`${svc.softDelete}\``)
    if (svc.cache)                out.push('- **cached**')
    if (svc.idField !== 'id')     out.push(`- **id field** — \`${svc.idField}\``)
    if (svc.allowBulk)            out.push(`- **bulk** — allowed, max ${svc.bulkMax} rows per filtered write`)
    out.push('')

    const rows = hookRows(svc.hooks)
    if (rows.length) {
      out.push('| Phase | Method | Chain |')
      out.push('| --- | --- | --- |')
      out.push(...rows)
      out.push('')
    }
  }

  // ── Routes ──
  out.push('## Routes')
  out.push('')
  out.push('Read off the router, so a path appears here whether or not anything meant to')
  out.push('mount it. A `{service}` path is the CRUD handler and names every service at')
  out.push('once; everything else was registered by hand or by a plugin.')
  out.push('')
  out.push('| Method | Path | Kind |')
  out.push('| --- | --- | --- |')
  for (const r of surface.routes) out.push(`| ${r.method} | \`${r.path}\` | ${r.kind} |`)
  out.push('')

  // ── Plugins ──
  out.push('## Plugins')
  out.push('')
  out.push('In configure order, which is what `requires:` is checked against.')
  out.push('')
  for (const [i, name] of surface.plugins.entries()) out.push(`${i + 1}. \`${name}\``)
  out.push('')

  return out.join('\n').replace(/\n+$/, '\n')
}

// ─── main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const appPath = getFlag('app')
  if (!appPath) fatal('junction surface needs --app <module> — the module exposing the app or a factory for it')

  const exportName  = getFlag('export')
  const servicesDir = getFlag('services')
  const app         = await loadApp(appPath, exportName, servicesDir)
  const surface     = describeSurface(app)

  // Default beside the CWD, not beside the app module. An app is built with the
  // cwd its own scripts use — a database path, a config file and the autoload
  // directory are all resolved against it — and CI reruns this from the
  // snapshot's directory, so the two have to be the same place. That is the app
  // root, which is where `bun run api` is run from.
  const outPath = getFlag('out')
    ? resolve(getFlag('out') as string)
    : resolve(process.cwd(), 'surface.snapshot.md')

  const from    = dirname(outPath)
  const arg     = (p: string) => relative(from, resolve(p)) || '.'
  const command = `junction surface --app ${arg(appPath)}` +
                  (exportName  ? ` --export ${exportName}`      : '') +
                  (servicesDir ? ` --services ${arg(servicesDir)}` : '')
  const body    = renderSurfaceSnapshot(surface, { source: arg(appPath), command })

  if (flag('stdout')) {
    process.stdout.write(body)
  } else if (flag('check')) {
    checkSnapshot(outPath, body, command, 'API surface')
  } else {
    writeFileSync(outPath, body, 'utf8')
    console.log(`  ✓  ${rel(outPath)}`)
    console.log(`  ${surface.services.length} services · ${surface.routes.length} routes · ${surface.plugins.length} plugins`)
  }

  // An app built for description holds whatever its plugins opened — a database,
  // a job poller, a scheduler. Nothing here asked them to stop, and a tool that
  // never exits fails CI as a timeout rather than as an answer.
  await app.stop?.().catch(() => {})
  process.exit(0)
}
