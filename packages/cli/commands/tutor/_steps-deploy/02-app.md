---
title: 02-app
description: An app to deploy, and a key to encrypt with
---

## Something to deploy

The same app the first two lessons build. What is added here is `.env` — a real
`ENCRYPTION_KEY`, generated now, because an app whose columns are encrypted
cannot start without one and a deploy that fails at the last step teaches
nothing about deploying.

```js
if (!await narrate(context)) return

context.config.__step = 2

const dir = appDir(context)
const built = existsSync(join(dir, 'db', 'schema.lite'))

if (!built) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  log.info(`building an app to deploy — ${dir}`)
  context.exec({
    command: `${context.fli} new ${context.config.app} --yes --auth --no-git --no-deploy --source ${context.config.source}`,
    cwd:     context.config.ws.dir,
  })
} else {
  log.info(`reusing the app in ${dir}`)
}

context.config.appDir = dir

// The container mounts a volume at /db, so DATABASE_URL names a path INSIDE it
// rather than the app directory this file sits in.
const { randomBytes } = await import('node:crypto')
writeFileSync(join(dir, '.env'),
  `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nDATABASE_URL=/db/app.db\nNODE_ENV=production\n`)

if (!await must(context, probe.fileExists({ path: join(dir, 'package.json'), name: 'the app is on disk' }), {
  likely: 'fli new did not finish — its output is above',
})) return

remember(context, '02-app', { appDir: dir })
```
