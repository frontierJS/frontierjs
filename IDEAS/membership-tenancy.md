---
id: membership-tenancy
status: shipped
dated: 2026-08-21
---

# Idea — Membership tenancy: when the tenant AND the standing are decided per request

**Status: RULED 2026-08-21 (`FJS-D113`) and BUILT 2026-08-22 (`FJS-374`).** Found by reading
basecamp's `core/hooks.ts` and `core/resource.ts` while deciding where to move them, and
asking whether anything in them belonged closer to the framework. Most of it does.

**What the ruling settled**, against the three spellings argued below: resolution is
API-realm, so the seed keyword is refused; the seam is one `createApp({ principal })`
option, because a tenant claim and a standing are one concept and not two; and the
membership read ships as a **battery** (`membershipClaim()`) rather than as seed syntax,
so it can be unable to emit a claim it did not verify without costing a language change.
The section below is kept as the argument, not as the answer — `DECISIONS.md` § Access
control is the answer.

`IDEAS/row-level-tenancy.md` is the record this extends and it is **built** — `FJS-D05`
ruled it, `tenancy { strategy row }` desugars into `@@deny` plus a `@default(auth().<claim>)`
stamp, and `tenantClaimGuard` refuses a signed-in caller carrying no claim. That record
asked *how does a tenant column get enforced*. This one asks the question it left:
**where does the claim come from, when the caller has more than one?**

---

## The gap, stated once

Row tenancy reads the claim **off the principal** — `toDataPrincipal(user)[tenancy.claim]`
(`junction/src/core/litestone.ts`) — and its own refusal message says what it assumes:

> *Put the column on the session (`sessionFields` in `@frontierjs/auth`), or mark the
> model `@@tenant(none)`.*

A column on the session is **one tenant per sign-in**. That is a real shape — a
single-workspace SaaS, an internal tool — and it is not the shape of most B2B software,
where a person belongs to several accounts, switches between them, and holds a
**different authority in each**.

Basecamp is that second shape, which is why it declares `@@allow('all', workspaceId ==
auth().workspaceId)` on fifteen models **by hand** rather than declaring `tenancy { }`.
The framework's own dogfooding app cannot use the framework's own tenancy feature, and
the reason is not laziness — the claim it would need does not exist until the request is
read.

---

## What basecamp writes instead

Not an argument, a count. Two files, and roughly two-thirds of them is this one gap:

| What | Where | Lines |
| --- | --- | --- |
| resolve the tenant from the request (`X-Workspace-Id`, `?workspace_id=`) | `resolveWorkspaceId`, `requireWorkspace`, `WORKSPACE_QUERY` | ~75 |
| read the membership row and put the standing where both halves of access control can see it | `applyStanding`, `withWorkspaceStanding` | ~90 |
| turn *not a member* into a sentence rather than an empty list | `scopeToWorkspace` | ~27 |
| the tenant clause on every read | `findScoped`, `getScoped`, `removeScoped` | ~55 |
| the tenant stamp on every create | `stampWorkspace`, `wsOf` | ~15 |

Nine exports, about 260 lines, and **every one of them is a mechanism rather than a
policy**. What is genuinely basecamp's is the small part: which header names the
workspace, and that `viewer` is level 2 while `owner` is 6.

---

## Two questions, and they arrive together

**1. Which tenant is this request for?** The framework already asks this for
`strategy database` — `registry.tenantFor({ host, headers, principal })` takes the
request's headers, because a host or a header is exactly how a db-per-tenant app picks
one. Under `strategy row` nothing asks: the claim is read off the principal and that is
the whole of it. **The same question has two answers depending on a strategy that should
not change who is asking.**

**2. What standing does the caller hold in it?** Litestone's gate takes
`getLevel(user)` — a pure function of the session. Basecamp's level is
`WorkspaceMember.role`, a **row**, and it differs per tenant for the same person. So the
level cannot be computed from the session alone, and there is no declared place to
resolve it.

The two are one question because the answer to the second depends on the first, and both
must be settled **before the Data boundary scopes the client**.

---

## Three constraints, discovered the hard way

Basecamp's `applyStanding` documents each of these in place. Any framework answer has to
satisfy all three, and they are the reason this is not a five-line hook.

- **It must compose INSIDE `withLitestoneDb`.** `createApp({ db })` installs an around
  hook that scopes the client from `ctx.auth.user`, and it runs before any hook can know
  which tenant is addressed. Whatever resolves the standing has to run after it and
  replace what it installed.
- **The standing must go on the PRINCIPAL, not on the client.** Junction's `getTable()`
  re-derives its own scoped copy from `ctx.auth.user`, so a standing that lives only on
  `ctx.locals.db` is dropped the moment a service touches a model. Basecamp assigns
  `ctx.auth.user` and then re-runs `$setAuth` — two writes, both required.
- **A fresh object, never a mutation.** Over WebSocket the session is resolved once at
  upgrade and the same object is handed to every frame; the internal-call path freezes
  it. Mutating it either throws or leaks one call's tenant into the next call on that
  socket. `FJS-D30` rests on that object being frozen.

The membership read also has to be `asSystem()`: membership is what *decides* access, so
it cannot be read through a client already scoped by that access — and with `@@gate` live,
`WorkspaceMember` is not readable at the level a caller with no standing yet holds.

