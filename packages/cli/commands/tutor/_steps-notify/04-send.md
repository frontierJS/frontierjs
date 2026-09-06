---
title: 04-send
description: One notification, one send, two transports
---

## The notification

A notification is a file under `api/src/notifications/`, and **the file names
it**. `NoteAdded.notification.ts` is `NoteAdded` — the same rule `<name>.job.ts`
follows, and for the same reason: a name written in two places is a name that
can disagree with itself.

```text
export default defineNotification<Note>({
  via: () => ['inApp', 'email'],

  inApp: (note) => inApp()
    .title('Note added')
    .body(`"${note.title}" is on your list.`)
    .action('Open it', `/notes/${note.id}`)
    .context('Note', Number(note.id)),

  email: (note, recipient) => mail()
    .subject('Note added')
    .greeting(`Hi ${recipient.name ?? 'there'}`)
    .line(`"${note.title}" is on your list.`),
})
```

`via` decides which transports THIS payload and THIS recipient get, and it takes
both rather than closing over them — which is what lets the app be asked what it
can send without sending anything, in step 7.

Sending is one line, in an `after` hook on create:

```text
await ctx.app.notify(
  { id: who.userId, email: who.email, name: who.name },
  noteAdded(row),
)
```

**`resultData`, not `ctx.result`.** Inside the pipeline the result is still the
envelope — `{ kind: 'single', object: 'notes', data }` — and reading `.title` off
it is `undefined` with no error anywhere: the note is written, the notification
goes out, and it is about nothing.

The recipient is a `Recipient` and not a `User`: `{ id, email, name }`. That is
deliberate — `id` is optional, so a shop customer with no account can still be
emailed, and only the transports that can address them are offered.

What is asserted is that **one call reached two transports** — a row in the
database and a line in the outbox — and that the row's `type` is `NoteAdded`,
which appears nowhere in the file that produced it.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app     = context.config.appDir
const dir     = join(app, 'api', 'src', 'notifications')
const service = join(app, 'api', 'src', 'services', 'notes.service.ts')
const outbox  = context.config.outbox ?? join(app, 'db', 'outbox.jsonl')

context.config.outbox   = outbox
context.config.notifDir = dir

mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'NoteAdded.notification.ts'), [
  '// api/src/notifications/NoteAdded.notification.ts',
  '//',
  '// The file names the type: NoteAdded. Nothing below states it, and the row',
  '// this writes carries it.',
  '',
  "import { defineNotification, inApp, mail } from '@frontierjs/notifications'",
  '',
  'type Note = { id: number, title: string }',
  '',
  'export default defineNotification<Note>({',
  "  via: () => ['inApp', 'email'],",
  '',
  '  inApp: (note) => inApp()',
  "    .title('Note added')",
  '    .body(`"${note.title}" is on your list.`)',
  "    .action('Open it', `/notes/${note.id}`)",
  "    .context('Note', Number(note.id)),",
  '',
  '  email: (note, recipient) => mail()',
  "    .subject('Note added')",
  "    .greeting(`Hi ${recipient.name ?? 'there'}`)",
  '    .line(`"${note.title}" is on your list.`),',
  '})',
  '',
].join('\n'), 'utf8')

let src = readFileSync(service, 'utf8')

if (!src.includes('notify(')) {
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
    "import { createBaseService, resultData } from '@frontierjs/junction'\nimport noteAdded from '../notifications/NoteAdded.notification.ts'",
  )

  src = src.replace(ANCHOR, [
    ANCHOR,
    '',
    '    hooks: {',
    '      after: {',
    '        create: [async (ctx) => {',
    '          // resultData, not ctx.result: inside the pipeline the result is',
    '          // still the envelope, and reading .title off it is undefined',
    '          // with no error — a notification about nothing.',
    '          const row = resultData(ctx.result) as { id?: number, title?: string } | undefined',
    '          const who = ctx.auth?.user as { userId?: string, email?: string, name?: string } | undefined',
    '          if (!row?.id || !who) return',
    '',
    '          // A Recipient, not a User: { id, email, name }. id is optional,',
    '          // which is what lets somebody with no account be emailed.',
    '          await ctx.app.notify(',
    '            { id: who.userId, email: who.email, name: who.name },',
    '            noteAdded(row as { id: number, title: string }),',
    '          )',
    '        }],',
    '      },',
    '    },',
  ].join('\n'))

  writeFileSync(service, src, 'utf8')
}

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${app} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

const email      = `notify-${Date.now().toString(36)}@example.test`
const registered = await registerAccount(context, {
  email,
  password: 'correct-horse-battery-staple',
  name:     'Ada',
})
if (!await must(context, registered, { likely: 'auth is not installed in this app' })) return
context.config.userToken = registered.json.token
context.config.userId    = registered.json.user?.userId
context.config.userEmail = email

const title = `notified-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, {
  likely: 'the write was refused — the body is above',
  detail: serverLog(api),
})) return

const db = join(app, 'db', 'app.db')

// The type is the assertion, not the row count: NoteAdded is stated nowhere in
// the file that produced it, so a row carrying it is the file name having
// travelled all the way into the database.
if (!await must(context, probe.eventually(() => probe.sqliteRow({
  db,
  sql:    'select type, contextType, contextId, userId from notification order by id desc limit 1',
  expect: (rows) => rows[0]?.type === 'NoteAdded' && rows[0]?.contextType === 'Note',
  name:   'the in-app transport wrote a row, typed by the file name',
}), { retries: 10, everyMs: 300 }), {
  likely:    'notify() threw — the last of the API output is below',
  detail:    serverLog(api),
  reproduce: `cd ${app} && bun -e "const {Database}=require('bun:sqlite');console.log(new Database('db/app.db').query('select * from notification').all())"`,
})) return

// The same send, the other transport. A body rather than a subject, because the
// builder's lines are rendered at the boundary — a mailer that received a
// subject and no body is a thing that has happened here.
if (!await must(context, probe.eventually(() => probe.fileContains({
  path:   outbox,
  needle: new RegExp(`"to":"${email}"[\\s\\S]*is on your list`),
  name:   'and the email transport rendered a body to the outbox',
}), { retries: 10, everyMs: 300 }), {
  likely:    'the mailer was not reached — app.mail may be unset',
  detail:    serverLog(api),
  reproduce: `cat ${outbox}`,
})) return

remember(context, '04-send', {
  outbox,
  notifDir:  dir,
  userToken: context.config.userToken,
  userEmail: email,
  userId:    context.config.userId,
})
```
