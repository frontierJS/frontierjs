---
title: 03-people
description: Two callers — a user and an administrator
---

## Two callers

Every assertion after this is a **pair**: the same request, twice, differing in
one thing. So the lesson needs two accounts.

The ordinary one registers through the API, the way anybody would. The
administrator does not — `role` is `@allow('write', auth().isAdmin)`, so an
account cannot make itself one, which is the point of that line. The way in is
the CLI, which writes through `asSystem()` and is above the ladder entirely:

```console
fli auth:create-user boss@example.test --role admin
```

That asymmetry *is* the lesson, arriving early: the first administrator comes
from the machine, not from the API.

```js
if (!await narrate(context)) return

context.config.__step = 3

if (!needs(context, ['appDir'], { from: '01-app' })) return

if (!await must(context, await ensureApi(context), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

// Run-scoped, because `email` is @unique on a soft-deleting model: a fixed
// address passes once and then collides with a row the API cannot free.
const run      = Date.now().toString(36)
const password = 'correct-horse-battery-staple'
const user     = `ada-${run}@example.test`
const admin    = `boss-${run}@example.test`

const registered = await registerAccount(context, { email: user, password, name: 'Ada' })
if (!await must(context, registered, {
  likely: 'auth is not installed in this app',
})) return

context.exec({
  command: `${context.fli} auth:create-user ${admin} --name Boss --role admin --password ${password}`,
  cwd:     context.config.appDir,
})

const asAdmin = await signIn(context, admin, password)
if (!await must(context, asAdmin, {
  likely:    'auth:create-user did not write the account — its output is above',
  reproduce: `cd ${context.config.appDir} && fli auth:create-user ${admin} --role admin --password …`,
})) return

// The standing is asserted, not assumed. `isAdmin` is what every policy below
// is written against, and an account that is merely NAMED admin would make all
// four of them pass for the wrong reason.
if (!await must(context, probe.httpJson({
  url:      apiUrl(context, '/auth/login'),
  method:   'POST',
  headers:  { 'content-type': 'application/json' },
  body:     JSON.stringify({ email: admin, password }),
  expect:   (j) => j.user?.isAdmin === true,
  describe: 'a session that grades as an administrator',
  name:     'the admin account really is one',
}), {
  likely: 'role was written but the session does not read it — check sessionFields in api/src/core/auth.ts',
})) return

log.info(`  user   ${user}`)
log.info(`  admin  ${admin}`)

remember(context, '03-people', {
  user, admin, password,
  userToken:  registered.json.token,
  adminToken: asAdmin.json.token,
})
```
