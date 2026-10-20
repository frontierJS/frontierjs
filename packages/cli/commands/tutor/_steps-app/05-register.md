---
title: 05-register
description: Make an account, follow its link, and get a token back
---

## An account

`fli new --auth` installed `@frontierjs/auth`, which is why the app already has
`/api/auth/register`, `/api/auth/login`, sessions, API keys and a password
reset — none of which is in `api/`, and none of which you will maintain.

Registering answers **202** and no token. The app mails a verification link —
`api/src/core/auth.ts` wires `onEmailVerificationRequested` — so register says
the same thing for an address that already has an account as for a free one,
and a stranger cannot learn who has signed up. The account does not exist yet.
It is made when the link is followed, and following it signs you in.

There is no mailer yet, so the link is printed in the API's output instead:

```text
[auth] verify ada-…@acme.test — no mailer, so here is the link:
  http://127.0.0.1:{{webPort}}/verify-email/#token=…
```

That page posts the token to `/api/auth/email/verify`, which answers what
`/api/auth/login` does: a **token**. In the browser the page keeps it and takes
you into the app signed in; this lesson keeps it the same way. Everything after
this step carries it, because `model User` is gated at `4` for writes: a caller
with no token is a stranger, and a stranger is refused before any code you
wrote runs.

The account is real, and the password you typed signs in with it at
`http://127.0.0.1:{{webPort}}/login/` from then on.

```js
if (!await narrate($)) return

$.config.__step = 5

if (!needs($, ['appDir'], { from: '02-new' })) return

// A run-scoped address. A fixed one passes exactly once and then collides on
// `email @unique` — and because User soft-deletes, deleting the row through the
// API would not free the value either (FJS-530).
const email    = `ada-${Date.now().toString(36)}@acme.test`
const password = 'correct-horse-battery-staple'

if (!await must($, await ensureApi($), {
  likely:    'nothing is answering on the API port — run the lesson from the start, or `bun run dev` in the app',
  reproduce: `cd ${$.config.appDir} && PORT=${$.config.apiPort} bun run start`,
})) return

// Three requests: register, read the link out of the API's output, post its
// token. The helper is the lesson module's, so every lesson that needs an
// account makes it the same way this one teaches.
const registered = await registerAccount($, { email, password, name: 'Ada' })

if (!await must($, registered, {
  likely:    registered.name?.startsWith('register')
    ? 'auth is not installed in this app — fli new was run without --auth'
    : 'the API did not print the verification link — api/src/core/auth.ts may not wire onEmailVerificationRequested',
  reproduce: `curl -sS -X POST ${apiUrl($, '/auth/register')} -H 'content-type: application/json' -d '{"email":"${email}","password":"…","name":"Ada"}'`,
})) return

const token = registered.json.token

log.info(`signed up as ${email}`)
remember($, '05-register', { email, password, token })
```
