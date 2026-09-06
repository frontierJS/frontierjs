---
title: 04-arrives
description: A socket, a write by somebody else, and a frame that arrives unasked
---

## It arrives

One socket, subscribed to `notes`. Then a note is created over **plain HTTP** by
a caller the socket has no part in — a different connection, a different
request, nothing shared but the database.

The socket is told.

Nothing in this app was written to make that happen. Two files the scaffold
already wrote are the whole of it:

- `api/src/services/notes.service.ts` declares `channel: 'notes'`, so every
  completed call through the service is announced there under its own name.
- `api/src/core/channels.ts` decides **who is listening**, and joins each new
  connection to every channel a service declares.

The second one is the half worth knowing about, because it is the half a
framework cannot write for you. A channel is a named set of connections, and
membership is a decision about your app — which is why the next step takes that
file back out and shows you what its absence looks like.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

// Read the wiring back off the app before asserting anything about it, so a
// frame arriving is attributable to this file rather than to something else.
const channelsTs = join(context.config.appDir, 'api', 'src', 'core', 'channels.ts')

if (!await must(context, probe.fileContains({
  path:   channelsTs,
  needle: 'joinChannels',
  name:   'the app decides who listens, in one file',
}), {
  likely:    'this app was scaffolded before core/channels.ts existed — the next step writes it',
  reproduce: `ls ${channelsTs}`,
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

const title = `heard-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) {
  watcher.ws.close()
  return
}

// A broadcast is not the response, so it is not there when the response is.
// Waiting is what an assertion about somebody ELSE's client costs.
await new Promise((r) => setTimeout(r, 700))
const heard = watcher.events('notes ')
watcher.ws.close()

if (!await must(context, {
  ok:    heard.some(f => f.data?.title === title),
  name:  'the socket is told, without asking',
  asked: `a frame carrying ${title}`,
  got:   heard.length ? `${heard.length} frame(s): ${heard.map(f => f.event).join(', ')}` : 'no frames at all',
}, {
  likely:    'the connection joins nothing, or the channel name does not match the service',
  reproduce: `grep -n channel ${join(context.config.appDir, 'api', 'src', 'services', 'notes.service.ts')}`,
})) return

log.info('')
log.info(`  heard   ${heard.map(f => f.event).join(', ')}`)
log.info('')

remember(context, '04-arrives', { heardTitle: title })
```
