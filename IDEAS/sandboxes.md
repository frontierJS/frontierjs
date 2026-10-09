---
id: sandboxes
status: proposed
dated: 2026-08-24
---

# Idea — Sandboxes: a tenant with a parent

**Status: IDEA. Nothing here is built.** Dated 2026-08-24, from the same audit of
[open-mrp/api](https://github.com/open-mrp/api) as `IDEAS/shipped/permission-sets.md`.
Unlike that one, this is not a missing mechanism — it is three mechanisms that
already exist for other reasons, never pointed at each other. Do not cite this file
as describing behavior — see `VERIFYING.md`.

---

## The claim

**Every API with paying integrators ships a test mode, and everywhere else it is an
expensive feature.** Stripe has one, OpenMRP has one (`sandboxes` as a resource, a
`sandbox_middleware.go` at the gateway, and `mrp_sk_test_` key prefixes so the
credential decides). The cost elsewhere is that a second dataset has to be threaded
through every query in the application, because the application is where the data
access lives.

Here the data access is one boundary and the tenancy is already declared, so the
whole feature is *a tenant that knows its parent*.

## What already exists

- **`tenancy { strategy database }`** — one SQLite file per tenant plus a registry
  that indexes them, with one resolution every reader asks
  (`db.$tenancy` / `registry.tenantFor` / `resolveTenancy`).
- **A template-clone database** — `createTestEnv` already copies a prepared file per
  test, which is precisely *make me a second copy of this dataset, cheaply*.
- **`backup.js` and `tenant.js`** — copying and registering a tenant file is a
  command that ships.
- **API keys carry a principal** — `@frontierjs/auth` issues them, junction resolves
  every Bearer token through one door (`IAuth.verifySession`).

So a sandbox is: copy the file, register it with `parentOf`, and let the credential
say which of the two a request lands on. **Nothing in the Data realm changes and no
query in any application changes**, because no query in an FJS application names a
database — `ctx.locals.db` is assigned by `withTenantDb` and that assignment is the
one place the choice is made.

## The shape

```
fli tenant create --sandbox-of acct_7f2   # copies the file, registers the parent
```

- The registry row gains `parent` and, if wanted, `expiresAt`.
- The key prefix says which: a `_test_` credential resolves to the sandbox tenant,
  a live one to its parent. That keeps the rule *the identity belongs to the
  upgrade* intact (the `api-hazards` skill) — the mode is a property of the credential,
  never a header a caller can name.
- `fli tenant reset <id>` re-copies from the parent. That is the operation people
  actually want and the one no application gets right by hand.

## The part that is genuinely new

Two things do not fall out for free, and they are why this is a record rather than a
ticket:

- **What a sandbox is seeded with.** A copy of the parent is wrong: an integrator
  testing against a sandbox wants the reference data (items, units, price lists) and
  must not get the customer list. That is a *classification of models*, which is a
  seed question and probably a declaration — `@@sandbox(copy | empty | sample)`
  beside `@@tenant`, defaulting to `empty` so a leak requires someone to have typed
  the word.
- **Expiry, and who cleans up.** A sandbox with no lifetime is a second production
  database nobody watches. A Caravan job with a declared retention is the obvious
  answer, and it is the sort of thing 2.11 (backup) should own the primitive for
  rather than this growing its own.

## The line nobody else can write

**A sandbox that can send a real email is not a sandbox**, and this is the one place
FJS can make that a guarantee rather than a discipline. Conduit is the declared
outbound boundary — an app's complete outbound surface is enumerable, by
construction — so a sandbox tenant's targets can be pointed at a sink at resolution
time and *no code in the application can route around it*, because there is no other
way out of the building. Everywhere else this is a checklist item and a postmortem.

The same argument extends to the other two irreversible edges: `ctx.enqueue`'s
outbox relay and the webhooks plugin both sit above one owner each, so both are
divertible at the same seam.

## Open questions

- **Is this a `strategy database` feature only?** Under `strategy row` a sandbox is
  a second tenancy axis on every model, which desugars to a second `@@deny` and
  doubles the predicate on every read. Probably the honest answer is yes — and it is
  then a real reason to prefer `strategy database`, which is worth saying in
  `packages/litestone/docs/multi-tenancy.md` rather than discovering later.
  - **A** — `strategy database` only: `--sandbox-of` refuses under `strategy row` by
    name, and `multi-tenancy.md` states it as a reason to choose `database`.
  - **B** — Both strategies: under `strategy row` the sandbox becomes a second
    tenancy axis, a second `@@deny` on every model.
  - **Recommend A** — under `database` a sandbox is a file and a registry row, and
    under `row` it doubles the predicate on every read of every model. A refusal by
    name tells the developer which strategy to pick rather than costing every query.
- ~~**Does a sandbox appear in `db/access.snapshot.md`?**~~ **Answered 2026-10-09 (`FJS-D752`): B — Yes: one column per model in `access.snapshot.md` naming `copy`, `empty` or `sample`.** It changes no declared
  access, so probably not — but *which models copy* is a disclosure decision and
  `compliance-from-the-seed.md` may want it.
  - **A** — No: `@@sandbox(...)` is visible in `db/schema.lite` and changes no
    declared access.
  - **B** — Yes: one column per model in `access.snapshot.md` naming `copy`, `empty`
    or `sample`.
  - **Recommend B** — a model marked `copy` puts its rows where a test credential
    reads them, which widens who can read them, and the access snapshot is where a
    reviewer checks who reads what. With `empty` the default, the column only says
    something when somebody typed `copy`.
- **What does the dashboard show?** A mode a person can be in without noticing is
  the failure mode every provider with a test mode has shipped at least once. That
  is a UI-realm answer and it belongs with `status`/`theme` rather than here.
  - **A** — Sierra owns it, the way it owns the theme: a class on `<html>` derived
    from the session's tenant, and `@frontierjs/css` styles the page's frame for it,
    so no app can forget it.
  - **B** — The app's own concern: the client exposes the mode on the session and
    each app draws its own banner.
  - **C** — A `@frontierjs/ui` banner component that an app places.
  - **Recommend A** — the failure is a mode a person is in without noticing, so the
    signal cannot depend on an app remembering to draw it, which rules out B and C.
    The theme switch is the existing owner of a page-wide class on `<html>`.
- **Cost.** One SQLite file per sandbox per tenant is cheap; a thousand abandoned
  ones are not. Ties to expiry above.
  - **A** — Expiry: `expiresAt` on the registry row and a Caravan job that deletes
    expired sandboxes, the retention primitive owned by 2.11.
  - **B** — A cap: a stated number of sandboxes per parent, refused at create.
  - **C** — One sandbox per tenant, reset in place by `fli tenant reset`.
  - **Recommend C** — it bounds the cost at one extra file per tenant with no job and
    no retention to declare, and reset is the operation the paper says people want.
    It is Stripe's shape: one test mode per account. A comes back if somebody needs
    more than one.

## See also

- `packages/litestone/docs/multi-tenancy.md` — the two strategies, and the
  resolution every reader asks
- `IDEAS/testing-realm.md` — the template-clone mechanism, in its original context
- `IDEAS/third-party-credentials.md` — who mints a key and what it says
- `packages/litestone/docs/multi-tenancy.md` — the declaration this
  hangs off
