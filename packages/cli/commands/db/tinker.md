---
title: db:tinker
description: A console that boots at a gate level — db scoped to a principal, sys for everything else
alias: tinker
examples:
  - fli tinker
  - fli tinker --as alice@example.com
  - fli tinker --level 4
  - fli tinker --as alice@example.com --gate ./api/gate.ts
  - fli tinker -e 'db.order.count()' --as alice@example.com
flags:
  eval:
    char: e
    type: string
    description: Evaluate one line, print the answer as JSON on stdout, exit 1 if it throws — no prompt
    defaultValue: ''
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
  tenant:
    char: t
    type: string
    description: Whose database, under tenancy { strategy database }. Omitted at a terminal, it lists them and asks
    defaultValue: ''
---

```js
if (!requireSchema(context)) return

const { schema } = resolveDb(context, flag)

// Quoted because the command runs through a shell, and an expression is the
// one value here certain to hold a space, a quote or a `$`.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

const opts = [
  flag.as     ? `--as ${q(flag.as)}`         : '',
  flag.level  ? `--level ${q(flag.level)}`   : '',
  flag.gate   ? `--gate ${q(flag.gate)}`     : '',
  flag.tenant ? `--tenant ${q(flag.tenant)}` : '',
  flag.eval   ? `--eval ${q(flag.eval)}`     : '',
].filter(Boolean).join(' ')

// The child always says why it stopped — a refusal, or the throw an `-e` line
// raised — so the exit code is passed on and the runner's own `Command failed`
// line, which would print the whole argv under it, is not.
await context.stream({
  command: `${litestone(context)} repl --schema ${schema} ${opts}`,
}).catch(() => { process.exitCode = 1 })
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

## Once, without a prompt

`-e` evaluates one line and exits — what a script or an agent wants instead of
`sqlite3` against the app's file, which answers with every gate switched off:

```
$ fli tinker -e 'db.order.count()' --as alice@example.com --gate ./api/gate.ts
  Standing: alice@example.com(4) USER · graded by ./api/gate.ts
3
```

The answer is JSON on stdout, so `| jq` reads it; the standing and any warning
go to stderr. A throw prints `Name: message` to stderr and exits 1, and a dot
command runs the same way (`-e '.purgeCarts 30'`). Under `strategy database` it
never asks which tenant — name one with `--tenant`.

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

## Under `strategy database`, which file

Each tenant is its own database and `main` holds the machinery — sessions, the
outbox — and none of the tenant's rows. A console on `main` answers
`count()` with 0 for a shop full of orders, which reads exactly like an empty
table, so it does not open there by default:

```
fli tinker --tenant flagship --as ops@acme.test
fli tinker                       # at a terminal: lists the tenants, 0 is main
```

Piped or scripted, with no `--tenant`, it refuses and names the known ones.
`--as` is looked up INSIDE the chosen tenant, since that is where its people are.

## Commands of your own

`db/tinker.js`, beside the schema, adds dot commands. It default-exports a
table of `{ help, run }`, and `.name a b` calls `run` with the session:

```
// db/tinker.js
import { resetPasswords } from '@frontierjs/auth/console'

export default {
  resetPasswords,
  purgeCarts: {
    help: 'delete baskets untouched for N days (default 30)',
    async run({ db, sys, args, out, tenant }) { … },
  },
}
```

`args` is the words after the name, `db` and `sys` are the two clients above,
and `tenant` is whichever one the console opened — so a command reaches one
tenant's rows and never the fleet's. `.help` lists them. A malformed file stops
the console before it opens rather than starting without the command, and
`.help`, `.standing` and `.exit` cannot be taken.

`resetPasswords` is auth's rather than a copy in the app because the hash is
auth's: a bcrypt call written in an app writes hashes the next auth release may
not verify. It sets every `password` credential, leaves an OAuth-only account
without one, and refuses under `NODE_ENV=production` unless given `--force`.

## What it is not, yet

`db` and nothing above it. One call to a **service** — hooks, the result
envelope, custom methods — is `fli call`; a console over them is
`@frontierjs/testing`'s `as(user).service(name)` handed to this prompt, and it
needs the app booted rather than the schema read.
`asSystem()` is also not attributed to the operator here; that is the same
question `IDEAS/compliance-from-the-seed.md` asks about support mode, and it
should be answered once for both.
