---
id: permission-sets
status: argued
dated: 2026-08-24
---

# Idea — Permission sets: the grid the ladder cannot express

**Status: ARGUED, with one thing RULED.** No part of this is declared syntax, and
one part of it already runs. `FJS-D139` settles the shape of a capability — a
reference to something the seed already declares, never a name in a list — which is
the one decision here that a shipped application could not take back, and
`FJS-D140` settles which operations a declaration covers.
Dated 2026-08-24, from an audit of
[open-mrp/api](https://github.com/open-mrp/api) — a real manufacturing ERP, 3,344 Go
files, 111 resource groups at its gateway — asking which of its capabilities an FJS
app could not reproduce. Most it could. This is the one where the framework is
missing a mechanism rather than an app missing code.

**Revised 2026-08-24 by probing rather than reading**, which moved two things: the
enforcement predicate already compiles and fails closed, and the custom-role half —
a customer inventing a position — needs no mechanism that does not exist. What is
genuinely missing narrowed to a vocabulary, a refusal shape, a snapshot section, an
affordance, and one operator.

**Revised again 2026-08-25 against an external review of the worked schema.** Three
things changed and one defect came out of it: a person holds several roles and the
first draft baked in one, the `builtIn` column was writable so a tenant
administrator could mint a role nobody could delete, and the escalation operator got
a name. `§ Directions considered and refused` is the other half of that review — the
plausible suggestions that would have cost the closed set or the refusal shape.

**Revised a third time 2026-08-25, and this pass took things away.** A capability
names one action, which deletes the enum rather than generating it; the residue of
service methods no binding could reach turned out to be empty, so the problem is
coarseness and not reach; the default opt-in is picked by which refusal is silent;
and the standing table keeps its ladder, for a reason that turned out to be a gap in
a shipped feature rather than a quirk of this design (`FJS-519`). Two defects were
found and fixed while probing per-column capabilities (`FJS-510`, `FJS-511`).

The `§ What already works`, `§ The whole shape, executed` and `§ Several roles`
sections carry executed output; **everything else here is unbuilt and none of it is
declared syntax today** — do not cite this file as describing behaviour, see
`VERIFYING.md`.

---

## The claim

**A `@@gate` is a ladder and it answers *how far up is this caller*. Authorization
in a business application is mostly a grid, and it answers *which nouns, and which
verbs on them*.** The two are not the same question and one does not encode the
other.

The ladder is right for the axis it was built for: anonymous → unverified →
verified → user → administrator → owner → sysadmin is genuinely ordered, and
`@@gate("2.4.4.5")` says something true and short that no grid says at all. What it
cannot say is that a billing clerk and a production planner are **both level 4 and
neither is above the other** — one may void an invoice and not touch a work order,
the other the reverse. On a ladder those two are the same caller.

## Five layers, and only the first three are RBAC

The words matter because *permission* otherwise does three jobs in one sentence.
Read downward; each layer knows nothing about the one above it.

| Layer | What it is | Where it lives |
| --- | --- | --- |
| **Capability** | one thing the code can enforce | `enum Permission`, the seed |
| **Capability set** | a bundle under a name a person picked | a `Role` row, per tenant |
| **Assignment** | this caller holds that bundle | a `Member` row |
| **Effective capabilities** | the flat union, resolved per request | `auth().perms` on the principal |
| **Enforcement** | may this caller do this to this row | `@@allow` / `@@require`, compiled to SQL |

**The enforcement layer does not know RBAC exists**, and that is the whole of why
this is worth building rather than a role column and some hooks. Today a capability
arrives from a role; tomorrow it may arrive from a group, a direct grant, a service
account or an API key, and nothing below `auth().perms` changes. The identifier is
`Permission` because that is the word a buyer asks the question in; *capability* is
the word this record reasons in.

## The evidence

OpenMRP carries five separate authorization tables, and reading them apart is the
useful part:

| Theirs | Shape | FJS today |
| --- | --- | --- |
| `roles` + `permission-groups` | verbs × nouns, assigned per user | **nothing declared** — the predicate compiles, see below |
| `account-group-product-line-access` | which subset of the catalogue an account group sees | `@@allow` |
| `customer-product-line-access` | the same, per customer | `@@allow` |
| `users-territories` | which subset of the map a rep sees | `@@allow` |
| account mode / sysadmin | ordered standing | `@@gate` |

**Three of the five are row subsets and FJS already does those better** — they are
`@@allow` predicates compiled into the WHERE, where OpenMRP hand-writes a join per
list endpoint and has a whole pattern doc (`performant-list-endpoint-patterns.md`)
about not getting it wrong. One is the ladder, which FJS has. The gap is exactly
one row wide, and it is the row every B2B buyer asks about on the first call.

## What already works, measured

**The table's `nothing` against the first row is too strong.** The predicate half of
a grid already compiles and already enforces. Probed 2026-08-24 against a real
client, not read off a file:

```lite
model Invoice {
  @@gate("2")
  @@allow('read',   'billing_read'  in auth().perms)
  @@allow('update', 'billing_write' in auth().perms)
}
```

```
reader  read : 1        perms ['billing_read']
nobody  read : 0        perms ['deploy_write']
noperms read : 0        no perms claim at all
reader update: refused, row untouched
updateMany   : { count: 0 }
```

`X in auth().list` compiles to `? IN (?, ?, …)` in `policy.js`, and a claim that is
absent or empty compiles to `0` — so **the mechanism fails closed by construction**,
which is the property that decides whether a grid is safe to build on at all.

**What this changes is the size of the work, not the argument.** Everything under
*why the obvious workaround is a trap* still holds; a hand-written predicate per
model still costs those four things. But what is missing is a vocabulary, a refusal
shape, a snapshot section and a client affordance — not an enforcement engine. The
`L`-sized version of this item is the wrong estimate.

**The repo's own evidence is sharper than OpenMRP's, because we own it.**
`packages/basecamp/api/src/core/gate.ts` grades `billing` to READER(2) beside
`viewer`, carrying the comment *reads everything, writes only billing* — a sentence
the ladder cannot enforce and nothing in the app does. Nothing has broken only
because basecamp has no billing model yet, which makes it a latent hole rather than
a bug. Beside it the role ladder is written out four separate times — `core/gate.ts`
on the gate scale, then `core/hooks.ts`, `services/api-keys` and `services/portal`
on a second 1–4 scale — which is Invariant 4 broken in this repo's largest
application, in exactly the place this record predicts it will break.

## Why the obvious workaround is a trap

The workaround is to push the grid into row policies: a `Permission` model, a join
table, and `@@allow('update', auth().id in editorIds)` on every model that needs it.
It works, and it costs four things that are the point of declaring access in the
seed at all:

- **A wrong grant is an empty screen with a 200.** `@@allow` filters, it does not
  refuse (`CLAUDE.md` § Live hazards). A ladder mistake throws and names the model;
  a grid mistake compiles into a WHERE and returns nothing, which reads as *there
  is no data* rather than *you may not*.
- **`fli test:access` goes blind.** `db/access.snapshot.md` is the whole declared
  surface, and `litestone access --from <ref>` grades what a branch did to who may
  do what. A grant that lives in **rows** is invisible to both: the snapshot sees
  one predicate that never changes, and widening a role is a `UPDATE` in production
  that no committed artefact can see. That is the mechanism `FJS-D131` exists to
  protect, given away.
- **`x-gate` has nothing to read.** Tool visibility for the agent surface, `can()`
  in the browser, a generated form hiding a control — all three ask *at this
  standing, may this operation happen*, and all three go quiet for a grid held in
  rows.
- **It is written 111 times.** One predicate per model, by hand, each a place to
  get it wrong.

## The FJS-shaped answer

**Declare the vocabulary in the seed; let rows only carry the assignment.** The set
of grants that can exist is a fact about the application and belongs beside the
models it names; who holds one is data and belongs in a table.

```
permissions {
  orders    read write void
  invoices  read write
  catalog   read
}

role planner  { orders.read  orders.write  catalog.read }
role clerk    { invoices.read invoices.write }
```

and on the model, once, rather than a predicate per operation:

```
model Order {
  ...
  @@gate("2.4.4.5")
  @@permission(orders)
}
```

The verbs map onto operations the way `@@gate`'s four positions already do, so a
model states its permission noun once and the read/write/void columns say which
operations each verb covers. **Both mechanisms apply and neither subsumes the
other**: the gate is the floor (a caller below it is refused regardless of grants),
the permission is the grid above it, and `@@allow` still narrows to rows. Three
questions, three answers, each in the place that already answers it.

What falls out for free once the vocabulary is declared:

- `db.$permissions(accessor)` — the sibling of `$protectedFields` and `$checkWhere`,
  same contract, on every flavour of client.
- `x-permissions` on the client beside `x-gate`, so `resource.can()` and the agent
  surface's tool projection both keep working — affordance only, the Data boundary
  enforces regardless (Invariant 6).
- A section in `db/access.snapshot.md`, so a role gaining `orders.void` is a diff in
  a pull request rather than a discovery in production, and `access --from` grades
  it on the same widens/narrows axis.
- One refusal shape. A missing grant throws and names the permission, so the
  empty-screen failure mode does not return. **This is why the declaration is not
  sugar over `@@allow` and must not be built as sugar** — the obvious
  implementation, desugaring `@@require(read: invoices_read)` into
  `@@allow('read', 'invoices_read' in auth().perms)`, inherits the exact failure
  this record opens by complaining about: `@@allow` filters, so a caller missing the
  grant is shown *no invoices* rather than told they need *View invoices*. The
  declaration is gate-shaped over a grid — a different owner of the translation from
  a thrown value to a status, in Invariant 4's sense — and `@@allow` stays the
  escape hatch beneath it for the row-scoped half, which is genuinely a filter.

## Custom roles — a customer inventing a position

The open question below asks whether a declared `role` block stops an application
letting a customer define their own. It does, and it should not: *Regional Billing
Lead* is a job title somebody invented on a Tuesday and no seed can hold it.

**The split that resolves it is the one value sets already made — a permission is a
schema fact and a role is data.**

| | Permission | Role |
| --- | --- | --- |
| Who authors it | a developer, in git | a tenant administrator, at runtime |
| Why there | a grant nothing enforces is a lie, so code must exist for it first | a bundle of grants under a name a person picked |
| Where it lives | the seed, closed set | a table, open set, per tenant |
| In `access.snapshot.md` | yes, and `access --from` grades it | no, and it must not be |

**The Data boundary never sees a role.** The resolver flattens a caller's role rows
into one permission set on the principal — the seam `membershipClaim()` already puts
a standing on — and every predicate below reads a flat list. A role is a screen and
a join, and nothing more.

### The whole shape, executed

Nothing here is new syntax. Every line below parses and enforces today.

```lite
// ─── capabilities: closed, in git, one member per thing the code enforces ──
enum Permission {
  /// See invoices and their lines.
  invoices_read   @label("View invoices")
  /// Raise and edit an invoice.
  invoices_write  @label("Edit invoices")
  /// Void a posted invoice. Irreversible.
  invoices_void   @label("Void an invoice")
  catalog_read    @label("View catalogue")
  catalog_price   @label("Set prices")
}

// ─── capability sets and assignment: rows, per tenant, never in git ────────
model Role {
  id          String       @id @default(cuid())
  tenantId    String
  name        String       @label("Role name")
  description String?
  permissions Permission[] @label("Capabilities")
  builtIn     Boolean      @default(false) @system
  members     Member[]

  @@gate("2.5.5.6")
  @@unique([tenantId, name])
  @@deny('update', builtIn == true)
  @@deny('delete', builtIn == true)
}

model Member {
  id       String @id @default(cuid())
  tenantId String
  userId   String
  roleId   String
  role     Role   @relation(fields: [roleId], references: [id])

  @@gate("2.5.5.6")
  @@unique([tenantId, userId, roleId])
}

// ─── enforcement: reads a flat list, never sees a Role ─────────────────────
model Invoice {
  id       String @id @default(cuid())
  tenantId String
  amount   Int

  @@gate("2")
  @@allow('read',   'invoices_read'  in auth().perms)
  @@allow('create', 'invoices_write' in auth().perms)
  @@allow('update', 'invoices_write' in auth().perms)
  @@allow('delete', 'invoices_void'  in auth().perms)
}
```

```
roles: Billing Clerk[2]  Regional Billing Lead[4]  Owner[5]

u1 Billing Clerk          read=1 write=y void=n
u2 Regional Billing Lead  read=1 write=y void=y
u3 no role                read=0 write=n void=n

undeclared grant     : ValidationError — invalid Permission value "wipe_everything"
admin rename builtIn : refused
owner rename builtIn : refused          ← a policy beat OWNER(6)
owner delete builtIn : refused
admin create custom  : OK
admin rename custom  : OK
```

*Regional Billing Lead* appears in no seed. Voiding works for it and not for the
clerk, and both are level 4 — which is the grid, running, with no mechanism added.

**The role editor is `<Form {resource} />` and nothing else.** `@label` on an enum
member reaches the client as `x-labels` on the `Permission` `$def`, so the
multiselect a `Permission[]` column already generates carries *Void an invoice*
rather than `invoices_void`. No display table, no second source, no catalogue. The
`///` doc comment is there for the longer sentence when a screen wants one.

### Several roles, and the rule that keeps it a union

The `Member` unique above is `[tenantId, userId, roleId]` and not
`[tenantId, userId]`, which is the difference between a person holding one role and
a person holding a stack of them. One role per tenant is a restriction worth
*choosing*, and the first draft of this record made it by accident. Executed:

```
roles held : Closer, Billing, Auditor
union      : invoices_void invoices_read invoices_write catalog_read
read: 1   void: y
```

**Roles union and nothing subtracts.** The moment a role may *remove* a capability,
authorization is being written in tenant data — with no snapshot, no diff and no
parse-time check — and the `@@allow`/`@@deny` engine is being rebuilt one layer up
by people who are not looking at a schema. A *restricted auditor* is a policy, not a
role. This is the request that arrives in month three and the refusal has to be
ready before it does.

**The closed set is the whole safety property, and an enum array supplies it**: a
role naming a grant the seed never declared is refused at the Data boundary, by
name, at the moment the role is saved. The failure that matters is the other one — a
grant ignored quietly at read time, where the administrator builds the role, the
screen says saved, and nothing is granted.

The cost is that a new permission is a migration. That is the correct cost: a new
permission is always new code that reads it.

### What custom roles bring that the declaration does not answer

**A role editor is a privilege-escalation console until *you may only grant what you
hold* is enforceable, and today it is not.** The predicate is refused at parse:

```
@@allow('create', permissions in auth().perms)

Role: 'permissions' is an array field, and 'in' asks whether ONE value is in a
list. Overlap between two lists is not expressible yet
```

The expression language stops exactly one operator short. A hook is the wrong way
out — Invariant 6, and a hook misses every path it is not mounted on, which for a
role table is a seeder, a job and an import. The operator is the way out, and the
SQL is a shape already compiled for the singular case:
`NOT EXISTS (SELECT 1 FROM json_each("permissions") WHERE value NOT IN (?, …))`.
**This is the mandatory piece of the whole idea.** A grid shipped without it hands
every tenant administrator a route to every permission the application has.

**The spelling is `allIn`** — `@@allow('create', permissions allIn auth().perms)` —
and the menu is one operator rather than a family. Subset and *contains all* are the
same operator with the operands swapped, so naming both is naming one thing twice;
an intersection is not a predicate at all and does not belong in a boolean
expression language; and a symbol nobody can type (`⊆`) is hostile in a file people
hand-write. Whoever rules it should also settle the mirror, *revoke only what you
hold*, which is the same operator on `update`.

**A custom role must not carry a level**, and the general form of that is worth
stating once: **authority to modify authorization is not authority granted by
authorization.** The repo already writes half of it down a level lower — *a column
your `getLevel` reads must not be writable by the caller being graded* — and this is
the same rule where the thing being edited is the grant itself. A `level` column on
the role table turns the role editor into a level editor and lets a tenant
administrator mint themselves SYSADMIN. It is also the clean statement of the two axes: the ladder answers *what
kind of caller is this*, the grid answers *which capabilities do they hold*, and
only the second is the tenant's to write. Standing stays a closed enum the
application owns.

**A permission set resolves per request and is never baked into a token.** A grant
riding in the session survives its own revocation until the next sign-in. The rule
already exists in the other direction — deferred work stores an id and never a
session, so a caller demoted between asking and running is graded at the standing
they hold now — and this is that rule with the same reason behind it. The cost is
one join beside `membershipClaim()`'s existing read.

**Built-in roles are rows seeded per tenant, not constants**, and the column that
says so must be `@system`. Otherwise the roles screen holds two kinds of thing and
has to explain why some cannot be edited. `builtIn` guarding update and delete is
one `@@deny` — but the first draft left the column writable, and that is a hole:

```
admin set builtIn:true on create : ACCEPTED
  then delete it                 : AccessDeniedError
```

A tenant administrator mints a role **nobody can delete or rename, including
OWNER** — a denial of service on their own role table, self-inflicted and
unrecoverable without `asSystem()`. `builtIn Boolean @default(false) @system` closes
it: readable by anyone, refused on write by name, and the application still fills it
by naming the column, which keeps the gate, the row policies and the audit actor
that `asSystem()` would drop. It is one instance of the principle above — a column
that decides what may be edited is not a column the editor may write.

### The half no committed file can hold

`enum Permission` is in git, so `db/access.snapshot.md` and `access --from` keep
working on the vocabulary — a permission that stops existing is a diff. Roles are
rows, so they are absent from both, correctly: an artefact that changes hourly is
not a review artefact. What is left over is a runtime question with no home —
**which roles in this tenant currently grant `secrets_read`** — and that is a Studio
or basecamp screen rather than a snapshot. It is also the first thing an auditor
asks for.

## Where the grid cannot reach: named moves and named methods

Probed 2026-08-25, and the answer is different for the two.

**A custom method: no, and indirectly yes.** `@@allow`/`@@deny` take a fixed
operation list and a method name is not on it:

```
@@allow("pay", …)
→ @@allow/@@deny: invalid operation 'pay'. Valid: read, create, update,
  post-update, delete, write, all
```

A custom method still crosses the boundary as whatever CRUD it performs, so
`orders.pay` calling `db.order.update()` is covered by `@@allow('update', …)`.
What cannot be said is that `pay` takes a *different* rule from an ordinary edit
— void, refund and correcting a typo in the note all collapse to `update`. Which
is the whole point of the grid: `invoices_void` is not a capability if the
boundary cannot tell voiding from editing.

**A transition: yes, as `update`.** A named move consults the model's update
policy and is refused by it:

```
editor (holds the capability)  transition(pay) : paid
payer  (does not)              transition(pay) : refused, still pending
```

But a per-move `@gate(N)` takes a **level and nothing else**, so the ladder
reaches an individual move and the grid stops at the model. `refund` can require
ADMINISTRATOR; it cannot require `orders_refund`.

### The precondition: the two lists have to be checked against each other

Before a capability can be bound to a move, the move has to have one name rather
than three. `example` writes it out — `@@transitions(status, pay: …)` in the seed,
`const pay = …` in the service, `'pay'` in that service's `methods:` — and **nothing
compares them**. A service naming a move the model has dropped throws at runtime; a
model declaring a move no service exposes is unreachable and silent; and deleting
the `@@transitions` block while the method survives turns a guarded write into an
ordinary column write that keeps answering 200.

A binding is worth nothing if the names it joins can drift, so this comes first.
It is a `fli check` rule and both halves are already in reach of `core/checks.js` —
`FJS-502`.

### What this changes about the declaration

**Four CRUD keys is the wrong shape for `@@require`.** The verb set is open —
`pay`, `void`, `refund` — and that openness is what makes this a vocabulary
rather than a fixed matrix. The declaration has to be able to name a move and a
method, not only an operation, or every application with a state machine gets
its capabilities back at the granularity it already had.

**`@@transitions`' per-move `@gate(N)` is where a capability wants to attach.**
The move is already the finest thing the schema names, and today only a number
can go beside it.

### One defect came out of the probe

A policy refusal on a transition was reported as `TransitionConflictError` — 409,
`retryable: true`, *row was modified before update could complete* — because the
policy and the compare-and-set both narrow the same WHERE and zero rows means
either. So a refused caller was told the row had changed, and `isStaleWrite()`
re-applied it forever. Fixed: `FJS-494`. The half in front of it is still open —
`transitions(row)` grades the gate and not the policies, so the button renders
(`FJS-495`).

### The convention underneath, which already exists

`example`'s own comment states it before anything was designed: *the four moves take
an id and nothing else, and a move's rules are in `@@transitions` where every other
rule about this row lives.* Junction agrees from the other side and does it by
declining — `OP_FOR_METHOD` names the five CRUD methods and no custom one, so
`orders.pay` gets no gate at the API tier at all, because the Data boundary has the
opinion.

**The template for how a capability should reach a method is `input:`.**
`{ method: 'recordTracking', input: 'TrackingUpdate' }` does not put the shape in the
service — it names a `type` in the seed. Which generalises to the rule the whole
layering seems to want:

> The seed owns what a thing is. A service names which one applies. A service never
> carries a rule.

That is already true for validation, for standing and for moves, so a capability
needs no new principle — only a vocabulary in the seed and a binding at whichever
boundary the thing is reachable from. What has no home under it is a method that
writes nothing at all, and the honest reading of those is usually that they should
be writing a row.

## Can the vocabulary be generated?

**No, and the reason is that a capability's existence is a judgement.** `apps_manage`
at developer and `apps_delete` at admin is a line somebody drew; nothing in the
schema says it until it is said. Every mechanical source enumerates the places a
line *could* go, and on basecamp that is 152 of them — models × operations, which is
the gate respelled with no information added. Services × methods is the same count
one boundary out.

**Transitions are the one source that is the right size, and they are the wrong
eleven.** basecamp declares seven moves on `Deployment` and four on `Job`; `build`,
`push`, `release`, `succeed`, `fail`, `start` and `idle` are driven by the pipeline
and nobody ever holds a capability for them. Roughly three of the eleven are human
actions. Generate all eleven and eight are noise in a role editor for good. (`fail`
and `cancel` each appear twice, so a derived name needs `<model>_<move>` regardless.)

**What makes the derivation possible is marking the machine moves, and the schema
can already do it.** `@gate(8)` on a transition means `asSystem()` and nothing else —
a caller is clamped to 7 and refused by name, and a system context bypasses the
check entirely. Measured, and `transitions(row)` already reports `allowed: false` for
one. With the machine half marked, the rule is mechanical and lossless:

> Every move not at gate 8 is a candidate capability.

Which moves the judgement into the schema, where it is a judgement worth making for
its own sake — today it lives in `internalOnly()` hooks in a service. `FJS-506`.

**Three things around the enum are worth generating and the enum is not.**

- **A candidate set, once.** `fli capabilities:suggest` reads the role hooks, the
  gate levels and the non-machine moves, and proposes an enum to edit down — the
  honesty of `fli auth:install`, a starting point rather than a source of truth. It
  is how basecamp's 27 were produced by hand.
- **A coverage report, standing.** A declared capability nothing references is dead
  vocabulary; a guarded action with no capability is a line nobody drew. `fli check`,
  the same shape as `FJS-502`.
- **The matrix, which is pure fact.** Not *which capabilities should exist* but *what
  does each one reach* — derivable from the bindings with no judgement in it, and the
  artefact that has no home today. It is what `access.snapshot.md` would carry and
  what answers *what does `secrets_manage` actually let me do* for a role editor.

Note the direction: the generator that works runs the opposite way from the one
asked for.

**And the premise of this section was overturned the same day.** *A capability's
existence is a judgement* is true only while `apps_manage` is a legal capability.
§ *The one-action rule* bans it, and what is left needs no generating because it needs
no declaring — the capability is a reference to something the seed already states. The
three generated artefacts above survive unchanged; the enum they were consolation for
does not need to exist.

## The one-action rule, and the enum it deletes

**A capability names exactly one action.** `manage`, `operate`, `administer`,
`handle` — a verb that is not itself an action but a container of them — are refused
by the rule rather than discouraged by taste.

The reason is the role editor. `apps_manage` cannot be shown to a customer
honestly: nobody can enumerate what it grants without reading the schema, and its
contents *change* when the model gains an operation, so a grant somebody reviewed in
March means something wider in June with nothing having been assigned. A grant whose
meaning moves under it is not reviewable, and reviewability is the property this
whole record is written to protect.

**Adopt it and the judgement above disappears.** § *Can the vocabulary be generated?*
argues that a capability's existence is a line somebody drew — `apps_manage` at
developer and `apps_delete` at admin. Under the one-action rule `apps_manage` cannot
exist. What is left is exactly the set of actions the schema already names, and there
is no judgement about which of those exist: they exist because the action does. The
judgement was never about capabilities. It was about the bundling.

**So the capability IS its referent, and none of them needs declaring.**

| Written | Is already | Declared by |
| --- | --- | --- |
| `Server.reboot` | a named move | `@@transitions` |
| `Invoice.delete` | an operation on a model | the model |
| `Server.hostname` (write) | a column | the field |
| `NetworkAttachment.create` | an operation on a join model | the model |

Each of those is a reference to something the seed states once. A second list
restating them is a second owner of one fact, which Invariant 4 refuses.

**`enum Capability` therefore does not need to exist, and the declaration collapses
to a switch.** Ruled 2026-08-25 — `FJS-D139`, which carries the four reference forms
and the cost that was accepted with it.

 A model does not say *which capability names are legal here* — it says
*this model is graded by capability*, and the names come from its own surface. Which
also settles the spelling: **`@@capabilities`**, a plural noun naming what the model
declares, is the shape `@@transitions` already has; `@@require` reads like a
predicate and takes an argument the model should not be carrying.

This does not rule that an application may never declare a coarse grant of its own —
a `Role` row is data and a customer may put anything in it. It rules that the
**framework mints none**, which is the half that has to be closed for the generated
multiselect, the snapshot and the coverage report to mean anything.

## Per-column capabilities, and the two shapes with no noun

The finest thing worth binding to is usually a column rather than a model, and
**that tier already compiles**: a field `@allow('write', 'x' in auth().perms)` is a
predicate both ways (`FJS-D129`), so per-column capabilities need no mechanism that
does not exist. Probed against three column kinds, and two of them have no noun to
bind to.

**A Boolean wants its moves named, not a convention over the column.** The first
proposal was a derived vocabulary — `toggleIsPrimary`, `trueIsPrimary`,
`falseIsPrimary`. `@@transitions` says it better and says it already:
`promote: false -> true`, `demote: true -> false`, each free to carry its own gate
and, under this proposal, its own capability. Two defects came out of probing it:
Boolean transitions were declared-and-broken — a real move read as a no-op because
the column stores 1/0 and the declared states are booleans, so `demote` silently
succeeded while `promote` threw (`FJS-511`, fixed) — and an unnamed Boolean move is
now refused at parse, because `-> true` says which value it writes and not what it
does, which is the whole of what a capability needs from it.

**A `Json` column has no noun below itself.** It is the shape the schema stops
describing, so a capability reaches the column and stops. Stated rather than solved:
guarding one key of a document is a second expression language, and § *Directions
considered and refused* is what that costs.

**A relation field is not stored, so it has no column to guard** — refused at parse
now, pointing at the foreign key, which guards the direct write and the
`{ connect: … }` form alike (`FJS-510`, fixed). **An implicit many-to-many has no
noun at all**: its keys live in a join table the model has no column for, so there is
nothing for a capability to attach to and nothing the parser can suggest. The escape
is the 20% one and it is the ordinary answer — declare the join as a model, and it
gets `create` and `delete` like anything else. Which is also what `networks.attach`
turns out to be: not a verb needing a new binding site, a **create on a join model**
that was hidden inside sugar.

## The residue is empty, and that is the finding

All 83 of basecamp's guarded service methods were classified against those tiers,
expecting a leftover pile that no binding could reach. **There is no pile.** Every
one crosses the Data boundary as an operation on a model, a write to a column, or a
named move.

**The problem is not reach. It is coarseness**, and two examples carry it:

| Method | Covered by | Which also grants |
| --- | --- | --- |
| `setVariable` | `Environment` write | every other edit to the environment |
| `setRole` | `WorkspaceMember` write | changing anybody's membership |

Both statements are true and both are useless. The capability somebody wants to
grant arrives bundled with the one they were trying to withhold — which is the same
complaint § *The claim* makes about the ladder, one boundary in.

That reframes the work. What is missing is not a new place to bind a rule; it is a
**finer** one, which is exactly what the per-column and per-move tiers are. The one
genuinely unreachable class is a method that writes nothing at all, and § *The
convention underneath* has the honest reading of those: they should usually be
writing a row.

## Why a capability may refuse where a policy may not

`packages/litestone/docs/access-control.md` § *Combining them* records the two rules the
shipped layers already follow: **a refusal must never confirm a row exists**, which is
why a policy filters, and **whose mistake is it** — refuse a payload wrong for
everybody, drop a key that is merely above this caller. It also draws the line the
layers sort themselves by: above it a refusal discloses only the shape of the schema,
below it a refusal would disclose the contents of the database.

**A capability is never row-scoped** — model, column or move, and never *which rows*.
So it sits above that line and rule one does not reach it: refusing leaks nothing the
caller could not already read off the schema. That is the whole licence to throw, and it
is the argument that `@@require` cannot be sugar over `@@allow`: inherit the desugaring
and it inherits the filter, which is the empty screen this record opens by complaining
about.

Rule two it breaks knowingly. The caller IS merely narrower — but being told is the
point, and the alternative is the springing toggle a field `@allow('write')` already
produces.

Order, with the proposal in place and the rest measured:

```
1. @@gate        model     ─ throws ─┐  session only, no query
2. capability    m/c/move  ─ throws ─┤  a flat list on the principal, no query
3. @@allow       row       ─ filters ─┤  costs the query; refusing would leak
4. field @allow  column    ─ strips  ─┘
```

## Partial opt-in — which operations a declaration covers

A model that says `@@capabilities` has said nothing yet about **which of its
operations the declaration reaches**, and the three answers are not equivalent.

| | Covers | Costs |
| --- | --- | --- |
| **A — everything** | read, create, update, delete, moves | every model now needs a read capability nobody asked for, and a missing one is an **empty screen** |
| **B — writes only** | create, update, delete, moves | cannot express `invoices_read`, which is a real capability in every ERP audited |
| **C — writes and moves; `read` on request** | as B, plus `read` where the model names it | one more thing to remember, in the 5% of models that want it |

**The measurement decides it.** Across basecamp's 41 models and `example`'s, **one
of twenty basecamp services restricts reads** beyond what tenancy and the gate floor
already do. Reads in these applications are governed by *which tenant* and *are you
signed in*, and almost never by *which position do you hold*. A default that grades
every read by capability is a default that is wrong 95% of the time.

**And the failure modes are asymmetric, which is the real argument.** A capability
refusal on a write throws and names itself — loud, and rule two's *whose mistake is
it* is answered in the error. A missing read capability composes with rule one: the
policy layer filters, so it is an empty list with a 200, on a screen that looks
built and is blank. **So the default covers the operations that fail loudly, and the
silent one is a statement somebody makes on purpose.**

**Ruled 2026-08-25: C** — `FJS-D140`, which carries the measurement and the
spelling. `@@capabilities` covers writes and moves; `@@capabilities(all)` adds
read, following `@guarded(all)` and `@allow('all', …)` rather than inventing a
token. A model that says nothing about read has its reads governed exactly as
before.

Still unruled and deliberately deferred is whether the gate *also* applies on a
model that opts in — AND, OR, or exclusive-per-model — which § *Open questions*
carries.

## The one model that keeps the ladder

`WorkspaceMember` is `@@gate("1.5")` in basecamp and **must not opt into
capabilities.** Both halves of that ladder are load-bearing and neither is
arbitrary: read at 1 so a caller holding no membership can still discover which
workspaces they belong to, and write at 5 because `CLAUDE.md` § Live hazards states
the rule — *a column your `getLevel` reads must not be writable by the caller being
graded*. Grading the standing table by the standing it stores is the circularity a
gate exists to break.

**There is a second reason and it is the harder one: a capability declared there
would be enforced by nothing.** All three writers go through `asSystem()` — because
membership is what decides access and cannot be read through the caller it is
deciding about — and `asSystem()` is the context every policy, every field rule and
the gate itself are bypassed in. basecamp already says this out loud, in the comment
above the hook it had to write instead (`refuseRoleAboveOwn()`, `FJS-410`). Filed
2026-08-25 as **`FJS-519`**, with three independent instances of the one cause.

**So the gate is not vestigial and this record should stop implying it becomes so.**
Sort the three layers by what each can *see* and the division is permanent:

| Layer | Sees | Therefore |
| --- | --- | --- |
| `@@gate` | the session. Reads nothing | the only layer usable at a bootstrap |
| capability | a flat list on the principal. Reads nothing | may refuse safely — verb-scoped, leaks nothing |
| `@@allow` | the row. Costs the query | must filter; refusing would leak |

*Cheap, no query* turns out not to be a performance note about the gate. It is the
whole of its qualification for the one job the other two cannot do — deciding access
without reading the thing being decided. Every application has at least one place
that needs it, and it is the table the grid is built out of.

## Directions considered and refused

Recorded so they are not re-proposed. Each is plausible, each was argued, and each
gives away something the rest of the record rests on.

**A permission that carries its own scope** — `invoices_read:region:west`, or a
condition like `invoice.amount < 10000` folded into the grant string. Both are
already expressible and better expressed: `@@allow('read', region == auth().region)`
and `@@allow('update', amount < 10000)` compile into the WHERE, which is the thing
FJS does that the ERPs this record was audited against hand-write per endpoint. And
a constructed permission string makes the set **unbounded**, which takes the closed
enum with it — and with the closed enum go the DDL check, the generated multiselect,
the labels, the snapshot and the migration story. This is the single most expensive
idea in the neighbourhood because it reads as a small extension.

**Naming the immutability column `system`.** The word already means three things
here — the `@system` field attribute, the SYSTEM(8) gate level, and `asSystem()` —
and a fourth is the collision `DECISIONS.md` § Outpost rules against. `builtIn` says
what it means and collides with nothing. (The *column* is `@system`; the column
NAME is not.)

**An `@@immutable(…)` attribute.** It is `@@deny('update' | 'delete', …)` with a
second spelling, which Invariant 4 refuses. A record that cannot change is a policy
that denies both write operations, and there is already a way to say it.

**A family of collection operators** — `in`, subset, intersects, `containsAny`,
`containsAll`. Subset and *contains all* are one operator with the operands swapped;
an intersection returns a set rather than a truth value and has no place in a
boolean expression language. One operator, `allIn`, is what the escalation guard
needs, and a family invented around a single requirement is how an expression
language stops being reviewable.

## Open questions

- **Is a permission per tenant?** Basecamp says yes — `WorkspaceMember.role` is
  read per request and the standing is resolved onto the principal
  (`FJS-D113`, `membership-tenancy.md`). So a grant set is a claim, resolved at the
  same seam, and this needs no new resolver. Confirm rather than assume.
- ~~**Who assigns?**~~ Answered above: declare the vocabulary, let a row carry the
  assignment. Both spellings survive — a `role` block for the ones an application
  ships, a `Role` table for the ones a customer invents — because the boundary reads
  a flat permission set and neither spelling reaches it.
- **`allIn` is proposed and unruled.** The operator is mandatory; the spelling is
  not settled, and the alternative worth weighing is a field-level
  `@allow('write', …)` handed the whole array, which needs no new operator at all
  but reads less like the sentence it enforces.
- **What answers *what can this person do*, once roles union?** A single role made it
  a fact — read the row, read the bundle. A stack of roles makes it a query across N
  assignments, and **no committed artefact can answer it**, which is the one property
  this whole record is written to protect. `access.snapshot.md` still grades the
  vocabulary and the predicates, so the *declared* surface is as reviewable as ever;
  what has no home is the *effective* surface, per person, per tenant, at a moment.
  That is a Studio or basecamp screen and an audit export, and it should be designed
  with the union rather than after it — the same mistake this file is a merge of.
- **What does a rename of a capability cost?** A capability is stored verbatim in
  every `Role.permissions` array, so renaming one is a data migration over tenant rows
  rather than a schema edit. `@label` absorbs most of the pressure — the sentence a
  person reads is renamed freely and the code never — but the migration path should be
  stated before the first application ships a typo. **Sharper now that the capability
  is its referent**: renaming a move or a column IS renaming the capability, so the
  blast radius is computable rather than guessed, and the rename tool has to know it.
- ~~**Which operations does `@@capabilities` cover?**~~ Ruled by `FJS-D140`: writes
  and moves by default, `@@capabilities(all)` for read, chosen by which refusal is
  silent and backed by the 1-of-20 measurement. The token is recoverable — it is
  syntax, not stored data.
- ~~**Does an application get to declare a coarse grant anyway?**~~ Answered by
  `FJS-D139`: the framework mints none and cannot, because a bundle is not a thing
  the seed declares and there is nothing for a capability to refer to. A `Role` row
  is data, so a customer bundles whatever they like — bundling is layer 2 and always
  was. What remains open is only what a role editor *shows* for a large bundle.
- **Does the grid apply WITH the ladder or INSTEAD of it, per model?** Deliberately
  deferred. What is settled is that the ladder does not become vestigial —
  § *The one model that keeps the ladder* names the case only a gate can serve, and
  it is at least one per application. The section above says both, gate as floor. The counter-argument is Invariant 4: a model graded
  on two axes has two owners of one refusal, and a model that adopts `@@permission`
  has to drop its gate to the read floor or a billing clerk at level 2 can never
  write an invoice gated at 4 — which makes the gate decorative in exactly the place
  the grid is interesting. Exclusive-per-model is the third option and is unargued.
- **Is this `warden`, and is it a package?** `IDEAS/package-map.md` reserves the name
  as a tier-1 package. Two things argue against a package at all: row tenancy and
  value sets both shipped as a seed declaration plus a battery with no package,
  and `FJS-D113` refused a *declaration* for membership because the resolver varies
  per application — which applies unchanged to role → permission expansion. The name
  has a second problem: `DECISIONS.md` § Outpost rules that infrastructure takes
  place nouns and AI takes personified nouns, and names `warden` among the words
  rejected for exactly that reason. If this is seed syntax rather than a package the
  name question does not arise.
- **Does a permission narrow to a field?** `@allow('write', …)` is already a
  compiled predicate per field (`FJS-D129`), so the crossing is `auth().can('x')`
  inside one — cheap if the claim is on the principal, and worth checking that it is
  before promising it.
- **Custom methods and named moves.** Measured above: a custom method is covered as
  the CRUD it performs and cannot carry a rule of its own, and a transition is
  covered as `update` while its per-move `@gate(N)` takes a level and no predicate.
  So the open question is no longer *does it reach* but *what does the declaration
  look like when the verb set is open* — and the projection to a custom method
  probably wants the same `methods:` declaration that already narrows the surface,
  while a move wants a capability where `@gate(N)` already sits.

## See also

- `IDEAS/membership-tenancy.md` — standing resolved per request; the seam a grant
  claim rides
- `IDEAS/value-sets.md` — declare the vocabulary, let a row pick from it: the same
  move, made once already
- `IDEAS/slices.md` — why a declaration at the Data boundary beats a check in a
  handler
- `IDEAS/compliance-from-the-seed.md` — the audit half, which this feeds
- `CLAUDE.md` § Live hazards — *a `@@gate` refuses, a `@@allow` filters*, the hazard
  this whole file is downstream of
- `IDEAS/package-map.md` § tier 1 — the `warden` row, which is this idea under a
  reserved package name, and `IDEAS/overview.md` 4.5 beside 2.19 for the same reason
- `IDEAS/row-level-tenancy.md` § open questions — *orthogonal named roles and a
  tenant scope are two non-ordinal axes arriving at the same boundary*, the reason
  these two must be settled together rather than apart
- `DECISIONS.md` § Outpost — the naming rule that rejects `warden` as a package name
- `ISSUES.md` § `FJS-519` — `asSystem()` is all-or-nothing, which is why the standing
  table cannot be graded by capability and why per-tenant credentials cannot be
  declared at all
