---
title: 01-app
description: An empty app, so there is a litestone to read the database with
---

## Somewhere to put it

The reading is done by `litestone`, and the way an adopter gets one is the way
they get everything else — an app:

```console
fli new <app> --no-auth
```

`--no-auth` because this lesson is about a schema you already have. Auth appends
its own `User` model, and the point here is that every model comes out of the
database.

The app is empty: two `database` blocks and no models. What fills it is the next
three steps.

One command follows it, and the scaffold tells you so on its way out:

```console
fli keygen aes --format hex --name ENCRYPTION_KEY --env
```

`ENCRYPTION_KEY` is litestone's, not auth's — it is what `@encrypted` and
`@secret` columns are written with — so it is required whether or not an app
signs anybody in. With auth installed, `auth:install` generates it; here nothing
does, and the API refuses to start without it.

`--format hex` is not decoration. `keygen` defaults to base64 and litestone
parses this variable as hex, so a base64 key decodes to zero bytes and is
refused for its length.

```js
if (!await narrate(context)) return

context.config.__step = 1

const dir = appDir(context)

if (!existsSync(join(dir, 'db', 'schema.lite'))) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

  log.info(`building somewhere to adopt into — ${dir}`)
  context.exec({
    command: `${context.fli} new ${context.config.app} --yes --no-auth --no-example --no-git --no-deploy --source ${context.config.source}`,
    cwd:     context.config.ws.dir,
  })
} else {
  log.info(`reusing the app at ${dir}`)
}

// The scaffold prints this instruction and does not run it. Without a key the
// app throws at `defineEnv` before it binds a port, which reads as a broken
// scaffold rather than as a missing variable.
const envFile = join(dir, '.env')
if (!/^[ \t]*ENCRYPTION_KEY[ \t]*=[ \t]*\S/m.test(existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''))
  context.exec({ command: `${context.fli} keygen aes --format hex --name ENCRYPTION_KEY --env`, cwd: dir })

context.config.appDir = dir

// The whole lesson runs litestone out of THIS app's node_modules. A bare
// `bunx litestone` in a directory with none goes to the registry and reads the
// database with a different build of the tool than the app will run.
if (!await must(context, probe.fileExists({
  path: join(dir, 'node_modules', '.bin', 'litestone'),
  name: 'litestone is installed in the app',
}), {
  likely:    'the install did not finish — its output is above',
  reproduce: `cd ${dir} && bun install`,
})) return

remember(context, '01-app', { appDir: dir })
```
