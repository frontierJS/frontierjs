---
title: 03-target
description: Where this app deploys to
---

## The target

```console
fli make:deploy --server localhost --domain <app>.invalid
```

writes two things: a **Dockerfile** for the app, and a `deploy` block in
`frontier.config.js` naming the machine, the directory on it, the port and the
database.

The generated block is written for a real host, so the lesson then points every
term of it at this machine and at a directory in this workspace. That rewrite is
one function — `pointAtLocalServer` — and the deploy CI phase runs the identical
one, because two copies of a recipe drift and only one of them is exercised.

```js
narrate(context)

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '02-app' })) return

const app = context.config.appDir
const srv = join(context.config.ws.dir, 'server')

context.exec({
  command: `${context.fli} make:deploy --server localhost --domain ${context.config.app}.invalid`,
  cwd:     app,
})

if (!await must(context, probe.fileExists({ path: join(app, 'deploy', 'Dockerfile'), name: 'deploy/Dockerfile' }), {
  likely: 'make:deploy did not finish — its output is above',
})) return

const confPath = join(app, 'frontier.config.js')
const { text, ok } = pointAtLocalServer(readFileSync(confPath, 'utf8'), { serverDir: srv, port: context.config.port })
writeFileSync(confPath, text, 'utf8')

// `ok: false` means every rewrite missed and the file went back unchanged — the
// deploy would then go to whatever host make:deploy was given, which is the one
// failure this lesson must not have.
if (!await must(context, {
  ok,
  name:  'the deploy block points at this machine',
  asked: `server localhost, path ${srv}, port ${context.config.port}`,
  got:   ok ? 'it does' : 'the generated block did not match what the rewrite expects',
}, {
  likely:    'the make:deploy template changed shape — pointAtLocalServer is written against it',
  reproduce: `cat ${confPath}`,
})) return

remember(context, '03-target', { serverDir: srv })
```
