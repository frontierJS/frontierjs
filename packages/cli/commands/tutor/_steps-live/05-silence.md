---
title: 05-silence
description: The same publish with nobody joined — the half that fails without an error
---

## Nothing arrives

Take the join back out. In `api/src/app.ts` the plugin is configured with a
callback:

```text
app.configure(channels((a) => {
  a.channels!.on('connection', (session, conn) => joinChannels(a, session, conn))
}))
```

This step replaces it with the bare `app.configure(channels())`, restarts the
API, and runs **the same publish as the step before** — same caller, same
channel, same socket.

Nothing arrives.

The publish still happens. The service still declares `channel: 'notes'`, the
call still completes, `callService` still announces it. It reaches an empty set,
because a channel is a set of connections and no connection is in this one.

**Both halves of getting this wrong are silent.** There is no error, no warning
and no log line — on the server a publish to a channel nobody joined is
indistinguishable from a successful one, and in the browser the symptom is a
screen that never updates. That is why it is worth ten seconds of watching:
it is not a shape you can debug by reading a stack trace, because there isn't
one.

The wiring is put back before the step ends, so the rest of the lesson runs
against a working app.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

const appTs  = join(context.config.appDir, 'api', 'src', 'app.ts')
const before = readFileSync(appTs, 'utf8')

const JOINED = /app\.configure\(channels\(\(a\) => \{[\s\S]*?\}\)\)/

// The edit refuses rather than writing the file back unchanged: an anchor that
// silently missed would leave this step asserting silence about an app it did
// not change, which is the one failure this lesson cannot afford to fake.
if (!await must(context, {
  ok:    JOINED.test(before),
  name:  'api/src/app.ts has the wiring this step removes',
  asked: 'app.configure(channels((a) => …))',
  got:   JOINED.test(before) ? 'it is there' : 'a file that has been changed under the lesson',
}, {
  likely:    'app.ts was edited by hand — put the callback back, or run this lesson with --restart',
  reproduce: `grep -n 'channels(' ${appTs}`,
})) return

writeFileSync(appTs, before.replace(JOINED, 'app.configure(channels())'), 'utf8')

// Whatever this step asserts, the app is left working. `restore` runs on every
// path out, including a refused probe — a lesson that leaves a broken app
// behind teaches the next step's failure instead of its own.
const restore = async () => {
  writeFileSync(appTs, before, 'utf8')
  await restartApi(context)
}

const off = await restartApi(context)
if (!off.up.ok) {
  await restore()
  await must(context, off.up, {
    likely: 'the API did not come back after the edit — the last of its output is below',
    detail: serverLog(off),
  })
  return
}

const watcher = await openSocket(context, { token: context.config.userToken, channels: ['notes'] })
if (!watcher.ok) {
  await restore()
  await must(context, {
    ok:    false,
    name:  'a socket is connected',
    asked: 'the connected frame',
    got:   'the socket never connected',
  }, { likely: 'the API restarted but the channels plugin did not come up' })
  return
}

const title = `silent-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!made.ok) {
  watcher.ws.close()
  await restore()
  await must(context, made, { likely: 'the write was refused — the body is above' })
  return
}

await new Promise((r) => setTimeout(r, 700))
const heard = watcher.events('notes ')
watcher.ws.close()

await restore()

// The pair. Step 4 asserted the frame arriving; this asserts the same publish,
// from the same caller, on the same channel, reaching nobody. One callback is
// the whole difference between them.
if (!await must(context, {
  ok:    heard.length === 0,
  name:  'the write announced, and nobody was listening',
  asked: 'no frames, because no connection has joined the channel',
  got:   heard.length ? `${heard.length} frame(s): ${heard.map(f => f.event).join(', ')}` : 'nothing arrived',
}, {
  likely: 'something else in this app joins the notes channel — grep for app.channel(',
})) return

if (!await must(context, probe.fileContains({
  path:   appTs,
  needle: 'joinChannels',
  name:   'the wiring is back',
}), {
  likely: 'the restore did not write — put the callback back by hand before step 6',
})) return

log.info('')
log.info('  the row was written, the publish went out, and it reached nobody')
log.info('  app.ts is back as it was')
log.info('')

remember(context, '05-silence', { silentTitle: title })
```
