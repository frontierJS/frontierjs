---
title: 05-serve
description: The gate a database cannot hold, and the row served over HTTP
---

## The half no database holds

The reading brought over everything a SQLite file contains. What it could not
bring is the thing `gaps.json` filed as a **note**: a database has no access
rules. There is no `@@gate` in it, no `@@allow`, no `@guarded` and no validator,
so the imported models arrive with nothing said about who may read or write
them — which is the one thing you have to add before serving any of it.

So this step says it, once, on each model:

```text
@@gate("0.4.4.6")     reads are public, writes need a signed-in caller
```

Then the models are appended to `db/schema.lite`, `DATABASE_URL` is pointed at
the database that already existed, and the API is started.

**Nothing migrates, and nothing needs to.** Adopting is not a schema change:
the tables are there, they were there before any of this, and the first thing
the app does to your database is read from it.

The assertion is the whole lesson: `GET /api/orders` answers the order that was
written in step 2, by raw SQL, before there was an app.

Then the step asks the other question, and the answer is a **refusal** worth
seeing. `litestone migrate baseline` is how you eventually tell the framework
*this database already holds what these migrations build* — and it checks
before it records, because one wrong baseline is a database that reports a
complete history and is missing a column. Here it refuses, and names exactly
what the reading did not get to the letter:

```text
~ customers  [rebuild]
    ~ col  id          notnull: false → true
    ~ col  created_at  default: "CURRENT_TIMESTAMP" → "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
```

Both are real. `INTEGER PRIMARY KEY` is nullable as declared and is the rowid
regardless, so that line is cosmetic; the second is not — `@default(now())`
writes ISO-8601 where this column has been writing SQLite's own format, so new
rows would not look like the old ones. Reading a database gets you a schema to
start from, and that gap is what the first hour of work after it is for.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'imported', 'legacyDb'], { from: '03-introspect' })) return

const app    = context.config.appDir
const schema = join(app, 'db', 'schema.lite')
const lite   = join(app, 'node_modules', '.bin', 'litestone')

// Written once and REPLACED on a re-run, keyed on the block's own marker.
// Asking whether the file already says `model Order` is a substring test over a
// whole schema: it answers yes to a re-run against a DIFFERENT database, and
// the step then adopts nothing while every assertion above it passes.
const MARK   = '// ─── Adopted by fli tutor:adopt'
const models = readFileSync(context.config.imported, 'utf8')
  .split('\n').filter(l => !l.startsWith('///')).join('\n')
  // The one thing a database could not say. Written per model rather than
  // once, because a gate is per model — that is the whole of what it means.
  .replace(/^\}/gm, '  @@gate("0.4.4.6")\n}')

const current = readFileSync(schema, 'utf8')
const head    = current.includes(MARK)
  ? current.slice(0, current.indexOf(MARK)).replace(/\s+$/, '\n')
  : current.replace(/\s+$/, '\n')

writeFileSync(schema, [
  head,
  MARK + ' ────────────────────────────────────────────',
  '//',
  '// Read out of an existing SQLite database with `litestone introspect`. The',
  '// @@map lines name the tables that are really there; the @@gate lines are the',
  '// half no database holds and were added by hand.',
  models,
  '',
].join('\n'), 'utf8')

// The app points at the database that already exists. `db:` is not used and must
// not be — it is an OVERRIDE resolved against the process, and the schema
// already declares env("DATABASE_URL").
const envFile = join(app, '.env')
const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
if (!envText.includes('DATABASE_URL='))
  appendFileSync(envFile, `\nDATABASE_URL=${context.config.legacyDb}\n`, 'utf8')

// A model is not a route. The services are generated around models that already
// exist, which is what --skip-schema means.
for (const model of ['Customer', 'Order']) {
  if (existsSync(join(app, 'api', 'src', 'services', `${model.toLowerCase()}s.service.ts`))) continue
  context.exec({ command: `${context.fli} scaffold ${model} --skip-schema`, cwd: app })
}

const api = await startServer(context, {
  name:   'api',
  script: 'start',
  cwd:    app,
  env:    { PORT: String(context.config.apiPort), DATABASE_URL: context.config.legacyDb },
  port:   context.config.apiPort,
  path:   '/api/health',
})

if (!await must(context, api.up, {
  likely:    'the API exited on startup — the last of its output is below',
  reproduce: `cd ${app} && DATABASE_URL=${context.config.legacyDb} bun run start`,
  detail:    serverLog(api),
})) return

// The lesson. A row nobody here wrote, over HTTP, through a schema read out of
// the database that held it.
if (!await must(context, probe.httpJson({
  url:      `http://127.0.0.1:${context.config.apiPort}/api/orders`,
  expect:   (j) => {
    const rows = Array.isArray(j) ? j : (j?.data ?? [])
    return rows.length === 1 && Number(rows[0].total_cents) === 4250
  },
  describe: 'the order written in step 2, by raw SQL',
  name:     'a row that predates the framework is served',
  retries:  4,
}), {
  likely:    'the schema names a table or a column the database does not have — which is what @@map and --no-camel are for',
  reproduce: `curl -s localhost:${context.config.apiPort}/api/orders`,
})) return

// The other question, and the answer is a refusal. `migrate create` writes the
// migration that WOULD build these tables — it diffs the schema against the
// applied set, which is empty, so it emits the lot — and `baseline` is asked to
// record it as already applied. It compares first, and here it declines.
// `env:` REPLACES the environment rather than adding to it, and litestone's bin
// is a `#!/usr/bin/env bun` shebang — so a bare `{ DATABASE_URL }` here loses
// PATH and the failure is `env: 'bun': No such file or directory`.
context.exec({
  command: `${lite} migrate create adopted`,
  cwd:     app,
  env:     { ...process.env, DATABASE_URL: context.config.legacyDb },
  stdio:   ['ignore', 'pipe', 'pipe'],
})

const refused = probe.command({
  bin:      lite,
  args:     ['migrate', 'baseline'],
  cwd:      app,
  env:      { DATABASE_URL: context.config.legacyDb },
  expect:   1,
  needle:   /rebuild/,
  describe: 'a refusal naming what differs',
  name:     'and a baseline is refused rather than recorded',
})

if (!await must(context, refused, {
  likely:    'the reading matched the database to the letter, which is better — this assertion is the one to update',
  reproduce: `cd ${app} && DATABASE_URL=${context.config.legacyDb} bunx litestone migrate baseline`,
})) return

for (const line of (refused.detail ?? '').split('\n').filter(l => /~ col|\[rebuild\]/.test(l)))
  log.info(`  ${line.trim()}`)

log.info('')
log.info(`  ${context.config.legacyDb}`)
log.info('  read by an app that did not create it, one row, over HTTP')
log.info('')

remember(context, '05-serve', { served: true })
```
