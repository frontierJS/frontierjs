---
title: 04-silence
description: A socket, a write, and nothing — the half that fails without an error
---

## Nothing arrives

One socket, subscribed. Then a note is created over **plain HTTP** by a caller
the socket has no part in.

Nothing arrives.

That is not a bug and it is worth meeting before the working version, because
it is the shape a real-time feature fails in. The service **does** announce:
`fli scaffold` wrote `channel: 'notes'` into it, and `callService` publishes
every completed call under its own name. The publish succeeds. It reaches an
empty set.

**A channel is a set of connections, and nothing has joined this one.** Junction
never joins one for you — who listens to what is the app's decision, and it is
the one decision the framework cannot make. Both halves of getting it wrong are
silent: a publish to a channel nobody joined reaches nobody with no error and no
log, and the symptom is a screen that never updates.

So this step asserts the silence, and the next one asserts the same publish
arriving after one file is added. Neither half is worth much alone — silence is
also what a broken app produces.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

const watcher = await openSocket(context, { token: context.config.userToken, channels: ['notes'] })

if (!await must(context, {
  ok:    watcher.ok,
  name:  'a socket is connected',
  asked: 'the connected frame',
  got:   watcher.ok ? 'it arrived' : 'the socket never connected',
}, {
  likely:    'the app does not configure channels() — look in api/src/app.ts',
  reproduce: `grep -n 'channels()' ${join(context.config.appDir, 'api', 'src', 'app.ts')}`,
})) return

const title = `silent-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) {
  watcher.ws.close()
  return
}

// A broadcast is not the response, so it is not there when the response is.
// Waiting is what an assertion about somebody ELSE's client costs — and here it
// is what makes the silence mean anything.
await new Promise((r) => setTimeout(r, 700))
const heard = watcher.events('notes ')
watcher.ws.close()

if (!await must(context, {
  ok:    heard.length === 0,
  name:  'the write announced, and nobody was listening',
  asked: 'no frames, because no connection has joined the channel',
  got:   heard.length ? `${heard.length} frame(s): ${heard.map(f => f.event).join(', ')}` : 'nothing arrived',
}, {
  likely: 'this app already joins the notes channel — the next step is then a no-op rather than a fix',
})) return

log.info('')
log.info('  the row was written, the publish went out, and it reached nobody')
log.info('')

remember(context, '04-silence', { silentTitle: title })
```
