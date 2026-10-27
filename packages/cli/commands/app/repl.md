---
title: app:repl
description: A prompt inside the booted app as somebody — call, as, sys, db and app in scope, no server
examples:
  - fli app:repl --as alex@shop.test --tenant flagship
  - fli app:repl -e 'call("products.find", { $limit: 1 })' --as alex@shop.test --tenant flagship
  - fli app:repl -e 'db.order.count()' --as alex@shop.test --tenant flagship
  - fli app:repl --app api/src/app.ts --as ann@x.test
flags:
  eval:
    char: e
    type: string
    description: Evaluate one line, print the answer as JSON on stdout, exit 1 if it throws — no prompt
    defaultValue: ''
  as:
    char: a
    type: string
    description: Stand as this person — an email, username, name or id in the @@auth model, or Model:value
    defaultValue: ''
  tenant:
    char: t
    type: string
    description: Whose database, under tenancy { strategy database }
    defaultValue: ''
  force:
    type: boolean
    description: Let sys write under NODE_ENV=production
    defaultValue: false
  app:
    type: string
    description: The app module — without it, the one the committed app.snapshot.md names
    defaultValue: ''
  export:
    type: string
    description: Which export of the module is the app, when it has more than one
    defaultValue: ''
---

```js
const { callArgv } = await import(new URL('file://' + global.fliRoot + '/core/app-entry.js'))
const { spawnSync } = await import('node:child_process')

const plan = callArgv($.paths.root, {
  app:        flag.app,
  exportName: flag.export,
  as:         flag.as,
  tenant:     flag.tenant,
  code:       flag.eval,
  force:      flag.force,
})
if (plan.error) {
  log.error(plan.error)
  process.exitCode = 1
  return
}

// Inherited, not piped: the prompt needs the terminal, and `-e`'s answer is
// the child's stdout alone.
const run = spawnSync('bun', plan.argv, { cwd: plan.cwd, stdio: 'inherit' })
if (run.error?.code === 'ENOENT') {
  log.error('bun not found — junction is Bun-only, so the prompt needs bun on PATH')
  process.exitCode = 1
  return
}
process.exitCode = run.status ?? 1
```

## What it is

`fli call` kept open. The app boots once in this process, the way `app:call`
boots it — a second boot beside any dev server, not attached to it, so a write
here reaches none of that server's sockets (`FJS-D1535`) — and a prompt runs
over it at the standing `--as` names:

```
$ fli app:repl --as alex@shop.test --tenant flagship
  Standing: alex@shop.test (User 06fc3ec1-…) · tenant flagship

alex@shop.test · flagship > await call('orders.find', { status: 'paid', $limit: 2 })
alex@shop.test · flagship > as()
nobody · flagship > await db.order.count()
  AccessDeniedError: …
```

| Name | Is |
| --- | --- |
| `call(method, ...args)` | one method at the session standing — the request's hooks, gate and envelope, as `fli call` runs it |
| `as(who)` | switch the standing; `as()` is nobody. An unknown name is refused and the standing kept |
| `db` | the data client at the session standing |
| `sys(fn)`, `sys.<model>.<method>()` | run as the app's own principal, every gate off — `db:repl`'s `sys` |
| `app` | the booted app |

`.help` lists them, `.standing` prints the whole standing, `.exit` stops the
app. History is `~/.junction_call_history`.

**Who, which app, what the boot skips** are `app:call`'s answers: no `--as` is
nobody (`STRANGER(0)`), never the app itself; the module is `--app` or the
committed `app.snapshot.md` header; no plugin's `work()` runs.

## `-e`

One line, then exit — `db:repl`'s contract. The answer is JSON on stdout and
nothing else is; the standing and a refusal go to stderr, and a throw exits 1.
A refused `call` throws as `<name> (<status>)`.

## Production

Under `NODE_ENV=production` the prompt line opens with `PRODUCTION`, and `sys`
answers a read but refuses a write, `sys.$transaction` and `sys(fn)` until the
command carries `--force` (`FJS-D1533`). It guards a slip, not an operator:
`app.runAs(null, …)` is in scope and walks past it.

**A `sys` write is filed under you**: `$USER` as the trail's `actorId`,
`actorType: 'repl'` — never the `--as` standing, which is whose view you read.
A `call` or `db` write is the standing's (`FJS-D1534`).

**Not `db:repl`.** That one reads the schema and grades with a resolver it is
handed (`--gate`); this one boots the app, so gate, tenancy and the principal
lookup are the app's own, and there is no `--gate` to pass (`FJS-D1532`,
`FJS-D1536`).

**Needs bun.** Junction is Bun-only, and this runs the app's own `junction call`, resolved the way its imports resolve it.
