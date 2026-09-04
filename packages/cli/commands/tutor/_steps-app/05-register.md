---
title: 05-register
description: Make an account, and get a token back
---

## An account

`fli new --auth` installed `@frontierjs/auth`, which is why the app already has
`/api/auth/register`, `/api/auth/login`, sessions, API keys and a password
reset — none of which is in `api/`, and none of which you will maintain.

Registering answers a **token**. Everything after this step carries it, because
`model User` is gated at `4` for writes: a caller with no token is a stranger,
and a stranger is refused before any code you wrote runs.

The account is real. You can sign in with it at
`http://127.0.0.1:{{webPort}}/login/`.

```js
if (!await narrate(context)) return

context.config.__step = 5

if (!needs(context, ['appDir'], { from: '02-new' })) return

// A run-scoped address. A fixed one passes exactly once and then collides on
// `email @unique` — and because User soft-deletes, deleting the row through the
// API would not free the value either (FJS-530).
const email    = `ada-${Date.now().toString(36)}@acme.test`
const password = 'correct-horse-battery-staple'

if (!await must(context, await ensureApi(context), {
  likely:    'nothing is answering on the API port — run the lesson from the start, or `bun run dev` in the app',
  reproduce: `cd ${context.config.appDir} && PORT=${context.config.apiPort} bun run start`,
})) return

const registered = await probe.httpJson({
  url:     apiUrl(context, '/auth/register'),
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body:    JSON.stringify({ email, password, name: 'Ada' }),
  expect:   (j) => typeof j.token === 'string' && j.token.length > 0,
  describe: 'a session token in the body',
  name:     'POST /api/auth/register answers a token',
})

if (!await must(context, registered, {
  likely:    'auth is not installed in this app — fli new was run without --auth',
  reproduce: `curl -sS -X POST ${apiUrl(context, '/auth/register')} -H 'content-type: application/json' -d '{"email":"${email}","password":"…","name":"Ada"}'`,
})) return

const token = registered.json.token

log.info(`signed up as ${email}`)
remember(context, '05-register', { email, password, token })
```
