---
title: db:tinker
description: A console that boots at a gate level — db scoped to a principal, sys for everything else
alias: tinker
examples:
  - fli tinker
  - fli tinker --as alice@example.com
  - fli tinker --level 4
  - fli tinker --as alice@example.com --gate ./api/gate.ts
flags:
  as:
    char: a
    type: string
    description: Boot as this person — an email, username, name or id in the @@auth model, or Model:value
    defaultValue: ''
  level:
    char: l
    type: string
    description: Boot at a synthetic standing 0-9 with no user, for walking the gate ladder
    defaultValue: ''
  gate:
    char: g
    type: string
    description: The app's own getLevel — path[#export]. Without it the console grades with the default resolver
    defaultValue: ''
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

const opts = [
  flag.as    ? `--as ${flag.as}`       : '',
  flag.level ? `--level ${flag.level}` : '',
  flag.gate  ? `--gate ${flag.gate}`   : '',
].filter(Boolean).join(' ')

await context.stream({
  command: `${litestone(context)} repl --schema ${schema} ${opts}`,
})
```

## What it is

Rails has `rails c`, Laravel has `artisan tinker`, Django has `shell`. Each is the
tool people reach for first when production is wrong and second when learning the
framework.

Every one of them is **god-mode by construction**. That is not a choice those
frameworks made — authorization lives in their controller layer, and a console
calls the model *underneath* it, so there is no standing for a console to have.

Here access is declared at the Data boundary, so a console can boot as somebody:

```
$ fli tinker --as alice@example.com --gate ./api/gate.ts

  Standing:   alice@example.com(4) USER
  Graded by:  ./api/gate.ts

alice@example.com(4) > await db.order.create({ data: { total: 1 } })
  AccessDeniedError: "Order.create" requires level 5, user has level 4
```

That refusal is the real one. It is the same `@@gate` the app is refused by,
evaluated by the same plugin, because the console is a client and not a back
door.

## Two names, and they are different clients

- **`db`** — the standing you asked for.
- **`sys`** — `asSystem()`, which bypasses every gate, row policy and field lock.

`sys` is reachable on purpose. Refusing it means people run a one-off script
instead, which is the same power with none of this in front of it.

## Three standings, and two of them are not the same thing

| | What it does |
| --- | --- |
| *(nothing)* | anonymous — `STRANGER(0)`, which most gated models refuse |
| `--as <who>` | a real row, graded by a **resolver** |
| `--level <n>` | a synthetic standing, no user, no resolver asked |

`--as` and `--level` are deliberately separate, the same split `createTestEnv`
keeps between `actingAs` and `atLevel`. A ladder walked with `--level` says
nothing about whether the app's own resolver works, because it was never called.
And a synthetic standing has **no `auth()`**, so every `auth().id ==` row policy
matches nothing and its model answers an empty list rather than refusing — which
the console says out loud, because the two are indistinguishable from the result.

## `--gate` is not optional if your app installs a resolver

Without it the console grades with `FrontierGateGetLevel`, the default. Measured
on `example`: the default grades `ops@acme.test` at **3 (CREATOR)** and the app's
own `shopGateLevel` grades the same row at **4 (USER)** — and `Order` is
`@@gate("0.4.4.5")`, so a create is refused in the console and permitted in the
app. A console that is *approximately* their session is worse than no console,
because you act on what it shows you.

```
--gate ./api/gate.ts               # getLevel, the default export, or the sole function
--gate ./api/gate.ts#shopGateLevel # or name it
```

## Where the schema does not say who people are

`--as` reads the `@@auth` model, or one called `User`. Where a schema marks
neither, it refuses and asks rather than guessing which table holds principals:

```
fli tinker --as Customer:ops@acme.test
```

## What it is not, yet

`db` and nothing above it. A console over the app's **services** — hooks, the
result envelope, custom methods — is `@frontierjs/testing`'s `as(user).service(name)`
handed to this prompt, and it needs the app booted rather than the schema read.
`asSystem()` is also not attributed to the operator here; that is the same
question `IDEAS/compliance-from-the-seed.md` asks about support mode, and it
should be answered once for both.
