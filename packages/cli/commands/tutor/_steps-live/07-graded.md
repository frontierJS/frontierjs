---
title: 07-graded
description: Raise the read gate, and watch one of the two sockets stop hearing
---

## The refusal

One character in `db/schema.lite`:

```text
@@gate("0.4.4.6")   →   @@gate("4.4.4.6")
```

Reads now need a signed-in caller. Push it, restart the API, and run **the same
two sockets against the same publish**.

The signed-in one still hears it. The anonymous one hears nothing — and no line
of application code was written to make that happen. The rule is the one you
read in lesson 2, and it is enforced twice from one declaration: once as a
`WHERE` on a query, and once here, per recipient, on the way out.

The mechanism has a name worth knowing. Before a frame goes out, each recipient
is asked *what would this row look like to you* — the gate first, then the row
policy, then the field policies. A model nothing guards is skipped entirely, so
this costs nothing on the common case; a model that is guarded is graded once
per **principal**, not once per socket, so two tabs of one person are one
answer and one frame.

```js
if (!await narrate(context)) return

context.config.__step = 7

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

const edit = editSchema(context, '@@gate("0.4.4.6")', '@@gate("4.4.4.6")')
if (!await must(context, {
  ok:    edit.ok,
  name:  'reads on Note now need a signed-in caller',
  asked: 'the gate raised from 0 to 4',
  got:   edit.ok ? (edit.already ? 'it was already raised' : 'it was raised') : edit.why,
}, {
  likely:    'the scaffold wrote a different gate — raise the first number by hand',
  reproduce: `grep -n '@@gate' ${join(context.config.appDir, 'db', 'schema.lite')}`,
})) return

pushSchema(context)

// The API reads the schema once, at boot. Without this the old gate is still
// the one being enforced and the step below asserts the previous lesson.
const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

if (!await must(context, probe.httpStatus({
  url:    apiUrl(context, '/notes'),
  expect: 401,
  name:   'a stranger is now refused over HTTP',
}), {
  likely: 'the schema was pushed but the API is serving the shape it booted with',
})) return

const pair = await bothSockets(context)
if (!pair.ok) return

const title = `closed-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) {
  pair.close()
  return
}

const heard = await pair.settle()

// Asserted as a PAIR, in this order. A grader that delivered to nobody would
// pass the refusal below on its own, and be a broken app.
if (!await must(context, {
  ok:    heard.signedIn.some(f => f.data?.title === title),
  name:  'the signed-in socket still hears it',
  asked: `a frame carrying ${title}`,
  got:   heard.signedIn.length ? `${heard.signedIn.length} frame(s)` : 'no frames at all',
}, {
  likely: 'the grading refuses everybody — which is not a fix, it is the same bug facing the other way',
})) return

if (!await must(context, {
  ok:    heard.anonymous.every(f => f.data?.title !== title),
  name:  'the anonymous one is not told',
  asked: 'no frame carrying the row',
  got:   heard.anonymous.length ? `${heard.anonymous.length} frame(s) arrived` : 'nothing arrived',
}, {
  likely:    'the broadcast is not graded — a channel is being treated as a grant',
  reproduce: `curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${context.config.apiPort}/api/notes`,
})) return

log.info('')
log.info(`  signed in   ${heard.signedIn.length} frame(s)`)
log.info(`  anonymous   ${heard.anonymous.length} frame(s) — the same publish`)
log.info('')
```
