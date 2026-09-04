---
title: 02-basecamp
description: Start the control plane on a database of its own
---

## The control plane

Basecamp is an ordinary FrontierJS app — the same three realms as the one you
built in lesson 1, and a schema an order of magnitude bigger. What makes it a
control plane is what its models are *about*: servers, apps, deployments,
volumes, secrets. The fleet is rows.

It starts here on a database of its own, in this lesson's workspace, so nothing
you already have is touched:

```console
DATABASE_URL=<workspace>/basecamp.db bun run start
```

An app with no rows in it is a real state and basecamp knows it: `/setup/probe`
is how the browser asks whether anybody has ever signed in. That is the path
this step waits on, because a port answering is not the same as an app being
up — and it is the next step that reads the answer, since *empty* is only true
until somebody sets it up and this step runs again on every resume.

```js
narrate(context)

context.config.__step = 2

if (!needs(context, ['basecamp'], { from: '01-machine' })) return

// The fleet secret, minted per run. It is the credential on BOTH ends — the
// control plane verifies with it and the outpost signs with it — so it is
// remembered here and read again by the step that starts the machine.
// `OUTPOST_SECRET` is declared with a minimum length, so this is not a nonce.
const secret = `tutor-fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const dbFile = join(context.config.ws.dir, 'basecamp.db')

// `--restart` begins the lesson again, and the rows are part of what the last
// run left: setup succeeds exactly once against a database, so without this a
// restart is refused at this step for having worked before. Everything removed
// is inside the workspace by construction.
if (context.flag.restart) {
  for (const f of ['basecamp.db', 'basecamp-jobs.db'])
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(context.config.ws.dir, f + suffix), { force: true })
  rmSync(join(context.config.ws.dir, 'audit'), { recursive: true, force: true })
  log.info('--restart: the control plane starts on an empty database again')
}

context.config.secret = secret

const hub = await startHub(context)

if (!await must(context, hub.up, {
  likely:    'the control plane did not come up — its output is below',
  reproduce: `cd ${context.config.basecamp} && DATABASE_URL=${dbFile} bun run start`,
  detail:    serverLog(hub),
})) return

log.info(`  ${dbFile}`)

remember(context, '02-basecamp', { secret, dbFile })
```
