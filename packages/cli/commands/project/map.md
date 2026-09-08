---
title: project:map
description: What this project IS — its schema, services, resources and migrations, plus the three registers only a built app can answer
alias: pmap
examples:
  - fli project:map
  - fli project:map --as=serve
  - fli project:map --as=json
  - fli project:map --out project-map.json
  - fli project:map --layer schema
  - fli project:map --no-atlas
  - fli project:map --project packages/basecamp
flags:
  as:
    char: a
    type: string
    description: "Which presentation — report (the terminal, default), serve (FJSChain in a browser; it does not exit, Ctrl+C to stop), or json (the model)"
    defaultValue: report
  layer:
    type: string
    description: "Collect one layer only: schema | api | ui | migrations"
    defaultValue: ''
  atlas:
    type: boolean
    description: Boot the app once to add jobs, notifications and the principal realm (--no-atlas to read files only)
    defaultValue: true
  out:
    type: string
    description: Write the model as JSON to this path — a destination, not a presentation
    defaultValue: ''
  port:
    char: p
    type: number
    description: Port to serve on, with --as=serve
    defaultValue: 8501
  open:
    type: boolean
    description: Open the browser once the server is up, with --as=serve (--no-open to skip)
    defaultValue: true
---

One reader of the project, presented three ways. `--as` picks the presentation
and nothing else: the terminal report, FJSChain in a browser, or the model
itself.

`project:view` was the second command over this same reading, and the two
disagreed — 54 models against 42 over one tree, because one counted definitions
by shape and the fix landed in the other (`FJS-1016`). They collected different
fields too, so *what does this project contain* had two answers depending on
which you asked. That is `FJS-D223` one scope down, and it is applied here
rather than re-argued: **one axis, so one flag**, and `--as` absorbs `--json`.

`--layer` narrows what is COLLECTED, so a narrowed run is cheaper and its JSON
says only what it looked at. `--out` is a destination rather than a presentation
and sits on its own axis.

**`--as=serve` does not exit** — it is a server, where every other value here
answers and stops.

**Reading a project needs no running server.** `--atlas` boots the app once for
the three registers no file can answer; it degrades rather than fails, so a
missing bun costs three sections and nothing else.

