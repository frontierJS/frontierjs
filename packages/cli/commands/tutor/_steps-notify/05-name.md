---
title: 05-name
description: Renaming the file renames the type, and the rows already written keep the old one
---

## The name is data

`type` is a **column**. Every notification already sent carries the name it had
when it was sent, and a browser reads that column to choose which renderer draws
it. So renaming the file is not a refactor — it is a data change, applied to
everything written from that moment on and to nothing written before.

This step does it and looks:

```console
mv api/src/notifications/NoteAdded.notification.ts \
   api/src/notifications/NoteCreated.notification.ts
```

Nothing warns. The next send writes `NoteCreated`, yesterday's rows still say
`NoteAdded`, and any screen that switches on the type now has two names for one
thing — one of which it has never heard of.

Then the fix, which is one line in the file:

```text
export default defineNotification<Note>({
  type: 'NoteAdded',   // rows were written under this; the file moved on
  ...
```

Now the loader says something, and what it says is the useful sentence rather
than a rule being enforced:

```text
[notifications] NoteCreated.notification.ts states type "NoteAdded", which is
not its file name "NoteCreated". The stated type wins — rename the file to
match unless the rows were written under the stated one.
```

It cannot tell a deliberate rename from a typo, so it reports rather than
refuses. **A stated `type:` wins** — which is the whole reason to state one.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'notifDir'], { from: '04-send' })) return

// A session minted on another day is expired, and it arrives as a 401 the step
// then blames on the thing it is teaching. Only for a standalone step: a full
// run has just registered, and login is rate-limited.
if (context.flag.step && context.config.userEmail) {
  const again = await signIn(context, context.config.userEmail, 'correct-horse-battery-staple')
  if (again.ok) context.config.userToken = again.json.token
}

const app     = context.config.appDir
const dir     = context.config.notifDir
const service = join(app, 'api', 'src', 'services', 'notes.service.ts')
const db      = join(app, 'db', 'app.db')
const before  = join(dir, 'NoteAdded.notification.ts')
const after   = join(dir, 'NoteCreated.notification.ts')

// ─── the rename, with nothing stated ──────────────────────────────────────
if (existsSync(before)) {
  writeFileSync(after, readFileSync(before, 'utf8'), 'utf8')
  rmSync(before)
  writeFileSync(service, readFileSync(service, 'utf8')
    .replace('../notifications/NoteAdded.notification.ts', '../notifications/NoteCreated.notification.ts'), 'utf8')
}

let api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back — the last of its output is below',
  detail: serverLog(api),
})) return

if (!await must(context, await createNote(context, `renamed-${Date.now().toString(36)}`), {
  likely: 'the write was refused — the body is above',
  detail: serverLog(api),
})) return

// Two facts in one query, and neither is interesting alone: the newest row
// carries the NEW name and the older rows still carry the old one. A count of
// distinct types is the shape that can see both at once.
if (!await must(context, probe.eventually(() => probe.sqliteRow({
  db,
  sql:    "select type, count(*) as n from notification group by type order by type",
  expect: (rows) => rows.some(r => r.type === 'NoteAdded')
                 && rows.some(r => r.type === 'NoteCreated'),
  name:   'the rename orphaned the rows already written, silently',
}), { retries: 10, everyMs: 300 }), {
  likely:    'the rename did not take — the service may still import the old path',
  detail:    serverLog(api),
  reproduce: `grep -n notification ${service}`,
})) return

// ─── holding the name still ───────────────────────────────────────────────
let src = readFileSync(after, 'utf8')
// Matched as a STATEMENT and not as a substring: the file's own header says
// "the file names the type: NoteAdded", so `includes('type:')` reads as already
// done and this step then edits nothing, silently, and blames the loader two
// assertions later.
if (!/^\s*type:\s*'/m.test(src)) {
  src = src.replace('export default defineNotification<Note>({', [
    'export default defineNotification<Note>({',
    "  // Rows were written under this name; the file moved on. The stated type",
    '  // wins, and the loader reports the divergence rather than refusing it —',
    '  // a deliberate rename and a typo look identical from where it stands.',
    "  type: 'NoteAdded',",
  ].join('\n'))
  writeFileSync(after, src, 'utf8')
}

api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back — the last of its output is below',
  detail: serverLog(api),
})) return

if (!await must(context, await createNote(context, `held-${Date.now().toString(36)}`), {
  likely: 'the write was refused — the body is above',
  detail: serverLog(api),
})) return

if (!await must(context, probe.eventually(() => probe.sqliteRow({
  db,
  sql:    'select type from notification order by id desc limit 1',
  expect: (rows) => rows[0]?.type === 'NoteAdded',
  name:   'a stated type: brings the name back, for rows written from now on',
}), { retries: 10, everyMs: 300 }), {
  likely: 'the stated type is not being read — check the file parsed',
  detail: serverLog(api),
})) return

// The loader's own sentence, read off the running app's output. The assertion
// is that it SAYS something: a rename that is silent in both directions is the
// failure this step exists to show.
if (!await must(context, {
  ok:    /states type "NoteAdded", which is\s+not its file name/.test(serverLog(api, 200)),
  name:  'and the loader reported the divergence rather than accepting it in silence',
  asked: 'a line naming both the stated type and the file name',
  got:   'nothing said about it',
}, {
  likely: 'the loader did not run — notifications may be loading from another directory',
  detail: serverLog(api),
})) return

remember(context, '05-name', { notifFile: after })
```
