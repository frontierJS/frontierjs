---
id: iii-borrowings
status: assessment
dated: 2026-10-03
---

# Idea — Five things worth taking from iii

**Status: ASSESSMENT.** Nothing here is built and nothing here is a dependency.
[iii](https://iii.dev/docs) is a Rust coordination engine: polyglot Workers on a
WebSocket, each registering Functions (`service::name`) and Triggers, with an Engine
that routes every call. It overlaps Junction, caravan and jetty on transport, jobs
and cron, and takes the opposite approach — one call contract instead of one schema,
with no data model and only a per-connection function allowlist for access. Adopting
it as a substrate would strain Invariants 1, 4 and 6. These five are its design
choices that stand on their own. The FJS state against each was found by search on
the date above; re-probe before planning.

## 1. The id is the contract; the tenant is a deployment value

iii keeps a function id identical across namespaces and refuses to prefix it
(`orders/state::get` is never spelled), because the id appears in schemas, docs
and tooling, and a deployment choice must not change a contract. Routing is strict:
a call resolves in its namespace only, and a miss answers `function_not_found`
naming the namespaces where the id does exist rather than falling through.

**FJS:** already the shape — a service name is the same for every tenant and
`registry.tenantFor()` picks the database. What is worth taking is the
*explanation*, which is cleaner than ours, and the miss message that lists where
the name does resolve. Open: whether an unresolved tenant ever falls back to a
default anywhere in `packages/junction/src/core/litestone.ts`.

## 2. A second owner of a name is refused, never substituted

iii rejects a second live owner of a worker name (fatal — the connection closes)
or of a function id (only that function is rejected; the worker keeps serving the
rest). Start order never decides who serves.

**FJS:** `app.claim()` and the router already refuse. The loader does not: two
service files claiming one name are resolved by sort order — the first serves and
the second is reported and skipped (`packages/junction/src/core/loader.ts`, the
`registeredBy` branch). That is start order deciding, which is the case iii closes.
The manual-registration-wins rule in the same branch is deliberate and is not this.

## 3. The guard belongs to the trigger, not the handler

An iii Trigger may name a `condition_function_id`, run with the handler's payload
before the handler. *When to run* stays with the binding and *what to do* with the
function, so one function bound to cron, a queue and HTTP does not accumulate a
guard per source.

**FJS:** Orion already has this split — conditions on edges, one expression
language (`FJS-D271`). Where it is missing is the bindings outside Orion: a
caravan cron or job and an event tap carry their guards inside the handler. Worth
asking whether those bindings should accept a condition, or whether "use Orion" is
the answer.

## 4. Reload restarts only what changed, and a bad edit keeps the old value

iii watches its config, diffs it, and restarts only added, removed or changed
workers. An invalid config file exits rather than run half-applied; an invalid
*settings* change is rejected against the worker's schema and the previous value
stays in effect, so a bad edit cannot take the engine down.

**FJS:** no config watcher found in junction or `fli`. `$.config` /
`app.configFor(tenant)` is the owner a reload would live in. The rejected-edit
half is the part worth having even without hot reload.

## 5. The browser tab is a callable worker

In iii a browser tab registers functions and the server can call them and await
the answer (Linkly ch. 7: the server asks the tab a question and the tab replies).

**FJS:** the junction client receives pushes and channel events; no
server-to-client request-with-reply was found in `packages/junction/src/client/`.
Use cases: ask the person a question mid-job, read state only the tab holds,
confirm a destructive step. Any design must answer how such a call is gated,
since the tab is the untrusted side (iii answers with an RBAC listener and an
`auth::*` function per connection).
