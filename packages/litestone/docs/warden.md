# Warden

**The Warden is FrontierJS's access system: everything that decides whether a call
may touch a row or a column.** It is declared in the schema and enforced at the Data
boundary, so every path that reaches a row meets the same rules. That includes a
service, a job, a static build and an agent over MCP (`FJS-D546`).

The Data boundary is *where* access is enforced, and the Warden is *what* enforces it.
This page is the map. Each layer's mechanics are in [access-control.md](access-control.md),
[multi-tenancy.md](multi-tenancy.md) and [encryption.md](encryption.md). Why each rule
has the shape it has is in `DECISIONS.md`, cited by id.

## One call, top to bottom

A call passes down through these layers. The ones marked `●` are the Warden, and the
others are the rest of the call, shown so you can see where the Warden sits. The order
is the concept, not an API: the phase order under the verbs stays private through
alpha (`FJS-D267`).

```
    layer         asks                   declared with                    on refusal
  ● 1 principal   who is asking          $setAuth(user) → scoped client   —
  ● 2 gate        what kind of caller    @@gate("2.4.4.5")                throws
  ● 3 capability  which action           @@capabilities, @capability      throws
  ● 4 row policy  whose row              @@allow · @@deny · tenancy       filters (create throws)
  ● 5 field       which columns          @guarded @encrypted @system …    throws · drops · strips
    6 validate    is it well-formed      unknown keys, validators         throws
  ◐ 7 transition  is this move allowed   @@transitions, a move's @gate    throws
    8 execute     SQLite                 CHECK, unique, foreign key       throws
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ Litestone ends here ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
    9 announce    who hears about it     Junction, graded per recipient   —
```

Layer 7 is half-marked `◐` because a move has two halves. Who may make a move is
authority, and that half is the Warden. Which moves exist is integrity, and that half
is not. The `asSystem()` section below depends on that split.

