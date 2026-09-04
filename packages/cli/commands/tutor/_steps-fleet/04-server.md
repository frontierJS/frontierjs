---
title: 04-server
description: The machine as a row, before anything is on it
---

## A machine, as a noun

A **Server** is a place (`FJS-D29` — infrastructure takes place nouns), and the
row exists before the machine does anything. It is created here with a name and
an address and nothing else, and it comes into the world at `pending`: not
broken, not unreachable — *nobody has heard from it*.

Two of its columns are the ones this lesson is about, and both are empty:

```console
status            pending
lastHeartbeatAt   null
```

Nothing you can type moves them. They are the machine's to write, and it writes
them by running an Outpost — which is the next step.

Every request from here on carries two things: a bearer token, and
`x-workspace-id`. The second one is not decoration. Basecamp's standing is per
workspace, so the header is how a caller says *which of my memberships am I
acting under* — the same request with a workspace the caller is not a member of
is a different answer.

```js
narrate(context)

context.config.__step = 4

if (!needs(context, ['token', 'workspaceId', 'secret', 'basecamp'], {
  from: { token: '03-setup', workspaceId: '03-setup', secret: '02-basecamp', basecamp: '01-machine' },
})) return

if (!await must(context, await ensureFleet(context), {
  likely: 'the control plane is not answering — run this lesson from the start',
})) return

const as = {
  'content-type':   'application/json',
  authorization:    `Bearer ${context.config.token}`,
  'x-workspace-id': context.config.workspaceId,
}

const created = await probe.httpJson({
  url:      hubUrl(context, '/servers'),
  method:   'POST',
  headers:  as,
  body:     JSON.stringify({ name: 'tutorial-box', region: 'custom', ipAddress: '127.0.0.1' }),
  expect:   (j) => j.status === 'pending' && j.lastHeartbeatAt === null,
  describe: 'a server nobody has heard from',
  name:     'the machine exists as a row, at pending',
})

if (!await must(context, created, {
  likely: 'the create was refused — an owner may create a server, so this is a standing problem',
})) return

const serverId = created.json.id

// The state the whole lesson turns on, asserted BEFORE it changes. Basecamp
// decides a machine is reachable by asking Conduit for a target — never by
// reading the row — so a run that had one left over from an earlier attempt
// would show step 5 passing for the wrong reason.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, '/conduit-targets'),
  headers:  as,
  expect:   (j) => !(j.data ?? []).some((t) => t.id === `outpost:${serverId}`),
  describe: 'no way to reach this machine',
  name:     'and there is nowhere to send it a command',
}), {
  likely: 'a target for this server is already registered — an outpost from an earlier run is still running',
})) return

log.info(`  server ${serverId}`)

remember(context, '04-server', { serverId })
```
