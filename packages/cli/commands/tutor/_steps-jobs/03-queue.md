---
title: 03-queue
description: Two lines in app.ts, and the app has a queue
---

## Wiring it

A queue is a plugin, and it is configured the way every other one is:

```text
import { createCaravan } from '@frontierjs/caravan'

app.configure(createCaravan({ jobsDir: join(import.meta.dir, 'jobs') }))
```

`app.jobs` exists from here on, and job statistics are added to `/metrics`
without anything asking for them.

Two details worth having now rather than the first time they bite. **The
directory is absolute**, derived from this file rather than written as `./jobs`:
a relative path resolves against the process's working directory, so an app
started from anywhere but its own root loads no jobs at all and every dispatch
is a job that silently never runs. And **the database opens on first use**, at
`db/jobs.db`, so nothing is spent by an app that never queues anything.

The queue is its own SQLite file rather than a table in the app's database. That
is what makes a job survive a crash of the thing that queued it.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

const appTs = join(context.config.appDir, 'api', 'src', 'app.ts')
let   src   = readFileSync(appTs, 'utf8')

if (!src.includes('createCaravan')) {
  // Matched rather than compared: the scaffold configures the channels plugin
  // with a connection handler, and an app that has narrowed that down to a bare
  // `channels()` is still the same anchor. A literal would report either shape
  // as *a file that has been changed under the lesson*.
  const CONFIGURE = (src.match(/app\.configure\(channels\(\([\s\S]*?\n\}\)\)/)
                  ?? src.match(/app\.configure\(channels\(\)\)/))?.[0]
  const imports   = [...src.matchAll(/^import .*$/gm)]

  if (!CONFIGURE || imports.length === 0) {
    await must(context, {
      ok:    false,
      name:  'api/src/app.ts has the place this step edits',
      asked: "the scaffold's own app.ts",
      got:   'a file that has been changed under the lesson',
    }, {
      likely:    'add the two lines by hand — the prose above is the whole of them',
      reproduce: `grep -n 'app.configure' ${appTs}`,
    })
    return
  }

  const last = imports[imports.length - 1]
  src = src.slice(0, last.index + last[0].length)
    + "\nimport { join }             from 'node:path'"
    + "\nimport { createCaravan }    from '@frontierjs/caravan'"
    + src.slice(last.index + last[0].length)

  src = src.replace(CONFIGURE, [
    CONFIGURE,
    '',
    '// ─── Background work ──────────────────────────────────────────────────────',
    '// app.jobs from here on. jobsDir is ABSOLUTE: a relative path resolves',
    '// against the working directory, so an app started from anywhere but its',
    '// own root loads no jobs and every dispatch silently never runs.',
    "app.configure(createCaravan({ jobsDir: join(import.meta.dir, 'jobs') }))",
  ].join('\n'))

  writeFileSync(appTs, src, 'utf8')
}

if (!await must(context, probe.fileContains({
  path:   appTs,
  needle: 'createCaravan(',
  name:   'app.ts configures the queue',
}), { likely: 'the edit missed its anchor' })) return

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

// Asked of the running app rather than of the file: the edit above proves the
// text is there and this proves the plugin registered, which is the half a
// missing dependency or a bad import would fail at.
if (!await must(context, probe.httpJson({
  url:      apiUrl(context, '/manifest'),
  expect:   (j) => Array.isArray(j.plugins) && j.plugins.some(p => String(p).includes('caravan')),
  describe: 'caravan among the running app plugins',
  name:     'the app really has a queue',
}), {
  likely:    'the plugin threw on register — the last of the API output is below',
  detail:    serverLog(api),
  reproduce: `curl -s http://127.0.0.1:${context.config.apiPort}/api/manifest`,
})) return
```
