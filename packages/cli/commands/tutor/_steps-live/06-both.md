---
title: 06-both
description: Two sockets, one publish — and both of them are told
---

## Two sockets

The same publish, watched by two clients at once: one holding the session from
step 3, one holding nothing at all.

Both receive it, and that is **correct**. `fli scaffold` gave `Note` the gate
`@@gate("0.4.4.6")`, and the first number is read: **0 means anybody**. A
stranger may already list these notes over HTTP, so a stranger being told about
a new one takes nothing away.

That is worth doing before the interesting case, because it is the control. A
grader that delivered to nobody would satisfy any test that only checks the
refusal — so the refusal in the next step is only evidence if this step's
delivery is asserted first, on the same mechanism.

```js
if (!await narrate(context)) return

context.config.__step = 6

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const pair = await bothSockets(context)
if (!pair.ok) return

const title = `open-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) {
  pair.close()
  return
}

const heard = await pair.settle()

if (!await must(context, {
  ok:    heard.signedIn.some(f => f.data?.title === title),
  name:  'the signed-in socket is told',
  asked: `a frame carrying ${title}`,
  got:   heard.signedIn.length ? `${heard.signedIn.length} frame(s)` : 'no frames at all',
}, {
  likely: 'the publish did not go out — step 4 is the one that would have failed',
})) return

if (!await must(context, {
  ok:    heard.anonymous.some(f => f.data?.title === title),
  name:  'so is the anonymous one, because reads are public',
  asked: `a frame carrying ${title}`,
  got:   heard.anonymous.length ? `${heard.anonymous.length} frame(s)` : 'no frames at all',
}, {
  likely:    'the gate on Note is not 0 for read — look at db/schema.lite',
  reproduce: `grep -n '@@gate' ${join(context.config.appDir, 'db', 'schema.lite')}`,
})) return

// The control for the control: what a stranger is told over the socket agrees
// with what a stranger is answered over HTTP. Two transports, one rule — and
// the whole of the next step is that they go on agreeing after the rule moves.
if (!await must(context, probe.httpStatus({
  url:    apiUrl(context, '/notes'),
  expect: 200,
  name:   'and a stranger may list them over HTTP',
}), {
  likely: 'the read gate is not 0 — the two halves of this step disagree',
})) return

log.info(`  signed in   ${heard.signedIn.length} frame(s)`)
log.info(`  anonymous   ${heard.anonymous.length} frame(s)`)
```
