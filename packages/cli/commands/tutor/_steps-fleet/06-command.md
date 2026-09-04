---
title: 06-command
description: A command sent from the control plane, that really runs here
---

## A command that really runs

Everything so far arranged for this. A **Job** is a command an app owns, and
running one is the shortest path through the whole machinery: the control plane
looks up where the app is placed, finds the Outpost target for that machine,
signs a request with the fleet secret, and the Outpost — having verified the
signature — runs the command as a real process on a real machine and hands back
what it said.

Four rows have to exist before there is anywhere to send it, and the shape is
the point:

```console
Project → Environment → App → AppServer      the app, and the machine it is on
Job                                          the command, owned by the app
```

`AppServer` is the placement, and it is what makes a job reachable at all. An
app placed nowhere resolves no machine; a machine with no registered Outpost
resolves no target. Both are refusals with sentences rather than a release that
quietly runs nothing — which is the state the whole executor module exists to
make impossible.

The assertion is a **nonce this lesson just minted**, echoed back out of the
job's recorded output. A canned answer, a stubbed executor or a command that
never left the control plane all fail it.

```js
narrate(context)

context.config.__step = 6

if (!needs(context, ['serverId', 'dbFile', 'secret', 'token', 'workspaceId', 'basecamp', 'outpost'], {
  from: {
    serverId: '04-server', dbFile: '02-basecamp', secret: '02-basecamp',
    token: '03-setup', workspaceId: '03-setup',
    basecamp: '01-machine', outpost: '01-machine',
  },
})) return

// `--step 6` reaches neither process, because the two steps that start them are
// replayed into no-ops on a resume and skipped outright by `--step`.
if (!await must(context, await ensureFleet(context, { outpost: true }), {
  likely: 'the control plane or the machine is not answering — run this lesson from the start',
})) return

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}

const post = (path, body, method) => probe.httpJson({
  url:      hubUrl(context, path),
  method:   'POST',
  headers:  method ? { ...as, 'x-service-method': method } : as,
  body:     JSON.stringify(body),
  expect:   (j) => Boolean(j.id),
  describe: 'the row that was made',
  name:     `${method ?? 'create'} ${path}`,
})

// Run-scoped, because a project's slug is unique within a workspace: a fixed
// name passes once and refuses every run after it with a 409 that reads like a
// standing problem. The same token names the command's nonce below.
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const project = await post('/projects', { name: `Tutorial ${run}` })
if (!await must(context, project, { likely: 'the create was refused — check the standing on this workspace' })) return

const environment = await post('/environments', { projectId: project.json.id, name: 'prod', tier: 'production' })
if (!await must(context, environment)) return

const application = await post('/apps', { environmentId: environment.json.id, name: 'hello' })
if (!await must(context, application)) return

const appId = application.json.id

if (!await must(context, await post(`/apps/${appId}`, { serverId: context.config.serverId }, 'place'), {
  likely: 'the machine cannot hold work — a destroyed or stopped server is refused by name',
})) return

// The nonce is what makes this unfakeable, and it goes into the command rather
// than into the assertion alone: a run that answered from a cache, a stub or a
// previous attempt cannot contain a string that did not exist until now.
const nonce = `fleet-${run}`

const job = await post('/jobs', {
  appId,
  name:           'say-hello',
  command:        `echo ${nonce} && uname -s`,
  timeoutSeconds: 20,
})
if (!await must(context, job)) return

if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, `/jobs/${job.json.id}`),
  method:   'POST',
  headers:  { ...as, 'x-service-method': 'trigger' },
  body:     '{}',
  expect:   (j) => Boolean(j.id),
  describe: 'the job accepted for running',
  name:     'the command is dispatched',
})) ) return

// The dispatch is durable work: the call answers as soon as the job is queued,
// so the ANSWER is polled rather than awaited.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, `/jobs/${job.json.id}`),
  headers:  as,
  expect:   (j) => j.lastRunStatus === 'success',
  describe: 'a run that finished',
  retries:  40,
  everyMs:  500,
  name:     'the machine answered, and the run succeeded',
}), {
  likely:    'the command was refused before it left — no placement, or no outpost target for the machine',
  reproduce: `curl -s ${hubUrl(context, `/jobs/${job.json.id}`)}`,
  detail:    serverLog(context.config.__servers?.outpost ?? { logPath: '' }),
})) return

// The database rather than the API, and that is the whole point of this line:
// the answer is read out of the row the control plane wrote, and it has to
// contain a string that was invented in this process a second ago.
if (!await must(context, probe.sqliteRow({
  db:     context.config.dbFile,
  sql:    'select output from job_run where jobId = ? order by rowid desc limit 1',
  params: [job.json.id],
  expect: (rows) => String(rows[0]?.output ?? '').includes(nonce),
  name:   'and what it said came from this machine',
}), {
  likely: 'the run succeeded but recorded nothing — the executor answered without running the command',
})) return

log.info('')
log.info(`  echo ${nonce}   ran on this machine, sent by the control plane, signed with the fleet secret`)

remember(context, '06-command', { appId, jobId: job.json.id, nonce })
```