**How each layer fails is deliberate.** A layer that reads nothing (the gate or a
capability) throws, because its refusal discloses only the schema. A layer that reads
the row filters, because a refusal would confirm the row exists. Create is the
exception: the payload *is* the row, so there is nothing to hide, and it throws. The
measured table of every declaration against every verb is
[access-control.md § Combining them](access-control.md#combining-them--what-refuses-what-goes-quiet-and-why).

## The layers

- **1 · Principal.** `db.$setAuth(user)` returns a new client, and every rule below reads
   `auth()` off it. A claim is declared, never guessed (`FJS-D181`). The value can come
   from another row: `claim role from Membership(userId).role` (`FJS-D359`). A tenant
   and a standing are both claims on the principal, resolved per request by one seam
   in Junction (`FJS-D113`). A principal with no `id` grades STRANGER before any
   `getLevel` runs (`FJS-D515`).
- **2 · Gate.** A level per operation on the 0–9 ladder, read.create.update.delete. It is
   enforced whenever it is declared, and a model without one is open (`FJS-D53`). The
   levels must keep read ≤ update ≤ delete and create ≤ delete (`FJS-D491`). `8` means
   `asSystem()` and nothing else, so use it for credential material, not for `User`
   (`FJS-D47`). The ladder, its comparison and its grader are one kit,
   `@frontierjs/toolbelt/gate` (`FJS-D197`).
- **3 · Capability.** A capability refers to something the schema already declares, such
   as a move, an operation or a column. It is never an entry in a hand-kept list
   (`FJS-D139`). Capabilities are ANDed with the gate, and the gate is the floor, so a
   model that opts in usually lowers its gate to the read level (`FJS-D146`).
- **4 · Row policy.** `@@allow` rules are ORed and admit only on TRUE. `@@deny` fires on
   TRUE or UNKNOWN, and an absent claim is UNKNOWN. Policies compile to SQL for reads
   and updates and to JS for creates, and the two halves must agree. A policy may reach
   one relation away, not two: a column of a to-one (`FJS-D221`), or whether some row of
   a to-many matches (`FJS-D566`). Row tenancy compiles to `@@deny` and never
   to `@@allow`, so no extra allow rule can widen it (`FJS-D05`). A null tenant column
   belongs to nobody. A model whose rows are shared across tenants declares
   `@@tenant(none)` (`FJS-D141`).
- **5 · Field.** Two independent axes. *Visibility* asks whether this caller may see the
   column: `@hashed`, `@encrypted`, `@guarded`, a field `@allow('read', …)`. The
   strictest word wins, and nothing widens it. *Inclusion* asks whether the column is
   in the default payload: `@omit`. Naming the column in `select` unlocks inclusion
   only (`FJS-D205`). A field predicate is compiled into SQL, never evaluated against
   the payload (`FJS-D129`). On a write, `@guarded` and `@system` throw, and a field
   `@allow('write')` drops the key, because the same form body is legitimate for
   someone else (`FJS-D22`, `FJS-D427`).
- **7 · Transition authority.** A move's `@gate(n)` says who may ask for it, and
   `@system` says the application makes it. A move asked for by name grades the
   caller before it reads the row's state (`FJS-D150`, `FJS-D432`).

## `asSystem()` lifts the Warden and holds integrity

The line runs between *authority* (who may) and *integrity* (what must be true).
`asSystem()` is trusted about who. It is never trusted to break what (`FJS-D502`).

| Lifted: authority | Held: integrity |
| --- | --- |
| `@@gate` levels 0–8 | `@@gate` level 9, LOCKED |
| `@@allow` / `@@deny`, row tenancy included | soft-delete and template filters |
| `@guarded`, both directions | `@check`, `@@check`, `@@arc`, `@immutable` |
| a move's `@gate(n)` and `@system` | the `@@transitions` graph, its compare-and-swap, a create at `@default` (`FJS-D470`) |
| `@version`: a system write that read nothing has no stale view | `@hashed`: nobody reads it back |

**Narrower hatches keep the Warden on.** Choose the narrowest one that does the
job:

- `update({ …, system: ['col'] })` writes one `@system` column. It keeps the gate, the
  policies, soft-delete and the audit actor (`FJS-D22`). A `@guarded` column is named the
  same way: the write half opens for that call and the read half stays locked, which is
  how a grant's digest is written by the caller's own policy-graded create (`FJS-D819`).
- `create({ …, system: ['@@gate'] })` grades that one call SYSTEM against the model's own
  `@@gate`, for a row the application makes on a caller's behalf. It keeps the policies,
  redaction and the audit actor, and the trail entry carries `meta.lifted`. Nested
  writes, the returned row and the next call stay at the caller's level, and a 9 still
  refuses (`FJS-D575`). Any `system` entry outside these two kinds is refused by name.
- ``where: { $raw: sql`…` }`` puts raw SQL inside a `where`, and every policy is still
  ANDed around it.
- `db.asSystem()` turns the Warden off for one whole call.

`db.asSystem().sql` is the one bypass that also drops integrity, and its name says so.
It is for a fixture reset or a repair. Plain `db.sql` throws once a schema declares any
access rule (`FJS-D52`).

## The principles behind the rulings

Read across the rulings, the same few decisions keep recurring. When a new access
question comes up, one of these usually answers it.

- **Declared, never inferred.** Silence means "nothing": an undeclared gate imposes
  nothing, and a declared one always holds. Sharing is declared on the model, never
  read off a null (`FJS-D53`, `FJS-D141`, `FJS-D181`).
- **Refuse by name.** SQLite reads an unknown identifier as a string and matches
  nothing, so silence would be a wrong answer that looks like a right one (`FJS-D169`,
  `FJS-D421`).
- **Throw where nothing was read, filter where the row was read** (`FJS-D146`,
  `FJS-D427`).
- **Enforce where the row is.** A predicate becomes SQL and a bound becomes a CHECK, so
  a seed, a migration and raw SQL are held too (`FJS-D129`, `FJS-D259`, `FJS-D506`).
- **Authority lifts, integrity holds** (`FJS-D502`).
- **One owner, and derive the rest.** Capabilities come from the model's own surface,
  and a form's hidden field comes from a create policy (`FJS-D139`, `FJS-D492`).

## Where the Warden reaches past Litestone

The Warden is declared and enforced here, and three other packages read it rather than
restating it. Each reader is a seam in the `bridge-index` skill:

- **Junction** resolves the principal's claims per request, grades a custom method
  against the same level (`db.$levelOf`, `FJS-D308`), and grades each broadcast per
  recipient through `db.$readAs` (`FJS-D175`).
- **Sierra** refuses to prerender a column a public page may not publish (`FJS-D496`,
  `FJS-D504`). Its `x-gate` is a UI affordance only, and the server enforces
  regardless (Invariant 6).
- **mcp** uses the Warden as an agent's permission model and decides tool visibility
  by the agent's level (`FJS-D258`).
