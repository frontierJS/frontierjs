#!/usr/bin/env bun
// tools/surface.ts
// The API surface as a committed file — `junction surface`.
//
// The Data realm has two of these already (`litestone access`, `litestone ddl`).
// This is the API realm's: what services exist, what each will answer, which
// hooks run around it in what ORDER, what it broadcasts on, and every path the
// router actually mounted.
//
// None of that is derivable from the source text. `collectActions` decides at
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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve }    from 'node:path'

import { buildRoutes, serializeHookMap } from '../src/plugins/manifest/index.ts'
import type { App }                      from '../src/core/app.ts'

// ─── args ─────────────────────────────────────────────────────────────────────

const argv = Bun.argv.slice(2)

const flag    = (name: string) => argv.includes(`--${name}`)
const getFlag = (name: string) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null
}

const rel = (p: string) => relative(process.cwd(), p) || basename(p)

function fatal(message: string): never {
  console.error(`\n  ✗  ${message}\n`)
  process.exit(1)
}

// ─── loading the app ──────────────────────────────────────────────────────────
//
// Ambiguity is refused rather than guessed. A module exporting two factories has
// no obvious answer, and picking one silently would snapshot an app the running
// process never serves.

const isApp = (v: unknown): v is App =>
  !!v && typeof v === 'object' &&
  typeof (v as Record<string, unknown>).service === 'function' &&
  typeof (v as Record<string, unknown>).configure === 'function'

const FACTORY = /^(create|build|make)[A-Z]?\w*(App|Api)?$/

// Building an app is loud — its logger, the loader, and every plugin that
// announces itself write to stdout. With `--stdout` the caller is redirecting
// stdout into a file, so those lines would land INSIDE the snapshot. Moved to
// stderr for the duration of the build rather than silenced: a failure to boot
// has to stay readable, and it is the only diagnosis this tool can offer.
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write
  try { return await fn() } finally { process.stdout.write = write }
}

async function loadApp(modulePath: string, exportName: string | null, servicesDir: string | null): Promise<App> {
  const abs = resolve(modulePath)
  if (!existsSync(abs)) fatal(`No such module: ${rel(abs)}`)

  const mod = await quietly(() => import(`file://${abs}`)) as Record<string, unknown>

  if (exportName) {
    const picked = mod[exportName]
    if (picked === undefined) fatal(`${rel(abs)} has no export \`${exportName}\` — found: ${Object.keys(mod).join(', ') || '(none)'}`)
    return build(picked, exportName, servicesDir)
  }

  const apps      = Object.entries(mod).filter(([, v]) => isApp(v))
  const factories = Object.entries(mod).filter(([k, v]) => typeof v === 'function' && (k === 'default' || FACTORY.test(k)))

  const candidates = [...apps, ...factories]
  if (!candidates.length)
    fatal(
      `${rel(abs)} exports no app and no factory.\n` +
      `     Export the built app, or a function returning it (\`createApp\`, \`buildApp\`, \`default\`),\n` +
      `     and name it with --export if the module has more than one.`
    )
  if (candidates.length > 1)
    fatal(`${rel(abs)} exports more than one candidate — name one with --export: ${candidates.map(([k]) => k).join(', ')}`)

  return build(candidates[0][1], candidates[0][0], servicesDir)
}

async function build(value: unknown, label: string, servicesDir: string | null): Promise<App> {
  const app = typeof value === 'function'
    ? await quietly(() => Promise.resolve((value as () => App | Promise<App>)()))
    : value
  if (!isApp(app)) fatal(`\`${label}\` is not a Junction app (no .service()/.configure())`)

  // Autoload is a `needsHost` phase — its default directory is resolved against
  // `Bun.main`, which here is this tool, so the test lifecycle skips it and an
  // app whose services are all autoloaded describes as empty. Named explicitly
  // and run in the same position production runs it: before boot, so a plugin's
  // boot() sees every service.
  if (servicesDir) {
    const abs = resolve(servicesDir)
    if (!existsSync(abs)) fatal(`No services directory at ${rel(abs)}`)
    const { autoloadServices } = await import('../src/core/loader.ts')
    await quietly(() => autoloadServices({ dir: abs, app, registry: app.services }))
  }

  // Plugins boot, hooks compile, service routes mount — everything except the
  // phases needing a port. Without it there are no routes to read and no
  // plugin-registered services at all.
  await quietly(() => app._startForTest())
  return app
}

// ─── the surface ──────────────────────────────────────────────────────────────

export interface SurfaceService {
  name:          string
  model:         string
  methods:       string[]
  actions:       string[]
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
      actions:       d.actions,
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
  out.push('each service will serve, its actions, the hook chain in the order it runs, and')
  out.push('every path the router actually mounted. None of it is visible in the source —')
  out.push('an option key and an action look identical, `apiPrefix` moves every route, and')
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
  out.push('defines. An action is a non-CRUD method `collectActions` resolved at')
  out.push('construction; a name that stopped being one is a line that disappears here.')
  out.push('`model` is what the service reports for the result envelope, which is its own')
  out.push('name when it declares none.')
  out.push('')

  for (const svc of surface.services) {
    out.push(`### \`${svc.name}\`${svc.model ? ` · model \`${svc.model}\`` : ''}`)
    out.push('')
    out.push(`- **methods** — ${svc.methods.length ? svc.methods.map(m => `\`${m}\``).join(', ') : '(none)'}`)
    if (svc.actions.length)       out.push(`- **actions** — ${svc.actions.map(a => `\`${a}\``).join(', ')}`)
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

// ─── --check ──────────────────────────────────────────────────────────────────
//
// A byte compare, and the useful output is the lines that moved. Mirrors
// `litestone access --check` / `litestone ddl --check` deliberately: one CI
// phase reruns all three and has no idea which is which.

function checkSnapshot(outPath: string, body: string): never | void {
  if (!existsSync(outPath))
    fatal(`No snapshot at ${rel(outPath)} — run \`junction surface\` and commit it.`)

  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) {
    console.log(`  ✓  ${rel(outPath)} is current`)
    return
  }

  const was = committed.split('\n')
  const now = body.split('\n')
  const changed: string[] = []
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    if (was[i] === now[i]) continue
    changed.push(`    - ${was[i] ?? '(absent)'}`)
    changed.push(`    + ${now[i] ?? '(absent)'}`)
    if (changed.length >= 20) break
  }

  console.log(`  ✗  ${rel(outPath)} does not match the app\n`)
  console.log(changed.join('\n'))
  if (changed.length >= 20) console.log('    …')
  console.log()
  console.log('  The API surface changed. Run `junction surface` and review the diff before committing.')
  console.log()
  process.exit(1)
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
    checkSnapshot(outPath, body)
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
