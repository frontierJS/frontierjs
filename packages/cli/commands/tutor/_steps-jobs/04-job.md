---
title: 04-job
description: A job file, a dispatch from a hook, and a response that does not wait
---

## The job

Two more files' worth of change, and neither of them is `app.ts`.

**The job is a file, and the file names it.** `api/src/jobs/finish-note.job.ts`
is the job `finish-note`; a `defineJob` naming anything else is refused when it
loads, rather than registered — a handler answering to `finsh-note` while every
dispatch says `finish-note` is a job that silently never runs, which is the
worst way a queue can break. Everything about the job lives in that file: which
queue it runs on, how many attempts it gets, how long it waits between them,
and — with `cron` — when it runs on its own.

**The dispatch is one line in the service**, in an `after` hook on `create`:

```text
hooks: {
  after: {
    create: [async (ctx) => {
      const row = resultData(ctx.result)
      await ctx.app.jobs.dispatch(finishNote, { id: row.id })
    }],
  },
}
```

`resultData`, not `ctx.result`. Inside the pipeline the result is still the
**envelope** — `{ kind: 'single', object: 'notes', data }` — and only the
transport unwraps it. Reading `.id` off it is `undefined` with no error
anywhere: the hook runs, the row is written, the job is queued with an empty
payload, and the work silently never happens to anything. Junction exports the
unwrapper for exactly this.

The handler reaches back through `ctx.app.service('notes')` rather than writing
to the database directly — so the write it makes is announced, validated and
audited exactly like anybody else's, and a screen watching the notes channel
sees it move.

What is asserted is the **order**. The response is read first, and the note is
still unfinished in it; only afterwards does the row change. That is the whole
claim of a queue, and a test that only checked the final state would pass with
the work done synchronously in the request — which is the thing you were trying
not to do.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app     = context.config.appDir
const jobsDir = join(app, 'api', 'src', 'jobs')
const service = join(app, 'api', 'src', 'services', 'notes.service.ts')

mkdirSync(jobsDir, { recursive: true })
writeFileSync(join(jobsDir, 'finish-note.job.ts'), [
  '// api/src/jobs/finish-note.job.ts',
  '//',
  '// The file names the job: finish-note. A defineJob that disagrees is refused',
  '// when it loads rather than registered.',
  '//',
  '// The default export is also the dispatch handle — import it and the name is',
  '// stated nowhere else, so a rename cannot leave a dispatch behind.',
  '',
  "import { defineJob } from '@frontierjs/caravan'",
  '',
  "export default defineJob<{ id: string }>('finish-note', async (ctx) => {",
  '  // ctx.app is the running app. Going back through the service means this',
  '  // write is validated, announced and audited like any other — a job that',
  '  // reaches for the database directly is a write nothing can see.',
  "  await ctx.app.service('notes').patch(ctx.data.id, { done: true })",
  '}, {',
  '  maxAttempts: 3,',
  '  retryDelay:  [1_000, 5_000],',
  '})',
  '',
].join('\n'), 'utf8')

let src = readFileSync(service, 'utf8')

if (!src.includes('finish-note')) {
  const ANCHOR = "    channel: 'notes',"
  if (!src.includes(ANCHOR)) {
    await must(context, {
      ok:    false,
      name:  'the notes service has the place this step edits',
      asked: "the scaffold's own notes.service.ts",
      got:   'a file that has been changed under the lesson',
    }, {
      likely:    'add the hook by hand — the prose above is the whole of it',
      reproduce: `grep -n channel ${service}`,
    })
    return
  }

  src = src.replace(
    "import { createBaseService } from '@frontierjs/junction'",
    "import { createBaseService, resultData } from '@frontierjs/junction'\nimport finishNote from '../jobs/finish-note.job.ts'",
  )

  src = src.replace(ANCHOR, [
    ANCHOR,
    '',
    '    // Queue the work, do not do it — the response goes back before the job',
    '    // runs.',
    '    //',
    '    // resultData, not ctx.result: inside the pipeline the result is still',
    '    // the envelope, and reading .id off it is undefined with no error.',
    '    hooks: {',
    '      after: {',
    '        create: [async (ctx) => {',
    '          const row = resultData(ctx.result) as { id?: string } | undefined',
    '          if (!row?.id) return',
    '          await ctx.app.jobs.dispatch(finishNote, { id: row.id })',
    '        }],',
    '      },',
    '    },',
  ].join('\n'))

  writeFileSync(service, src, 'utf8')
}

if (!await must(context, probe.fileContains({
  path:   service,
  needle: 'jobs.dispatch(finishNote',
  name:   'creating a note queues the job',
}), { likely: 'the edit missed its anchor' })) return

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${app} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

const registered = await registerAccount(context, {
  email:    `jobs-${Date.now().toString(36)}@example.test`,
  password: 'correct-horse-battery-staple',
  name:     'Ada',
})
if (!await must(context, registered, { likely: 'auth is not installed in this app' })) return
context.config.userToken = registered.json.token

const title = `queued-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) return

// The order is the assertion. Read from the RESPONSE, not from a second
// request: a re-read races the job and would make this flaky in the direction
// that hides the bug.
if (!await must(context, {
  ok:    made.json.done === false,
  name:  'the response came back before the work was done',
  asked: 'done: false in the created row',
  got:   `done: ${JSON.stringify(made.json.done)}`,
}, {
  likely: 'the hook is awaiting the work instead of queueing it',
})) return

const db = join(app, 'db', 'app.db')

// `eventually`, because the row is written by a SEPARATE process and the wait
// is a property of this question rather than of the probe.
if (!await must(context, probe.eventually(() => probe.sqliteRow({
  db,
  sql:    'select done from note where id = ?',
  params: [String(made.json.id)],
  expect: (rows) => Number(rows[0]?.done) === 1,
  name:   'and then the job finished it',
}), { retries: 16, everyMs: 500 }), {
  likely:    'the job never ran — jobsDir may not be loading, which is silent',
  reproduce: `cd ${app} && bun -e "console.log(await Bun.file('db/jobs.db').exists())"`,
  detail:    serverLog(api),
})) return

remember(context, '04-job', { jobNoteId: made.json.id, jobNoteTitle: title })
```
