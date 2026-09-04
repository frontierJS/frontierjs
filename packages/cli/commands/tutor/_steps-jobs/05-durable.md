---
title: 05-durable
description: The row that recorded it, in a file you can open
---

## The row

The job is finished, and there is still a record of it — in `db/jobs.db`, which
is an ordinary SQLite file:

```console
sqlite3 db/jobs.db 'select name, status, attempts from jobs'
```

That is the argument for a queue built this way. There is nothing to keep alive
beside the app, nothing to configure, and no separate place to go and look: the
state of every piece of deferred work the app has ever done is a table, on the
same disk, readable by anything.

Three columns worth knowing.

**`status`** — one of `pending`, `running`, `done`, `failed`, `cancelled`. A
job that finished is `done`, and it stays: terminal rows are swept after seven
days rather than immediately, so *what happened last night* is answerable in the
morning.

**`attempts`** — the job file said `maxAttempts: 3`, so a throw is not the end.
Retries wait on the ladder the file declares.

**`unique`** — absent here, and worth knowing why it is not an idempotency key.
It is a lock on work **in flight**: once a job is terminal the key is free
again. The idempotency key is the job's own **id** — `dispatch({ id })` writes
the primary key, so a second dispatch under the same id is a no-op for all time.
That is how a redelivery is made safe.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'jobNoteId'], { from: '04-job' })) return

const jobsDb = join(context.config.appDir, 'db', 'jobs.db')

if (!await must(context, probe.fileExists({ path: jobsDb, name: 'db/jobs.db — the queue is a file' }), {
  likely: 'the queue never opened its database, which means nothing was ever dispatched',
})) return

// The name is asserted along with the status. A row that succeeded under some
// OTHER name would mean the file-naming rule had not held, which is the one
// thing about this queue that fails silently.
if (!await must(context, probe.sqliteRow({
  db:     jobsDb,
  sql:    "select name, status, attempts from jobs where name = 'finish-note' order by rowid desc limit 1",
  expect: (rows) => rows[0]?.status === 'done',
  name:   'the job is recorded, by the name its file gave it',
}), {
  likely:    'the job ran under a different name — the file name and defineJob disagree',
  reproduce: `bun -e "const {Database}=require('bun:sqlite');console.log(new Database('${jobsDb}',{readonly:true}).query('select name,status,attempts from jobs').all())"`,
})) return

if (!await must(context, probe.sqliteRow({
  db:     jobsDb,
  sql:    "select attempts from jobs where name = 'finish-note' order by rowid desc limit 1",
  expect: (rows) => Number(rows[0]?.attempts) >= 1,
  name:   'and it says how many attempts it took',
}), {
  likely: 'the column moved — open the file and look',
})) return

log.info('')
log.info(`  ${jobsDb}`)
log.info('')
```
