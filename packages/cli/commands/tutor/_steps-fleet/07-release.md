---
title: 07-release
description: A release the control plane drove, and the bytes it can name
---

## The other half — a release

The command in step 6 proved the machine takes orders. A **release** is the
thing a control plane exists for, and it is a longer sentence: put this image
on that machine, start it, and record which bytes ran.

The app gets a source — an image, `nginx:alpine`, which stays up on its own
command and answers nothing this lesson needs.

Then a deployment is created against it, and nothing else is typed. Basecamp
writes a `Deployment` row and a `DeploymentStep` per stage, dispatches
`deployment:run` to its own queue, and the job talks to the same Outpost the
last step used — `POST /pull`, which fetches the image and reports its digest,
then `POST /deploy`, which starts a container of exactly those bytes.

**The assertion that matters is the digest.** A tag is not an identity: two
machines at the same commit hold two images called the same thing with different
bytes in them, and nothing compares them. So what is checked is that
`Deployment.builtImage` carries a digest the MACHINE reported, that a container
is really running here under the name the app was given, and that the two agree.
A release that cannot say which bytes are serving has not been proven to have
released anything.

**No stub.** `BASECAMP_STUB_OUTPOST` would answer this whole protocol and issue
no command — `digest: null` and `healthy: true` — which is the vacuous pass that
`providers/executor.ts` exists to make impossible. This lesson never sets it.

```js
if (!await narrate(context)) return

context.config.__step = 7

// `outpostSecret` for the same reason 06 needs it: ensureFleet restarts the
// machine when nothing is answering, and it may only start on its own key.
if (!needs(context, ['appId', 'dbFile', 'outpostSecret', 'token', 'workspaceId', 'basecamp', 'outpost'], {
  from: {
    appId: '06-command', dbFile: '02-basecamp',
    outpostSecret: '05-outpost',
    token: '03-setup', workspaceId: '03-setup',
    basecamp: '01-machine', outpost: '01-machine',
  },
})) return

if (!await must(context, await ensureFleet(context, { outpost: true }), {
  likely: 'the control plane or the machine is not answering — run this lesson from the start',
})) return

// A release runs a container, so this half needs a daemon. Without one the lesson stops
// rather than fails: everything before this ran, and *no docker here* is a fact
// about the machine and not about the framework — the same answer step 1 gives
// somebody who installed from npm and has no basecamp.
if (!probe.commandExists({ bin: 'docker' }).ok) {
  log.warn('no docker on this machine — the release half needs one')
  log.info('')
  log.info('  Everything above happened: a machine reported in, and a command from the')
  log.info('  control plane really ran on it. A RELEASE starts a container here, which is')
  log.info('  the one thing this machine cannot be asked to do.')
  log.info('')
  context.config.stop = true
  return
}

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}
const appId = context.config.appId

// ─── something to release ─────────────────────────────────────────────────
//
// An image a registry holds, because `/pull` is `docker pull` and an image
// built only on this machine is one it cannot fetch. A null port publishes
// nothing: the app serves no traffic here, and a host port would collide with
// whatever this machine already holds.
const image = 'nginx:alpine'

// `patch`, because everything else about the row is already right and a
// release reads the row as it stands.
if (!await must(context, await probe.httpJson({
  url:     hubUrl(context, `/apps/${appId}`),
  method:  'PATCH',
  headers: as,
  body:    JSON.stringify({
    source: { kind: 'image', image },
    port:   null,
  }),
  expect:   (j) => Boolean(j.id),
  describe: 'the app now knows what to run',
  name:     `the app is given a source`,
}), {
  likely: 'the patch was refused — a source is a developer-and-above write',
})) return

// ─── the release ──────────────────────────────────────────────────────────
const release = await probe.httpJson({
  url:      hubUrl(context, '/deployments'),
  method:   'POST',
  headers:  as,
  body:     JSON.stringify({ appId, trigger: 'manual' }),
  expect:   (j) => Boolean(j.id),
  describe: 'a Deployment row, and a job on the queue',
  name:     'a release is created',
})
if (!await must(context, release, {
  likely:    'the create refused, which it does when the app has no placement or the machine has no outpost — the reason is in the body above',
  reproduce: `curl -s -X POST ${hubUrl(context, '/deployments')}`,
})) return

const deploymentId = release.json.id

// Durable work again: the call answered when the row was written, so the
// verdict is polled. A pull is minutes on a cold daemon.
const finished = await probe.httpJson({
  url:      hubUrl(context, `/deployments/${deploymentId}`),
  headers:  as,
  expect:   (j) => j.status === 'success' || j.status === 'failed',
  describe: 'a release that reached a verdict',
  retries:  120,
  everyMs:  2_000,
  name:     'the release ran to a verdict',
})
if (!await must(context, finished, {
  likely:    'the pipeline is still running or the job never started — the outpost log is below',
  detail:    serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20),
  reproduce: `curl -s ${hubUrl(context, `/deployments/${deploymentId}`)}`,
})) return

const machineLog = serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20)

if (!await must(context, {
  ok:    finished.json.status === 'success',
  name:  'and it succeeded',
  asked: 'status success',
  got:   `status ${finished.json.status}`,
}, {
  likely: 'a step failed — every step carries its own log line, and the outpost output is below',
  detail: machineLog,
})) return

// ─── which bytes ──────────────────────────────────────────────────────────
//
// Read out of the control plane's own row rather than off the response: a
// digest is what the MACHINE reported, and `null` there is the shape a stub
// answers with. This is the line that separates a release from a job that
// returned 200.
let digest = null
if (!await must(context, probe.sqliteRow({
  db:     context.config.dbFile,
  sql:    'select status, builtImage from deployment where id = ?',
  params: [deploymentId],
  expect: (rows) => {
    digest = rows[0]?.builtImage ?? null
    return typeof digest === 'string' && /^sha256:[0-9a-f]{12,}/.test(digest)
  },
  name:   'the control plane recorded which bytes ran',
}), {
  likely: 'the executor answered without pulling — a stub reports digest: null, which is why this asks',
})) return

// And the machine agrees. `fjs-<appId>` is the name outpost gives a container,
// deliberately stable so a machine cannot accumulate app-1, app-2.
const container = `fjs-${appId}`

if (!await must(context, probe.dockerRunning({
  container,
  name: 'a container of that image is running here',
}), {
  likely:    'the deploy reported success and started nothing — the outpost log is below',
  detail:    serverLog(context.config.__servers?.outpost ?? { logPath: '' }, 20),
  reproduce: `docker ps --filter name=${container}`,
})) return

// The pair. A digest in a row and a container on a machine are two facts, and
// only their AGREEMENT says the row describes what is serving.
const running = probe.dockerImageOf({ container })
if (!await must(context, {
  ok:    String(running.got ?? '').startsWith(digest.slice(0, 20)),
  name:  'and it is the same image the row names',
  asked: `the container to be running ${digest.slice(0, 20)}…`,
  got:   String(running.got ?? 'nothing').slice(0, 30),
}, {
  likely: 'the row and the machine disagree — a second release between the two would do this',
})) return

log.info('')
log.info(`  ${digest.slice(0, 23)}…   pulled onto this machine, recorded by the control plane`)
log.info(`  ${container}   still running — the finish step takes it down`)
log.info('')

remember(context, '07-release', { deploymentId, container })
```
