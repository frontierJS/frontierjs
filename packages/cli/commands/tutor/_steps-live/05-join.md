---
title: 05-join
description: One file, and the same publish arrives
---

## Who listens

Two edits. First a new file, `api/src/core/channels.ts` — the one the generated
README already points at:

```text
export const OPEN_CHANNELS = ['notes']

export function joinChannels(app, session, conn) {
  for (const name of OPEN_CHANNELS) app.channel(name).join(conn)
}
```

One line per channel a connection listens to, and a list rather than a call so
the answer to *what does this app broadcast, and to whom* is one file.

Then one line in `api/src/app.ts`, immediately after `channels()` is configured:

```text
app.channels.on('connection', (session, conn) => joinChannels(app, session, conn))
```

That is the whole mechanism. A connection is offered the channels this app
thinks it should hear about, once, when it connects.

Note what is **not** here: any check of who the person is. Joining used to be a
grant — a connection in a channel received every row published there, and
`@@allow` compiles into a `SELECT`'s `WHERE`, which a broadcast is not. That was
a real hole in this repository's own example app for a year. It is closed: a
frame is graded per recipient on the way out, so joining is a subscription and
the rule that decides delivery is the same one in `db/schema.lite`. Step 7 makes
you watch it refuse somebody.

The API is restarted, because it reads this wiring once at boot. Then the same
publish as the step before.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir', 'userToken'], { from: '03-account' })) return

const appTs    = join(context.config.appDir, 'api', 'src', 'app.ts')
const channels = join(context.config.appDir, 'api', 'src', 'core', 'channels.ts')

writeFileSync(channels, [
  '// api/src/core/channels.ts — who receives a broadcast.',
  '//',
  '// A service declares `channel:` and Junction publishes every write on it.',
  '// Nothing is delivered until a CONNECTION has joined, and joining is this',
  "// file's decision — the one an app makes and the framework cannot.",
  '//',
  '// Joining is a subscription and not a permission. Each frame is graded per',
  "// recipient against the model's own @@gate and @@allow, so this list says",
  '// what a connection LISTENS to, never what it may read.',
  '',
  "import type { App } from '@frontierjs/junction'",
  '',
  '/** Channels every connection joins, whoever is on the other end. */',
  "export const OPEN_CHANNELS = ['notes'] as const",
  '',
  'type Session = { userId?: string; id?: string } | null | undefined',
  '',
  '/** Everything one connection listens to. Called once, on connection. */',
  'export function joinChannels(app: App, _session: Session, conn: unknown): void {',
  '  for (const name of OPEN_CHANNELS) app.channel!(name).join(conn as never)',
  '}',
  '',
].join('\n'), 'utf8')

// Both edits refuse rather than writing the file back unchanged: an anchor that
// silently missed leaves the assertion below measuring the step before it.
let src = readFileSync(appTs, 'utf8')

if (!src.includes('joinChannels')) {
  const CONFIGURE = 'app.configure(channels())'
  const imports   = [...src.matchAll(/^import .*$/gm)]

  if (!src.includes(CONFIGURE) || imports.length === 0) {
    await must(context, {
      ok:    false,
      name:  'api/src/app.ts has the two places this step edits',
      asked: "the scaffold's own app.ts",
      got:   'a file that has been changed under the lesson',
    }, {
      likely:    'add the two lines by hand — the prose above is the whole of them',
      reproduce: `grep -n 'channels()' ${appTs}`,
    })
    return
  }

  const last = imports[imports.length - 1]
  src = src.slice(0, last.index + last[0].length)
    + "\nimport { joinChannels }     from './core/channels.ts'"
    + src.slice(last.index + last[0].length)

  src = src.replace(CONFIGURE, [
    CONFIGURE,
    '',
    '// Who receives a broadcast. A channel a connection has not joined delivers',
    '// nothing, silently — see api/src/core/channels.ts.',
    "app.channels!.on('connection', (session, conn) => joinChannels(app, session, conn))",
  ].join('\n'))

  writeFileSync(appTs, src, 'utf8')
}

if (!await must(context, probe.fileContains({
  path:   appTs,
  needle: "app.channels!.on('connection'",
  name:   'app.ts joins a connection to the channel',
}), {
  likely: 'the edit missed its anchor',
})) return

const api = await restartApi(context)
if (!await must(context, api.up, {
  likely:    'the API did not come back — the last of its output is below',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
  detail:    serverLog(api),
})) return

const watcher = await openSocket(context, { token: context.config.userToken, channels: ['notes'] })
if (!await must(context, {
  ok:    watcher.ok,
  name:  'a socket is connected',
  asked: 'the connected frame',
  got:   watcher.ok ? 'it arrived' : 'the socket never connected',
}, { likely: 'the API restarted but the channels plugin did not come up' })) return

const title = `heard-${Date.now().toString(36)}`
const made  = await createNote(context, title)
if (!await must(context, made, { likely: 'the write was refused — the body is above' })) {
  watcher.ws.close()
  return
}

await new Promise((r) => setTimeout(r, 700))
const heard = watcher.events('notes ')
watcher.ws.close()

// The pair. Step 4 asserted the silence; this asserts the same publish, from
// the same caller, on the same channel, arriving. One file is the difference.
if (!await must(context, {
  ok:    heard.some(f => f.data?.title === title),
  name:  'the socket is told, without asking',
  asked: `a frame carrying ${title}`,
  got:   heard.length ? `${heard.length} frame(s): ${heard.map(f => f.event).join(', ')}` : 'no frames at all',
}, {
  likely:    'the connection handler is registered but the channel name does not match the service',
  reproduce: `grep -n channel ${join(context.config.appDir, 'api', 'src', 'services', 'notes.service.ts')}`,
})) return

log.info('')
log.info(`  heard   ${heard.map(f => f.event).join(', ')}`)
log.info('')

remember(context, '05-join', { joined: true })
```
