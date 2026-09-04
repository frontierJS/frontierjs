---
title: 05-outpost
description: The machine reports in, and becomes reachable
---

## The Outpost

An Outpost is the process a fleet server runs. It is deliberately **not** a
FrontierJS app — its job is to run Docker commands and answer questions about a
machine, and an app would put a schema, a migration runner and an ORM on every
server in the fleet to do that.

It takes three things with no defaults, and refuses to start without any of
them:

```console
OUTPOST_SERVER_ID   which row it is — one that cannot name its server reports as nobody
OUTPOST_SECRET      the fleet secret — one without it accepts every command, or none
BASECAMP_URL        where to report
```

`OUTPOST_PUBLIC_URL` is the fourth and it is **stated rather than derived**,
because a process cannot see the address the world reaches it at. It is what the
heartbeat registers, and until it lands the control plane will refuse to release
anything to this machine — with a sentence saying so, rather than a green deploy
that ran nothing.

Watch what the heartbeat moves. `status` goes to `online` and `lastHeartbeatAt`
fills in, which is the row. But *reachable* is not on the row: the address
becomes a **Conduit target** called `outpost:<id>`, and that is the thing
everything outbound looks up. A machine can be `online` in the list and have
nowhere to send a command, and those are two different failures.

```js
narrate(context)

context.config.__step = 5

if (!needs(context, ['serverId', 'secret', 'outpost', 'basecamp', 'token', 'workspaceId'], {
  from: {
    serverId: '04-server', secret: '02-basecamp',
    outpost: '01-machine', basecamp: '01-machine',
    token: '03-setup', workspaceId: '03-setup',
  },
})) return

const publicUrl = `http://127.0.0.1:${context.config.outpostPort}`

if (!await must(context, await ensureFleet(context), {
  likely: 'the control plane is not answering — run this lesson from the start',
})) return

const machine = await startOutpost(context)

if (!await must(context, machine.up, {
  likely:    'the outpost refused to start — it names the variable it wanted',
  reproduce: `cd ${context.config.outpost} && OUTPOST_SERVER_ID=${context.config.serverId} OUTPOST_SECRET=… BASECAMP_URL=${hubUrl(context)} bun run start`,
  detail:    serverLog(machine),
})) return

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}

// Polled rather than slept on: the first heartbeat goes out as the process
// starts, so this is normally answered on the first try, and a machine whose
// clock or secret is wrong is answered by the same request never changing.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, `/servers/${context.config.serverId}`),
  headers:  as,
  expect:   (j) => j.status === 'online' && Boolean(j.lastHeartbeatAt) && Boolean(j.outpostVersion),
  describe: 'a machine that has reported in',
  retries:  20,
  everyMs:  500,
  name:     'the machine is online, and said which outpost it runs',
}), {
  likely:    'the heartbeat is being refused — the two ends disagree about the fleet secret',
  reproduce: `curl -s ${hubUrl(context, `/servers/${context.config.serverId}`)}`,
  detail:    serverLog(machine),
})) return

// The health block is the second half of the same check and it is worth its own
// line: a heartbeat that arrived carrying nothing would move `status` on its
// own, and a fleet screen would then show a machine that is up and blank.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, `/servers/${context.config.serverId}`),
  headers:  as,
  expect:   (j) => typeof j.health?.memory === 'number' || typeof j.health?.load === 'number',
  describe: 'a machine that said how it is doing',
  name:     'and it reported the load and memory it is under',
})) ) return

if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, '/conduit-targets'),
  headers:  as,
  expect:   (j) => (j.data ?? []).some((t) => t.id === `outpost:${context.config.serverId}` && t.address === publicUrl),
  describe: `a target at ${publicUrl}`,
  name:     'and there is now somewhere to send it a command',
}), {
  likely: 'the heartbeat landed but registered no address — OUTPOST_PUBLIC_URL was not set',
})) return

remember(context, '05-outpost', { publicUrl })
```
