---
title: 04-devtools
description: The API console — what happened to that call
---

## Junction's console — why did that call fail?

This one is not a command, because it runs **inside your app**. One line in
`api/src/app.ts`:

```text
app.configure(devtools())
```

and the app serves a second, separate console on {{devtoolsPort}} alongside
whatever port it already answers on. It binds to loopback and refuses to bind
anywhere else without an `auth` gate, so it is safe to leave configured.

**Open it when a call did something you did not expect.** The live feed carries
every service call the app makes — over HTTP and over the socket alike — with
the service, the method, the transport, who was calling, how long it took, and
**what it answered**. That last one is the whole point: a request that comes
back 401 tells the browser almost nothing, and this tells you which service,
which method, and the sentence the refusal used.

Two calls are made below and they are a pair — one signed in and allowed, one
anonymous and refused — because a console that reported everything as fine and
a console that reported everything as broken look the same from one call.

```js
if (!await narrate(context)) return

context.config.__step = 4

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app   = context.config.appDir
const appTs = join(app, 'api', 'src', 'app.ts')
const src   = readFileSync(appTs, 'utf8')

if (!src.includes('devtools(')) {
  // The import line and the configure line. Anchored on manifestPlugin, which
  // every scaffolded app registers, rather than on a line number.
  // The port is written into the file ONLY when it is not the console's own
  // default. A lesson that baked a number in would leave every later lesson's
  // app binding that number too, and a person reading api/src/app.ts afterwards
  // would find a port where the documented line has none.
  const call = context.config.devtoolsPort === 8503
    ? 'devtools()'
    : `devtools({ port: ${context.config.devtoolsPort} })`

  const wired = src
    .replace(/(\bmanifestPlugin\b)(,?)([^\n]*from '@frontierjs\/junction')/, '$1, devtools$2$3')
    .replace(/app\.configure\(manifestPlugin\(\)\)/, `app.configure(manifestPlugin())\napp.configure(${call})`)

  if (wired === src) {
    log.error('could not find where to add devtools() in api/src/app.ts — add it by hand:')
    log.info('  app.configure(devtools())')
    context.config.abort = true
    return
  }
  writeFileSync(appTs, wired, 'utf8')
  context.config.__devtoolsAdded = true
  log.info('added app.configure(devtools()) to api/src/app.ts')
}

// The app reads its plugin list once, at boot.
await restartApi(context)

if (!await must(context, await probe.httpStatus({
  url:     `http://127.0.0.1:${context.config.devtoolsPort}/api/state`,
  retries: 20,
  name:    'the console is listening',
}), {
  likely:    `something already holds ${context.config.devtoolsPort}, or the app did not restart — see .tutor/api.log`,
  reproduce: `cd ${app} && bun run start`,
})) return

// The pair. A SIGNED-IN read and an ANONYMOUS write, rather than the same
// caller twice: which levels the Note model grades at is the app's to change —
// lesson 3 raises its read gate — and a pair built on a particular gate stops
// being a pair the moment somebody edits the schema this lesson is looking at.
// A caller who holds USER may read, and nobody anonymous may create, in every
// state this tutorial leaves the app in.
if (!context.config.userToken) {
  const who = `tools-${Date.now()}@frontier.invalid`
  const reg = await registerAccount(context, { email: who, password: 'correct horse battery', name: 'Ada' })
  if (!await must(context, reg, { likely: 'the API is up but /auth/register is not answering' })) return
  context.config.userToken = reg.json.token
}

await probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  headers: asCaller(context.config.userToken),
  name:    'a read this caller may make',
})
await probe.httpStatus({
  url:     apiUrl(context, '/notes'),
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body:    JSON.stringify({ title: 'refused', body: 'no session', done: false }),
  expect:  401,
  name:    'a write nobody anonymous may make',
})

const feed = (j) => j.requests ?? []

if (!await must(context, await probe.httpJson({
  url:      `http://127.0.0.1:${context.config.devtoolsPort}/api/state`,
  expect:   (j) => feed(j).some((r) => r.service === 'notes' && r.method === 'find' && r.status === 'ok'),
  describe: 'the read is in the feed, as ok',
  name:     'the call that was allowed',
  retries:  6,
}), {
  likely: 'the console subscribes to the telemetry bus at boot — if the feed is empty the app was restarted after the calls',
})) return

// The half that matters, and the half that was broken until it was asked for:
// a refusal thrown by an AROUND hook — which is what the gate is — never
// touched ctx.error, so every 401 an app made arrived here as `ok`.
if (!await must(context, await probe.httpJson({
  url:      `http://127.0.0.1:${context.config.devtoolsPort}/api/state`,
  expect:   (j) => feed(j).some((r) => r.service === 'notes' && r.method === 'create' && r.status === 'error' && r.errorCode === 401),
  describe: 'the refusal is in the feed, as an error, with its status',
  name:     'the call that was refused',
  retries:  6,
}), {
  likely: 'a refusal recorded as ok means the telemetry event carried no error — see packages/junction/src/core/service.ts',
})) return

log.info('')
log.info(`  the console is at http://localhost:${context.config.devtoolsPort} — the feed has both calls in it`)
log.info('')

remember(context, '04-devtools', {})
```
