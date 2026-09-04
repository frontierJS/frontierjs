---
title: 03-setup
description: The first account, and the workspace it owns
---

## The first person

Somebody has to be first, and the first person is a problem every control plane
has: the screen that grants an administrator is behind an administrator. So
`POST /setup` exists, it works exactly once, and it is refused with a 409 the
moment there is an active user.

One request makes four rows in one transaction — an account, a user, a
workspace, and the membership that ties the last two together — and answers with
a session. A half-built control plane is worse than none, which is why it is one
transaction rather than four calls.

The membership is the part worth looking at. Basecamp's standing is **per
workspace**, not per person: `WorkspaceMember.role` is what grades a caller, so
the same account is an owner in one workspace and a viewer in another. That is
the same `@@gate` ladder from lesson 2, resolved one row further out.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['dbFile', 'secret', 'basecamp'], {
  from: { dbFile: '02-basecamp', secret: '02-basecamp', basecamp: '01-machine' },
})) return

if (!await must(context, await ensureFleet(context), {
  likely: 'the control plane is not answering — run this lesson from the start',
})) return

// Asserted as a PAIR with the one below it, and that is what makes either
// worth making: a probe that always answered `needs_setup` would pass one of
// them, and a setup route that wrote nothing would pass the other.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, '/setup/probe'),
  expect:   (j) => j.needs_setup === true && j.users === 0,
  describe: 'a control plane with nobody in it',
  name:     'nobody has ever signed in here',
}), {
  likely: 'the database already has rows in it — pass --restart, or a different --workspace',
})) return

const email    = `sam-${Date.now().toString(36)}@example.test`
const password = 'correct-horse-battery-staple'

const setup = await probe.httpJson({
  url:      hubUrl(context, '/setup'),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ workspace_name: 'Tutorial Fleet', name: 'Sam', email, password }),
  expect:   (j) => Boolean(j.token && j.workspace_id),
  describe: 'a session and the workspace it was made in',
  name:     'the first account is made and signed in',
})

if (!await must(context, setup, {
  likely:    'setup has already run against this database — pass --restart',
  reproduce: `curl -s ${hubUrl(context, '/setup/probe')}`,
})) return

// The same question the step before asked, answered the other way. A setup
// route that reported success while writing nothing would pass the assertion
// above and fail this one.
if (!await must(context, await probe.httpJson({
  url:      hubUrl(context, '/setup/probe'),
  expect:   (j) => j.needs_setup === false && j.workspaces === 1,
  describe: 'a control plane with one workspace in it',
  name:     'it no longer needs setting up',
}), {
  likely: 'the setup route answered but the rows are not there',
})) return

log.info(`  ${email}`)
log.info(`  workspace ${setup.json.workspace_id}`)

remember(context, '03-setup', {
  email, password,
  token:       setup.json.token,
  workspaceId: setup.json.workspace_id,
})
```