---

## The shape of the declaration — the question, not the answer

The seed already says a tenant column exists. What it cannot say is *where the claim
comes from*, and that has at least three candidate spellings. This record does not choose.

**a. A resolver beside the declaration.** `createApp({ tenancy: { resolve, standing } })` —
one function answering *which tenant*, one answering *what claims does this caller carry
in it*, both async, both with the app in scope. Small, explicit, and it puts an
application decision in application code. It does not extend the seed, which may be the
objection: an app's tenant column is declared and its tenant *source* is not.

**b. Extend `tenancy { }` with a source.** `tenancy { strategy row  claim workspaceId
from header('X-Workspace-Id') }`. Declarative and it keeps the whole subject in one
block, but a membership check is a query against a model with a role column and a status,
and expressing that in the seed's grammar is a language design task, not a keyword.

**c. Say it in the schema as what it already is — a relation.**
`@@tenant(via: WorkspaceMember, subject: userId, claim: workspaceId, standing: role)`.
Attractive because the membership model is a real model with a real gate, and because
`@@tenant(via: rel)` already exists for delegation (`FJS-282`). Whether the *selection*
(which of my tenants is this request for) can live in the same attribute as the
*verification* (am I in it) is the open part.

Whatever is chosen, the standing half wants a single named seam — something like
`createApp({ standing })`, resolved once per request, merged onto the principal, with the
client re-scoped — because that is the piece with the three constraints above and no
declaration can hide them.

---

## What it must not make impossible

- **A service with no tenant at all.** `/workspaces` (the tenant IS the id), `/hub`
  (deliberately cross-tenant, behind one guard), the outpost endpoints (a machine, no
  session). Basecamp's around hook *refuses nothing* for exactly this reason: a request
  naming a tenant the caller is not in gets a principal with no role, which the gate
  grades VISITOR and a hook turns into a sentence. Refusing centrally would 403 the three
  service families that legitimately run with no tenant.
- **Re-resolution mid-call.** A service that addresses a different tenant than the header
  named (basecamp's `workspaces` service does) must be able to re-resolve, idempotently,
  without the first answer leaking into the second.
- **The empty-list failure mode must stay visible.** `tenantClaimGuard` exists because a
  missing claim is a 200 with nothing in it on every screen. A membership answer has the
  same failure and needs the same loudness.

---

## What it unblocks

- **About 260 lines of basecamp deleted**, and with them a class of tenancy leak: today
  the workspace clause is applied by a helper each service must remember to call.
- **`FJS-095`** closes with it. What keeps `{ validate: false }` on basecamp's `ApiKey`
  resource is that `workspaceId` is required and the CLIENT stamps it; a declared claim
  makes it `@default(auth().workspaceId)` and server-written, for all fifteen models.
- **The `core/` tidy this was found during.** Two thirds of `core/resource.ts` and a third
  of `core/hooks.ts` stop existing, which changes where the rest should live.
- **Every future FJS app of this shape**, which is most of them.

---

## Open questions

- Does the selection belong in the seed at all, or is *which tenant is this request for*
  an API-realm question the way `registry.tenantFor` already treats it?
- Can one mechanism serve both strategies? `strategy database` resolves a tenant from
  host/headers and swaps the client; `strategy row` would resolve the same way and stamp
  a claim instead. If they can share the resolver, the answer to question 1 above is one
  function with two consumers.
- Is *standing* tenancy's business or the gate's? A tenant claim and an authority level
  arrive together here, but an app could want a per-request level with no tenancy at all.
- What does a **job** do? Basecamp's jobs run `asSystem()` across every tenant, which is
  correct and is also the answer that makes the tenant claim absent. `app.runAs` rebuilds
  a principal from an id — does it rebuild the tenant claim, and from which tenant?
- **Is there a client flavour that is system AND still inside one tenant?** Today there
  is not, and it is a hole in what shipped rather than a question about what did not.
  `asSystem()` is a complete bypass of all policies (`src/core/policy.js` — `if
  (ctx.isSystem) return null`) and declared row tenancy desugars to `@@deny`, which is a
  policy, so **the bypass a `@@gate("8")` model requires is the same bypass that leaves
  its tenant**. Any model holding material only the system may touch AND belonging to one
  tenant falls in the gap; `$scopedBy` is not it, since it binds `@scoped`/`@edge`
  dimensions. Found 2026-08-24 while scoping `third-party-credentials.md`, where it is
  load-bearing: `Credential` is `@@gate("8")`, carries `userId` and no tenant column, and
  auth's models are `@@tenant(none)` — so *whose* Slack connection this is cannot be
  declared, only hand-written into a resolver's where-clause, which is what Invariant 6
  exists to refuse. The prior question is whose it should be, and that is this file's
  subject: person-owned dies when they leave, tenant-owned survives and any admin spends
  it. Not filed.

---

## See also

- `IDEAS/row-level-tenancy.md` — the record this extends; **built**, `FJS-D05`
- `packages/litestone/docs/multi-tenancy.md` — what ships today
- `ISSUES.md` `FJS-D113` (this question), `FJS-095` (the stamp it closes),
  `FJS-282` (`@@tenant(via:)`, the delegation precedent)
- `packages/basecamp/api/src/core/hooks.ts` § Standing — the hand-built version, with the
  three constraints documented in place
