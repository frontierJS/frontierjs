---
title: 03-account
description: One account, because a socket has to be somebody
---

## Somebody, and nobody

Two clients are needed and they differ in exactly one way: one holds a session
and the other holds nothing. So one account is registered here, and the second
client is the absence of it.

The token rides the **upgrade**, never a frame, and never the URL either,
because a URL is what a console, a proxy and an access log record. A browser
socket cannot set `Authorization`, so it offers the token as a subprotocol:

```console
Sec-WebSocket-Protocol: fjs, fjs.bearer.…
```

A connection's identity is established once, when it is made. A frame that could
name its own principal would be a frame that could name anybody's — which is
also why a header a caller varies per call has to be declared before it is
allowed to ride one.

```js
if (!await narrate($)) return

$.config.__step = 3

if (!needs($, ['appDir'], { from: '01-app' })) return

if (!await must($, await ensureApi($), {
  likely: 'nothing is answering on the API port — run this lesson from the start',
})) return

// Run-scoped, because `email` is @unique on a soft-deleting model: a fixed
// address passes once and then collides with a row the API cannot free.
const run      = Date.now().toString(36)
const password = 'correct-horse-battery-staple'
const user     = `ada-${run}@example.test`

const registered = await registerAccount($, { email: user, password, name: 'Ada' })
if (!await must($, registered, {
  likely: 'auth is not installed in this app',
})) return

log.info(`  signed in as   ${user}`)
log.info('  and nobody     — the second client holds no token at all')

remember($, '03-account', { user, password, userToken: registered.json.token })
```
