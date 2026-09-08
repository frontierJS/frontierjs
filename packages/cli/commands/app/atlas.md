---
title: app:atlas
description: Everything this app answers, in one reading — what it can do, how each of those is reached, and what graded it
examples:
  - fli app:atlas
  - fli app:atlas --as=json
  - fli app:atlas --ungraded
flags:
  as:
    char: a
    type: string
    description: Which presentation — report (one page read top to bottom) or json (the model itself)
    defaultValue: report
  ungraded:
    char: u
    type: boolean
    description: Only the operations no service pipeline graded — the raw routes
    defaultValue: false
---

Four committed registers answer four questions about a built app, and answering
the fifth — *what can this app do, how is each of those reached, and what graded
it* — means opening all four and joining them by hand. A service method and the
job that calls it are one operation reached two ways, and no artefact says so.

This is a **rendering, not a reader**. `junction atlas` boots the app once, walks
it once through `describeAppModel`, and prints the model; nothing here re-derives
a fact those four registers already own, and nothing is committed — a fifth file
derived from four gated ones would be a second origin.

The entry module is not probed. It comes out of the committed
`surface.snapshot.md`'s own header, which names the generator and the flags it
ran with — the same line the `snapshots` CI phase reruns, from the same
directory. So an app that boots from its root, or names an `--export`, is read
correctly rather than guessed at.

**Needs bun.** Junction is Bun-only and this shells out to it; `fli` itself runs
under node.

```js
const { readAppAtlas } =
  await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))

// ─── one boot, one walk ───────────────────────────────────────────────────────
//
// `core/app-entry.js` owns finding the app and spawning `junction atlas`,
// because `project:map` folds the same model into its page and two spawns of
// one command is how the two come to disagree about which app they described.

const { model, entry, error } = readAppAtlas(context.paths.root)
if (error) {
  log.error(error)
  return
}

if (flag.as === 'json') {
  echo(JSON.stringify(model, null, 2))
  return
}

// ─── the report ───────────────────────────────────────────────────────────────

const { surface, principal, jobs, notifications } = model

// There is deliberately NO per-service *what graded it* column. `gateAuth` is a
// DERIVED around hook that `createBaseService` installs unconditionally, so the
// column could only ever say the same word — a check that can only pass is not a
// check. Where the question has an answer that varies is the raw routes, which
// run below the pipeline entirely, and that is the section it is asked in.
const rawRoutes = surface.routes.filter(r => r.kind === 'raw')

const rule = (label) => {
  echo('')
  echo(`  ── ${label} ${'─'.repeat(Math.max(2, 64 - label.length))}`)
  echo('')
}

const pad = (rows, i) => Math.max(...rows.map(r => String(r[i] ?? '').length))

if (flag.ungraded) {
  rule('Reached over HTTP, graded by no service pipeline')
  if (!rawRoutes.length) {
    echo('  None — every mounted route goes through a service.')
    return
  }
  const mw = Math.max(...rawRoutes.map(r => r.method.length))
  for (const r of rawRoutes) echo(`  ${r.method.padEnd(mw)}  ${r.path}`)
  echo('')
  log.info(`${rawRoutes.length} raw route(s). A raw route runs BELOW the pipeline — ` +
           'no gateAuth, no autoValidate, no envelope. Each one grades its own caller or nothing does.')
  return
}

echo('')
echo(`  App atlas — ${context.paths.root}`)
echo(`  read off ${entry.args.join(' ')} under ${entry.dir}`)

// ── reached by a caller ──
rule('Reached by a caller')

const svcRows = surface.services.map(s => [
  s.name,
  s.model ?? '—',
  (s.methods ?? []).join(', ') || '—',
])
const w0 = pad(svcRows, 0), w1 = pad(svcRows, 1)
for (const [name, model_, methods] of svcRows) {
  echo(`  ${name.padEnd(w0)}  ${model_.padEnd(w1)}  ${methods}`)
}
echo('')
log.info(`${surface.services.length} service(s) · ${surface.routes.length} mounted route(s) ` +
         `(${rawRoutes.length} raw, ${surface.routes.length - rawRoutes.length} auto-mounted) · ` +
         `${surface.plugins.length} plugin(s)`)

// ── reached by a clock ──
rule('Reached by a clock, or by a dispatch with no caller')

if (!jobs.hasQueue) {
  echo('  No queue is installed — nothing here is durable.')
} else if (!jobs.durable.length) {
  echo('  A queue is installed and no handlers are registered.')
} else {
  const jr = jobs.durable.map(j => [j.name, j.cron ? j.cron : 'on dispatch', j.timeout == null ? 'no timeout' : `${j.timeout}ms`])
  const jw = pad(jr, 0), jw1 = pad(jr, 1)
  for (const [n, sched, t] of jr) echo(`  ${n.padEnd(jw)}  ${sched.padEnd(jw1)}  ${t}`)
  echo('')
  const onClock = jobs.durable.filter(j => j.cron).length
  log.info(`${jobs.durable.length} durable handler(s), ${onClock} on a clock · ${jobs.timers.length} in-process timer(s)`)
}

// ── what it can tell somebody ──
rule('What it can tell somebody')

if (!notifications.installed) {
  echo('  No notifications plugin is configured.')
} else if (!notifications.declared.length) {
  echo('  Configured, and no notifications are registered — every send throws.')
} else {
  const nw = Math.max(...notifications.declared.map(n => n.type.length))
  for (const n of notifications.declared) {
    echo(`  ${n.type.padEnd(nw)}  ${(n.transports ?? []).join(' · ') || 'no transport'}`)
  }
}

// ── what graded it ──
rule('What graded it')

if (!principal) {
  echo('  This app declares no tenancy and installs no principal resolver.')
} else {
  const t = principal.tenancy
  if (t?.strategy) echo(`  tenancy   ${t.strategy}${t.resolve ? `, resolved by ${t.resolve}` : ''}`)
  const r = principal.resolver
  if (r?.name) {
    const d = r.described ?? {}
    const bits = [d.kind, d.claims?.length ? `claims ${d.claims.join(', ')}` : null, d.namedBy].filter(Boolean)
    echo(`  resolver  ${r.name}${bits.length ? ` — ${bits.join(', ')}` : ''}`)
  }
}

echo('')
log.info(`${rawRoutes.length} operation(s) are reached over HTTP and graded by no service pipeline — ` +
         '`fli app:atlas --ungraded` lists them')

// What is NOT here, stated rather than left to be discovered: which SERVICE a
// job calls. A job that calls `app.service('orders').call('cancel', …)` and one
// that writes the database directly are the same row above, and the difference
// is the whole of whether the gate and the row policies applied. It is not in
// the model because it is not in the built app — it is in the job's source, and
// reading source is the scan this view exists instead of (`FJS-254`).
echo('')
log.info('Which service a job calls is not answerable here — that is in the job\'s source, ' +
         'not in the built app, and reading source is the scan this view exists instead of. ' +
         'A job calling a service gets the same gate, policies and envelope every other caller ' +
         'gets; one writing the database directly does not, and both are the same row above.')
```