```js
const as    = (flag.as || 'report').toLowerCase()
const layer = (flag.layer || '').toLowerCase()

if (!['report', 'serve', 'json'].includes(as)) {
  log.error(`--as=${as} is not a presentation — report, serve or json`)
  return
}

if (!existsSync(resolve(context.paths.db, 'schema.lite'))) {
  log.error(`no db/schema.lite under ${context.paths.root} — cd into a FJS app, or point at one with --project <dir>`)
  return
}

// ── the one reading ───────────────────────────────────────────────────────────
//
// `buildProjectMap` is in `_module.md` because it had two copies that answered
// differently. Progress notes are suppressed for json and for --out: stdout is
// the document there, and `fli project:map --json | jq` was broken for the life
// of the flag by one `Reading schema...` line above the object.

const quiet = as === 'json' || !!flag.out
const { map, error } = await buildProjectMap(context, {
  layer,
  atlas: flag.atlas,
  log:   quiet ? null : log,
})
if (error) { log.error(error); return }

if (flag.out) {
  const outPath = resolve(context.paths.root, flag.out)
  writeFileSync(outPath, JSON.stringify(map, null, 2))
  log.success(`Written to ${flag.out}`)
  return
}

if (as === 'json') {
  echo(JSON.stringify(map, null, 2))
  return
}

if (as === 'serve') {
  await serveProjectMap(context, map, { port: flag.port, open: flag.open })
  return
}

// ── report ────────────────────────────────────────────────────────────────────

const schema     = map.schema ?? null
const services   = map.services ?? []
const resources  = map.resources ?? []
const migrations = map.migrations ?? []
const surface    = map.surface ?? null
const packages   = map.packages ?? []

if (!quiet) {
  const installed = packages.filter(p => p.installed).map(p => p.short)
  const missing   = packages.filter(p => !p.installed).map(p => p.short)
  if (installed.length) log.info(`Plugins: ${installed.join(', ')}`)
  if (missing.length)   log.info(`Not detected: ${missing.join(', ')}`)
  if (services.length)  log.info(`API:  ${services.length} service${services.length !== 1 ? 's' : ''} on the committed surface`)
  if (!layer || layer === 'ui')         log.info(`UI:   ${resources.length} resource${resources.length !== 1 ? 's' : ''} found`)
  if (!layer || layer === 'migrations') log.info(`DB:   ${migrations.length} migration file${migrations.length !== 1 ? 's' : ''} found`)
}

echo('')

if (schema) {
  const defs   = schema.$defs || {}
  // The kind a definition STATES. Filtering by shape counted `type` blocks and
  // the view among the models — 54 against the page's 42 over one tree
  // (`FJS-1016`).
  const models = Object.entries(defs).filter(([, d]) => d['x-litestone-kind'] === 'model')
  const views  = Object.entries(defs).filter(([, d]) => d['x-litestone-kind'] === 'view')
  const types  = Object.entries(defs).filter(([, d]) => d['x-litestone-kind'] === 'type')
  const enums  = Object.entries(defs).filter(([, d]) => d.type === 'string' && d.enum)

  const counts = [
    `${models.length} model${models.length !== 1 ? 's' : ''}`,
    views.length ? `${views.length} view${views.length !== 1 ? 's' : ''}` : '',
    types.length ? `${types.length} type${types.length !== 1 ? 's' : ''}` : '',
    `${enums.length} enum${enums.length !== 1 ? 's' : ''}`,
  ].filter(Boolean).join('  ·  ')
  echo(`  ${chalk.bold.cyan('Schema')}  ·  ${counts}`)
  echo('')

  for (const [name, def] of [...models, ...views]) {
    const gate  = def['x-gate']
    const rels  = def['x-relations'] ?? []
    const fCnt  = Object.keys(def.properties ?? {}).length

    const kindStr = def['x-litestone-kind'] === 'view' ? chalk.dim('  view') : ''
    const gateStr = gate
      ? chalk.dim(`  @@gate(${gate.read}.${gate.create}.${gate.update}.${gate.delete})`)
      : ''
    const relStr  = rels.length
      ? chalk.dim(`  → ${rels.map(r => r.model).join(', ')}`)
      : ''

    echo(`    ${chalk.yellow(name.padEnd(22))} ${chalk.dim(String(fCnt).padStart(2) + ' fields')}${kindStr}${gateStr}${relStr}`)
  }

  if (types.length) {
    echo('')
    for (const [name, def] of types) {
      echo(`    ${chalk.dim('type')} ${chalk.yellow(name)}  ${chalk.dim(Object.keys(def.properties ?? {}).join(', '))}`)
    }
  }

  if (enums.length) {
    echo('')
    for (const [name, def] of enums) {
      echo(`    ${chalk.dim('enum')} ${chalk.yellow(name)}  ${chalk.dim(def.enum.join(' | '))}`)
    }
  }

  echo('')
}

if (services.length) {
  echo(`  ${chalk.bold.blue('Services')}  ·  ${services.length} registered  ${chalk.dim(`· ${basename(surface.file)}`)}`)
  echo('')

  for (const svc of services) {
    const before  = [...new Set(Object.values(svc.hooks.before).flat())]
    const after   = [...new Set(Object.values(svc.hooks.after).flat())]
    const custom  = svc.customMethods.length
      ? chalk.dim(`  +${svc.customMethods.join(', ')}`)
      : ''

    const hookParts = [
      before.length ? chalk.dim(`before:[${before.join(', ')}]`) : '',
      after.length  ? chalk.dim(`after:[${after.join(', ')}]`)   : '',
    ].filter(Boolean).join('  ')

    // Coverage rather than a defect — an API-only service is correctly bound by
    // nothing — so it is a column and not a warning (`FJS-1017`).
    const bound = resources.filter(r => r.service === svc.name).map(r => r.name)
    const resStr = bound.length ? chalk.dim(`  ⟨${bound.join(', ')}⟩`) : ''

    echo(`    ${chalk.blue(svc.name.padEnd(22))} ${chalk.dim('→ ' + svc.model.padEnd(20))} ${hookParts}${custom}${resStr}`)
  }

  // Around EVERY call, machine-facing endpoints included — so a chain here is
  // the one thing a per-service line cannot show.
  const appChains = Object.entries(surface.appHooks)
    .flatMap(([phase, byMethod]) => Object.entries(byMethod)
      .map(([method, fns]) => `${phase}:${method} [${fns.join(', ')}]`))
  if (appChains.length) {
    echo('')
    echo(`    ${chalk.dim('app hooks   ' + appChains.join('  '))}`)
  }
  if (surface.routes.length) {
    const raw = surface.routes.filter(r => r.kind === 'raw').length
    echo(`    ${chalk.dim(`routes      ${surface.routes.length} mounted, ${raw} raw — below the pipeline`)}`)
  }
  if (surface.plugins.length) {
    echo(`    ${chalk.dim('plugins     ' + surface.plugins.join(' → '))}`)
  }

  echo('')
}

if (resources.length) {
  echo(`  ${chalk.bold.hex('#c26a1a')('Resources')}  ·  ${resources.length} registered`)
  echo('')

  for (const res of resources) {
    const svcStr   = res.service ? chalk.dim(` → ${res.service}`) : chalk.red(' → (no service)')
    const hookStr  = res.hooks.length ? chalk.dim(`  [${res.hooks.join(', ')}]`) : ''
    echo(`    ${chalk.hex('#f08030')(res.name.padEnd(22))}${svcStr}${hookStr}`)
  }

  echo('')
}

// The three no file can answer. Rendered here rather than only on the page,
// because a field the model carries and one presentation drops is the shape
// this merge exists to remove (`FJS-927`).
const atlas = map.atlas ?? {}
if (atlas.jobs || atlas.notifications || atlas.principal) {
  echo(`  ${chalk.bold.green('Unattended')}  ${chalk.dim('· read off a built app')}`)
  echo('')
  const j = atlas.jobs ?? {}
  if (!j.hasQueue) echo(chalk.dim('    no queue installed — nothing here is durable'))
  else for (const job of (j.durable ?? [])) {
    echo(`    ${chalk.green(job.name.padEnd(22))} ${chalk.dim(job.cron ? job.cron : 'on dispatch')}`)
  }
  for (const t of (j.timers ?? [])) echo(`    ${chalk.dim(`timer ${t.id}  ${t.type}  ${t.expr}`)}`)

  const n = atlas.notifications ?? {}
  if (n.declared?.length) {
    echo('')
    echo(`    ${chalk.dim('notifications  ' + n.declared.map(d => d.type).join(', '))}`)
  }
  const p = atlas.principal
  if (p) {
    const t = p.tenancy ?? {}
    if (t.strategy) echo(`    ${chalk.dim(`tenancy        ${t.strategy}${t.resolve ? `, by ${t.resolve}` : ''}`)}`)
    if (p.resolver?.name) echo(`    ${chalk.dim(`resolver       ${p.resolver.name}`)}`)
  }
  echo('')
} else if (atlas.error) {
  log.warn(`Unattended work, notifications and the principal realm are unread: ${atlas.error.split('\n')[0]}`)
} 

if (migrations.length) {
  echo(`  ${chalk.bold.magenta('Migrations')}  ·  ${migrations.length} file${migrations.length !== 1 ? 's' : ''}`)
  echo('')

  for (const m of migrations) {
    const lineCount = m.sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('--')).length
    echo(`    ${chalk.dim(m.name)}  ${chalk.dim(lineCount + ' statements')}`)
  }

  echo('')
}

const missingSecrets = (map.env?.vars ?? []).filter(v => v.required && v.status === 'missing')
if (missingSecrets.length) {
  log.warn(`${missingSecrets.length} required secret(s) not set: ${missingSecrets.map(v => v.key).join(', ')}`)
}

log.success('Map complete')
```
