---
title: 06-refuse
description: A transport with no formatter, refused before anything is delivered
---

## What happens when it is wrong

Add a transport to `via` that the notification has no formatter for:

```text
via: () => ['inApp', 'email', 'sms'],
```

`notify()` formats and checks **every** transport before it delivers **any** of
them, so this refuses:

```text
Notification "NoteAdded" declares transport "sms" in via() but does not
implement toSms().
```

The point is what did NOT happen. No row was written, no mail was sent — a
two-transport notification cannot half-land, leaving one person told and the
audit trail saying they were told twice. The alternative, delivering as far as
the error, is the version that is impossible to reason about afterwards.

The note itself is a different question, and the answer is on the response:

```text
{ "name": "GeneralError", "code": 500,
  "message": "Notification \"NoteAdded\" declares transport \"sms\" ...",
  "data": { "committed": true } }
```

**`committed: true`.** The note was written before the hook ran and it is still
there — an `after` hook that throws does not un-write the row, and the envelope
says so rather than leaving the caller to guess whether to retry. Which is the
argument for `tutor:jobs`: work that may fail belongs in a job, where failing is
a retry rather than a 500 on somebody's create.

Then the transport is taken out again, and the same call is made — because a
refusal that cannot be shown next to the same thing succeeding proves nothing
about the rule it names.

```js
if (!await narrate(context)) return

context.config.__step = 6

if (!needs(context, ['appDir', 'notifFile'], { from: '05-name' })) return

// A session minted on another day is expired, and it arrives as a 401 the step
// then blames on the thing it is teaching. Only for a standalone step: a full
// run has just registered, and login is rate-limited.
if (context.flag.step && context.config.userEmail) {
  const again = await signIn(context, context.config.userEmail, 'correct-horse-battery-staple')
  if (again.ok) context.config.userToken = again.json.token
}

const app    = context.config.appDir
const file   = context.config.notifFile
const db     = join(app, 'db', 'app.db')
const outbox = context.config.outbox

const WITH    = "via: () => ['inApp', 'email', 'sms'],"
const WITHOUT = "via: () => ['inApp', 'email'],"

// Counted through the probe rather than beside it, so a database that cannot be
// read is a named failure instead of a NaN two assertions further down.
const countRows = async () => {
  let n = null
  const r = await probe.sqliteRow({
    db,
    sql:    'select count(*) as n from notification',
    expect: (rows) => { n = Number(rows[0]?.n); return Number.isFinite(n) },
    name:   'the notification rows can be counted',
  })
  return r.ok ? n : null
}
const countMail = () => {
  try { return readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).length }
  catch { return 0 }
}

// ─── the refusal ──────────────────────────────────────────────────────────
writeFileSync(file, readFileSync(file, 'utf8').replace(WITHOUT, WITH), 'utf8')

let api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back — the last of its output is below',
  detail: serverLog(api),
})) return

const rowsBefore = await countRows()
const mailBefore = countMail()
if (!await must(context, {
  ok:    rowsBefore !== null,
  name:  'the notification table can be read before the refusal',
  asked: 'a row count',
  got:   'the query would not run',
}, { likely: `the database moved — ${db}` })) return

const refused = await probe.httpJson({
  url:      apiUrl(context, '/notes'),
  method:   'POST',
  headers:  { 'content-type': 'application/json', authorization: `Bearer ${context.config.userToken}` },
  body:     JSON.stringify({ title: 'sms please', body: 'written over HTTP', done: false }),
  expect:   (j) => j.code === 500
                && /does not implement toSms/.test(String(j.message))
                && j.data?.committed === true,
  describe: 'a refusal naming the missing formatter, and committed: true',
  name:     'the send was refused, and the note it was about is still committed',
})
if (!await must(context, refused, {
  likely:    'the transport list did not change — the file may not have been edited',
  detail:    serverLog(api),
  reproduce: `grep -n via ${file}`,
})) return

// The assertion is an ABSENCE, and an absence is only worth anything against a
// number taken a moment earlier — otherwise "no new row" and "this app never
// writes rows" are the same reading.
const rowsAfter = await countRows()
if (!await must(context, {
  ok:    rowsAfter === rowsBefore && countMail() === mailBefore,
  name:  'and nothing was half-delivered',
  asked: `${rowsBefore} rows and ${mailBefore} mail, unchanged`,
  got:   `${rowsAfter} rows and ${countMail()} mail`,
}, {
  likely: 'a transport delivered before validation — the checks are meant to be eager',
  detail: serverLog(api),
})) return

// ─── the control ──────────────────────────────────────────────────────────
// The same request, one word different in one file. Without this the step
// proves only that something refused, which a broken app also does.
writeFileSync(file, readFileSync(file, 'utf8').replace(WITH, WITHOUT), 'utf8')

api = await restartApi(context)
if (!await must(context, api.up, {
  likely: 'the API did not come back — the last of its output is below',
  detail: serverLog(api),
})) return

if (!await must(context, await createNote(context, `allowed-${Date.now().toString(36)}`), {
  likely: 'the write was refused — the body is above',
  detail: serverLog(api),
})) return

const rowsFinal = await probe.eventually(async () => {
  const n = await countRows()
  return n === rowsBefore + 1
    ? { ok: true,  name: 'the same call, with the transport taken out, delivered both', asked: `${rowsBefore + 1} rows`, got: `${n} rows` }
    : { ok: false, name: 'the same call, with the transport taken out, delivered both', asked: `${rowsBefore + 1} rows`, got: `${n} rows` }
}, { retries: 10, everyMs: 300 })
if (!await must(context, rowsFinal, {
  likely: 'the notification did not go out at all — the refusal above may have been for another reason',
  detail: serverLog(api),
})) return

if (!await must(context, {
  ok:    countMail() === mailBefore + 1,
  name:  'and the mail with it',
  asked: `${mailBefore + 1} lines in the outbox`,
  got:   `${countMail()}`,
}, { likely: `read it — ${outbox}` })) return
```
