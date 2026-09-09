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
OUTPOST_SECRET      this machine's OWN key, learned by enrolling
BASECAMP_URL        where to report
```

**The secret is per machine, and getting one is a step of its own.** There is no
fleet-wide key that also works: one string every machine holds means a
compromised box can forge any other machine's check-in, and two accepted keys
means the weaker one is the one an attacker uses. So a machine that has not
enrolled is refused — with one sentence for every refusal, because telling *no
such machine* apart from *that signature is wrong* tells an unauthenticated
caller which server ids are real.

Enrolling is an exchange, and it happens twice below. `issueEnrollment` mints a
**single-use** token and prints the command an operator would paste on a real
box; `POST /servers/{id}/enroll` takes that token once and answers with the
secret. The token is burned inside the same statement that reads it, so two
machines racing the same token means exactly one enrolls. On a provisioned
machine cloud-init does this and nobody types anything; here the lesson does what
`install.sh` does, minus Docker, Bun and a systemd unit.

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
if (!await narrate(context)) return

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

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}

// ── the exchange ──────────────────────────────────────────────────────────
// Two calls, because they are two different callers. `issueEnrollment` is the
// OPERATOR, at gate 5, saying this machine may join the fleet; the enroll route
// is the MACHINE, unauthenticated by definition, spending the token it was
// given. Running them as one call would be a control plane that hands out
// credentials to whoever asks.
const issued = await probe.httpJson({
  url:      hubUrl(context, `/servers/${context.config.serverId}`),
  method:   'POST',
  headers:  { ...as, 'x-service-method': 'issueEnrollment' },
  expect:   (j) => typeof j.token === 'string' && j.token.length > 0 && typeof j.command === 'string',
  describe: 'a single-use enrollment token, and the command that spends it',
  name:     'the operator issues this machine a credential',
})

if (!await must(context, issued, {
  likely: 'issueEnrollment was refused — it is gate 5, the same rung as provision and destroy',
})) return

// No bearer and no workspace header, deliberately: this is the machine, and it
// has nothing to authenticate with yet. That is the whole reason the token is
// single-use and lives fifteen minutes.
const enrolled = await probe.httpJson({
  url:      hubUrl(context, `/servers/${context.config.serverId}/enroll`),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ token: issued.json.token }),
  expect:   (j) => typeof j.secret === 'string' && j.secret.length > 0,
  describe: 'the machine trades its token for a key of its own',
  name:     'and the machine spends it, once',
})

if (!await must(context, enrolled, {
  likely:    'the exchange was refused — every refusal here says the same sentence on purpose',
  reproduce: `curl -s -X POST ${hubUrl(context, `/servers/${context.config.serverId}/enroll`)} -H 'content-type: application/json' -d '{"token":"…"}'`,
})) return

// The negative control, and it is the claim rather than tidiness: a token that
// still worked the second time would pass every assertion above and leave the
// burn untested. Replayed with the SAME token, which is what a retry or a
// second machine reading the same metadata blob would send.
if (!await must(context, await probe.httpStatus({
  url:      hubUrl(context, `/servers/${context.config.serverId}/enroll`),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ token: issued.json.token }),
  expect:   401,
  name:     'and it is worth nothing the second time',
})) ) return

context.config.outpostSecret = enrolled.json.secret

const machine = await startOutpost(context)

if (!await must(context, machine.up, {
  likely:    'the outpost refused to start — it names the variable it wanted',
  reproduce: `cd ${context.config.outpost} && OUTPOST_SERVER_ID=${context.config.serverId} OUTPOST_SECRET=… BASECAMP_URL=${hubUrl(context)} bun run start`,
  detail:    serverLog(machine),
})) return

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

remember(context, '05-outpost', { publicUrl, outpostSecret: enrolled.json.secret })
```
