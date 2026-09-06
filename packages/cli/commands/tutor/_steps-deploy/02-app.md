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

// The environment the CONTAINER runs with, written beside the workspace rather
// than over the app's own `.env`.
//
// The container mounts a volume at /db, so its DATABASE_URL names a path inside
// that volume — which is not a path on this machine. Writing it into the app's
// `.env` was fine while this lesson was the only thing in the workspace and
// destroys a course: every later `fli db:*` opens `/db/app.db` at the
// filesystem root, `NODE_ENV=production` changes what the app will do, and a
// freshly minted key makes every `@encrypted` value an earlier lesson wrote
// unreadable.
//
// The key is KEPT where there is one, for the same reason: the deployed app and
// the local one should be able to read the same rows.
const { randomBytes } = await import('node:crypto')
const envFile = join(dir, '.env')
const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
const key = existing.match(/^ENCRYPTION_KEY=(\S+)/m)?.[1] ?? randomBytes(32).toString('hex')

const deployEnv = join(context.config.ws.dir, 'deploy.env')
writeFileSync(deployEnv, `ENCRYPTION_KEY=${key}\nDATABASE_URL=/db/app.db\nAUDIT_PATH=/db/audit/\nNODE_ENV=production\n`)

// A fresh app scaffolded without auth has no `.env` at all, and the local half
// of the lesson still needs a key.
if (!existing) writeFileSync(envFile, `ENCRYPTION_KEY=${key}\nDATABASE_URL=./db/app.db\n`)

if (!await must(context, probe.fileExists({ path: join(dir, 'package.json'), name: 'the app is on disk' }), {
  likely: 'fli new did not finish — its output is above',
})) return

// ── the history a deploy replays ────────────────────────────────────────────
//
// A deploy runs `litestone migrate apply`, which replays migration FILES. Lesson
// 1 built its model with `fli db:push`, which writes tables and no file — that
// is what push is for, and its own output says so — so an app that has been
// through the earlier lessons has a schema its history does not build, and the
// container refuses to start with *the migration history does not build the
// schema this app declares*.
//
// This is the catch-up push tells you to run, and it is only needed for an app
// that was already here: `fli new` leaves a history that matches.
if (built) {
  log.info('this app was built with `fli db:push`, which writes no migration file —')
  log.info('catching the history up, because a deploy replays files rather than a schema')
  // `--create-only`: the tables are already there, so applying the delta would
  // be `ALTER TABLE ADD COLUMN` against a column that exists. `db:baseline` is
  // the other half — it records the files as applied without running them, and
  // refuses to record a lie.
  context.exec({ command: `${context.fli} db:migrate --create-only`, cwd: dir })
  context.exec({ command: `${context.fli} db:baseline`, cwd: dir })
}

remember(context, '02-app', { appDir: dir, deployEnv })
```
