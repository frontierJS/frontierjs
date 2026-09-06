---
title: 05-view
description: The chain of responsibility — what handles a request, in order
---

## `fli project:view` — what is between the request and the row

```console
fli project:view   # http://localhost:{{viewPort}}
```

The other three tools answer questions about a moment. This one answers a
question about the shape of the app: **what happens to a request, in what
order** — the surfaces, the services, the hooks each one runs, the models
underneath them, and which environment variables are required and whether they
are set.

**Open it when you are new to a codebase** — yours after a month away counts —
or when a request is being handled by something you did not expect.

One thing about it is worth knowing, because it is the difference between a
useful page and an empty one. **Services are read out of a snapshot, never
scanned for.** A hook chain is resolved when the app is CONSTRUCTED — a plugin
adds hooks, `before.all` applies to every method, an app-level hook wraps a
service-level one — so what a file tree says about a service and what the
running app does are two different facts, and only the second one is worth
drawing. So the app is built, asked what it answers, and the answer is written
to a file you commit:

```console
junction surface --app api/src/app.ts
```

That file is `surface.snapshot.md`, and it is graded in CI, so a method that
quietly stops being served is a diff on a branch rather than a 405 in
production. It is written below, and then the viewer is asked what it can see.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir'], { from: '01-app' })) return

const app  = context.config.appDir
const snap = join(app, 'surface.snapshot.md')

// The app's OWN junction, out of its node_modules — never a global one, and
// never `bunx`, which would reach the network for a package that is installed
// here. Run from the app root: bun reads .env from the working directory, and
// the app refuses to build without ENCRYPTION_KEY.
if (!await must(context, probe.command({
  bin:      join(app, 'node_modules', '.bin', 'junction'),
  args:     ['surface', '--app', 'api/src/app.ts'],
  cwd:      app,
  needle:   /surface\.snapshot\.md/,
  describe: 'the snapshot is written',
  name:     'junction surface',
}), {
  likely:    'the app could not be built — the tail is above, and it is the same failure `bun run start` would give',
  reproduce: `cd ${app} && bunx junction surface --app api/src/app.ts`,
})) return

if (!await must(context, probe.fileContains({
  path:   snap,
  needle: /\bnotes\b/,
  name:   'the snapshot names the notes service',
}), {
  likely: 'the app built but registered no services — check api/src/services exists',
})) return

await ensureApi(context)

const view = await startServer(context, {
  name: 'pview',
  argv: fliArgv('project:view', '--port', String(context.config.viewPort), '--no-open'),
  cwd:  app,
  port: context.config.viewPort,
  path: '/',
})
if (!await must(context, view.up, {
  likely:    `something already holds ${context.config.viewPort}`,
  reproduce: `cd ${app} && fli project:view --port ${context.config.viewPort}`,
})) return

const at = (path) => `http://127.0.0.1:${context.config.viewPort}${path}`

// The chain, end to end: a model in the seed, the service that answers for it,
// and the resource a screen reaches it through.
if (!await must(context, await probe.httpJson({
  url:      at('/data'),
  expect:   (j) => (j.resources ?? []).some((r) => r.model === 'Note' && r.service === 'notes'),
  describe: 'Note is drawn, with the service that answers for it',
  name:     'the chain',
}), {
  likely: 'the viewer regenerates on every request — if this is empty the app has no resources under web/src',
})) return

// The environment panel. Not decorative: a required variable that is not set is
// an app that boots, serves, and fails at the first write.
if (!await must(context, await probe.httpJson({
  url:      at('/data'),
  expect:   (j) => (j.env?.vars ?? []).every((v) => !v.required || v.status === 'set'),
  describe: 'every required variable is set',
  name:     'the environment',
}), {
  likely: 'the page names which one is missing, and offers to generate the ones it can',
})) return

log.info('')
log.info(`  the viewer is at http://localhost:${context.config.viewPort} — refresh it to regenerate from the files`)
log.info('')

remember(context, '05-view', { snapshot: snap })
```
