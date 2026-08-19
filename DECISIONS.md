# Decisions

Dated rulings by the project owner. These are settled unless explicitly reopened —
do not "fix" behavior back toward what a decision replaced. When a decision is
reversed, amend it here (strike and date it), don't delete it.

Format: **decision — why — where it lives.**

---

## Naming & vocabulary

**2026-08-16 · `FJS-D06` — the coherence-review vocabulary, ruled. Three hook
tiers not five, `Provider` is a third party, and `Slice` waits for a second
author.** The eight findings of `IDEAS/coherence-review.md` sat open for six
weeks because they were filed as one row. They are not one question, and the
prior art disagrees with the proposal on two of them.

**§1 — `Hook` splits into three, on the axis the proposal named: can it change
the outcome?** Every framework that has split this word split it in two, on that
exact axis, and none shipped more: WordPress `apply_filters()` / `do_action()`,
Directus filter hooks / action hooks, Payload's one access function whose RETURN
TYPE decides (`false` refuses, a `Where` filters). Rails went the other way and
*removed* Observers from core; Prisma deprecated `$use` for extensions. The trend
is subtraction. So:

| Tier         | Rule                                           | Here                                                                                                                                                                        |
| ------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hook**     | may mutate the arguments or halt the operation | junction `before`/`after`/`around`/`error`; litestone transform hooks and plugin interceptors; sierra `beforeNavigate`; **auth's four callbacks**, which refuse by throwing |
| **Guard**    | answers allow/deny and nothing else            | `@@gate` enforcement, the navigation check. Angular's `CanActivate` named it; NestJS took it                                                                                |
| **Observer** | receives, cannot act                           | litestone `onEvent`; conduit's `observers: { onError }`, which is handed an error it has no way to change                                                                   |

**Delegate is refused.** `onPasswordResetRequested` is a required performer —
absent, password reset silently does nothing — and it is the only one in the
tree. One instance does not earn a vocabulary tier; auth's own docs saying
*required* does the same job for free.

**The tier is the value; the renames are incidental.** Two things move
(`conduit.hooks` → `observers`, done — `management.hooks` keeps the word because
it really is Junction's pipeline; litestone's post-commit notifications settle on
`onEvent`, which is half done) and one rule arrives: **a new `on*` states which
tier it is.** The receipt for not having the rule is already in the tree —
`rateLimit` and `rateLimitHook` needed two names because one word covered two
mechanisms.

**§4 — `Provider` is a third-party entity the app includes, and that beats the
filed definition.** The proposal was *a swappable implementation of a contract*
("a Plugin adds; a Provider replaces"). The plainer reading is the one the
industry already uses — identity provider, payment provider, cloud provider,
OAuth provider — and the two nearly coincide here, because almost every
swappable implementation in this tree IS an integration point: `IAuth`,
notifications' drivers, junction's mail adapters, conduit's targets. Conduit had
already got there on its own: `'provider'` is one of its target kinds, defined as
*external REST API — Hetzner, GitHub, NetBird*. The native or in-memory case
survives the word ("the native provider") the same way Spring and Django survive
it.

**`Adapter` was the alternative and is refused**: it is the ecosystem plurality
(Rails, Ecto, SvelteKit, Feathers) but it names a shape rather than a party, and
the shape is not what needed a word.

**What `Provider` must never mean here is the registration unit.** That is
Laravel's Service Provider — `register()` + `boot()` — which is this repo's
**Plugin**, protocol and all. Anyone arriving from Laravel will read the two
backwards, so the boundary is stated rather than assumed: **a Plugin attaches a
capability to the app; a Provider is a party outside the app that a capability
speaks to.**

**Two in-tree collisions are cleared by this ruling rather than tolerated.**
`app.provide(name, value)` never provided anything — it claims a name on the app
object and throws if it is taken, which is Fastify's `decorate`. It becomes
**`app.claim(name, value)`**, where the verb matches the error message it already
throws. And `_metricsProviders` was `Provider` in a third sense — *a thing that
supplies a number* — so it becomes **`_metricsSources`**, reached through a
blessed `app.registerMetricsSource(name, fn)`, which also retires the
private-field reach-in §5 objected to and conduit's own `docs/AUDIT.md` warned
about by name.

**§6 — two collisions were already resolved in practice; one needed a side
picked; one is refused.**

- **`Manifest` is ceded to MV3, and both halves are now done** — `Release` is the
  Deployment realm's noun in `CLAUDE.md`, and sierra's route table is
  `generateRouteTable` / `renderRouteTable` in
  `scanner/generate-route-table.js`, configured by `routeTable.output` and
  carried through the postbuild pipeline as `routeTable` ([FJS-284](ISSUES.md)).
  Junction's `/manifest` endpoint keeps the word: it is a manifest of services,
  it collides with nothing, and an HTTP path is not vocabulary. A `package.json`
  is still a manifest where the code reads one — that is npm's word, not this
  repo's.
- **`Gate` and `Policy` stay, both of them.** A gate refuses on an ordinal, a
  policy compiles into a WHERE; litestone's own docs already call them
  orthogonal. Laravel ships the same two words and cuts them differently —
  ability-without-a-model versus rules-for-one-model — which is a hazard worth a
  doc line and not a reason to rename either.
- **`Channel` is a broadcast set. The delivery medium is a `Transport`.**
  Junction owns the wire meaning, it is the more entrenched and the harder to
  move. The loser is written down because it is genuinely contested — Laravel has
  the identical unresolved collision, and in notifications-land the delivery
  reading is the plurality (Novu, Laravel). `packages/notifications/types.ts`
  currently carries both, fourteen lines apart.
- **`Edge` is refused.** `Boundary` is qualified at every use — the Data
  boundary, the app↔world boundary — and one qualified word beats two words.
- **`Trust Hierarchy` is retired.** It appears in `ARCHITECT.md` and basecamp's
  `VISION.md` and nowhere in code, which says `LEVELS`. The prose says **the gate
  ladder**.

**§7 — `Slice` is deferred, and the map is fixed now regardless.** The axis is
well precedented — Django Apps, Rails Engines, Phoenix Contexts, NestJS Modules —
but every one of those earned its name because a THIRD PARTY shipped one. Devise
is why Rails needed Engine. Here the only two slices are `auth` and
`notifications`, both written in this repo, and the word would name something
already known. What is not deferred is the column: realm and domain are
orthogonal coordinates jammed into one field, and `CLAUDE.md` already files
notifications under a Realm/Domain of *vertical slice* because the field could
not hold it. **The test for adopting the word is `fli add <slice>` being on the
table, or someone outside this repo shipping one.**

**§2, §3, §5 and §8 are not ruled here** and keep their own ids —
they are mechanism findings wearing vocabulary clothes, and none of them is
blocking. This ruling closes the vocabulary row alone.

Unblocks `FJS-D10`: `IAuth` partial acceptance and the `setters`/`getters`
naming are answerable now, the `publish()` shorthand follows §1's tiering, and
typed `createSchema` inference never depended on this at all.
*Lives in:* `packages/junction/src/core/app.ts` (`claim`, `_metricsSources`) ·
`ARCHITECT.md` §2 · `IDEAS/coherence-review.md` is the argument, still not a
register.

**2026-08-15 · `FJS-D03` — Context is a per-realm concept. It is plural, it is
documented, and it is not unified.**

**Definition.** A Context is *per-invocation state and metadata available to the
code executing on behalf of a caller.* The filed question proposed Junction's
split as a standard other realms conform to as subsets; they cannot, because two
of the things called `ctx` are not the same noun.

**What the definition decides:**

|                                               | Verdict                                                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| junction `ServiceContext`, `TransportContext` | Contexts. Per request / per call                                                                                                                                                  |
| sierra resource hook ctx                      | a Context. Per operation                                                                                                                                                          |
| `fli` `context`                               | a Context. Per invocation — the environment, not a request                                                                                                                        |
| sierra `page`                                 | a Context of its realm. Per navigation                                                                                                                                            |
| **litestone plugin `ctx`**                    | borderline, and the doc must say so: per **client scope**, not per invocation. It carries the compiled maps and the principal that scoped the client, and no per-call data at all |
| **mesa compile `ctx`**                        | **not** a Context. Compile state, ambient singleton, no caller                                                                                                                    |
| **mesa `$context`**                           | not per-invocation either — it is scoped by the component TREE. The name is right for what it does; the axis is stated instead                                                    |

**The rule that replaces conformity: every package documents its own, by
LIFETIME.** What creates it · how long it lives · what is on it · what it is
*not*. Lifetime is the line that prevents the actual mistakes — reading
`ctx.auth` in a Litestone plugin expecting a per-request value, or reaching for
`ctx.method` on one.

**Naming: one word per realm, and the crossing is stated.** Path captures are
`ctx.route` on BOTH of Junction's contexts — the transport's `params` is renamed —
and `page.params` in Sierra. `params` is not reintroduced anywhere in Junction on
purpose: in Feathers it means the whole context bag, that idiom keeps arriving
(`ctx.params.user`, `ctx.params.headers`, `app.service(x).get(id, ctx.params)`),
and a field of that name holding *something else* is how a role check reads
`undefined` and passes for everyone. Absent, the idiom throws. Sierra keeps
`params` because it is what every router a person has used calls it, and
`page.route` there means the matched route NODE.

**Semantics, not just names — the Junction contract, now true.** Four fields,
four rules:

- **`auth`** — WHO. Frozen. **Propagates**: a call naming no principal inherits
  the one in scope, at any depth. An explicit `{ user: null }` means *as nobody*
  and is kept — **absent is not null**, tested with `in` rather than `??`, the
  same rule Invariant 9 makes about a patch.
- **`client`** — WHERE FROM. Read-only, propagates. Information, never authority.
- **`route`** — path captures. Router-only, `{}` on an internal call.
- **`locals`** — per-call scratch. Fresh `{}` every call, does NOT propagate; it
  can be handed down deliberately, which is the difference between passing and
  inheriting.

**`auth` did not propagate, and the file said it did.** Measured: a nested
`ctx.app.service('inner').find()` saw `null` while `context.ts` documented
*"Frozen. PROPAGATES across internal calls."* Every boundary that starts a call
chain therefore began at STRANGER(0) unless a human threaded it by hand — which
is the same root cause as the Caravan job hazard, and why `example` carries an
`app-ref.ts` singleton and `{ auth: { user: SYSTEM as never } }` in every job.
Fixed by putting the principal in the `RequestMeta` ALS store the transport
already wraps a whole request in, so nothing is threaded; a call whose principal
differs re-scopes, so a sub-call made as somebody else passes **that** principal
to its own children rather than the request's.

**Enforcement is a test, not a rule.** A `fli check` rule cannot see a TypeScript
interface from the file tree — but propagation, freezing and freshness are
runtime behaviours, so `packages/junction/tests/context-contract.test.ts` asserts
all four by running them. Verified by breaking it: three go red against the old
behaviour. That is the enforcement that was actually available, and it is what
would have caught a documented contract drifting from its code.


**2026-08-15 · `FJS-D19` — Litestone's `Plugin` gets a `name`. The concept is
NOT renamed.**

Two questions were filed as one and they have opposite answers.

**The name: yes, and it was never cosmetic.** A Litestone plugin had no identity
at all, so nothing could introspect, order, report or name one in an error. It
defaults to the class name — right for every plugin anyone writes, and free —
and a stated `name = '…'` field wins, because a minifier rewrites
`constructor.name` and a bundled app would report `t`. `db.$plugins` lists what
is installed, in run order, on **every flavour of client**: what is installed
does not vary with auth. Its first useful answer is the one nobody could get
before — *a gated schema auto-installs `GatePlugin`, so what you passed is not
what is running.*

**The rename: no, and the proposal does not survive contact with what ships.**
`IDEAS/one-mental-model.md` §5 argued that Litestone's Plugin is really a **Hook**
— it intercepts queries — while Junction's attaches capability. Tested against
the three that exist: `GatePlugin({ getLevel })` is access control,
`FileStorage({ provider, bucket, endpoint, keyPattern })` is a storage
capability, `ExternalRefPlugin` backs a field with external data. Each attaches a
capability, holds configuration, and is installed once at construction with an
`onInit` lifecycle. That is Junction's definition of Plugin, exactly. And
**Litestone already has `hooks`** — `createClient({ hooks: { before: { setters:
[fn] } } })` — so renaming Plugin to Hook would collide with a live, differently
shaped concept one option key away in the same package.

What actually differs between the two realms' plugins is the **interception
surface**: eight `on*` methods here, four lifecycle methods there. That is a
realm difference, not a concept difference — a Data-realm plugin intercepts
queries because queries are what the Data boundary owns, and an API-realm plugin
registers routes and services because that is what the API boundary owns. Same
noun, realm-appropriate surface. That is the mental model working, and the
finding it was filed under mistook it for the mental model breaking.

**What should still converge, and did not need a rename to say so**: ordering.
Junction has `requires: string[]` and Litestone has install order and nothing
else. When Litestone grows one it takes that word rather than inventing
`after`/`priority` beside it. The class-vs-object-literal shape difference stays:
`ExternalRefPlugin` is a published base class people extend, and the gain is
aesthetic.

This ruling deliberately does not lean on **Provider**, which `ARCHITECT.md`
listed as proposed and `FJS-D06` had not settled at the time. It has since:
a Provider is a third party the app speaks to, and a Plugin is still what
attaches a capability — so the two nouns here stay exactly as this ruling put
them.

**2026-08-15 · `FJS-D02` — a custom service method is a METHOD. There is no
fourth noun.** The realms name three things — Model, Service, Resource — and
`action` was a fourth, for a concept every surface a developer touches already
called a method. The declaration is `methods: ['find', 'get', 'reboot']`, one
list with CRUD in it. The wire is `X-Service-Method` over HTTP and a
`service_call` frame naming `method` over the socket. The pipeline carries
`ctx.method` and a refusal is `MethodNotAllowed`. Only the resolution table
needed a separate word, and *is this name in the CRUD set* is an adjective, not
a noun.

**The adjective is "custom", and it is derived rather than declared.** A custom
method is one the CRUD set does not name; nothing else distinguishes it, which
is why nothing needs to say so. `_customMethods` / `collectCustomMethods` /
`customMethodNames` is the table and its resolver, `ServiceDescription`
reports `customMethods`, and `/metrics` and `surface.snapshot.md` say the same
word.

**What it cost was one public name**: `svc.action(name, id, data, query)` is
`svc.invoke(...)` on the browser client and on a Sierra resource's `service`.
Not `call` — that is already the explicit WS-only escape hatch, and
`Function.prototype.call` is the wrong thing to make a reader think about. The
wire did not change, and neither did the announcement: a custom method still
announces under its own name (`orders pay`, `FJS-D21`).

**2026-08-13 · `FJS-D29` — the process a fleet server runs is an OUTPOST, and
infrastructure gets place nouns while AI gets personified ones.** Basecamp's
resident process was called an *agent*. So is the thing `IDEAS/agent-surface.md`
proposes to expose over MCP. **The collision was already in the tree**, not a
risk to guard against: one word, two meanings, both written down, in a repo whose
`UserKind` enum already has an `ai` member and whose junction batteries already
include AI.

**Outpost** is the ruling. It is exact — a small permanent installation at a
distance from the main body, which holds a position and reports back — and the
cardinality matches, one per `Server`. It pairs with Basecamp in a sentence that
needs no gloss: *Basecamp installs an Outpost on every server.*

**The rule underneath it is the part that keeps working.** Every AI-flavoured
word is a **person**: agent, assistant, copilot, scout, ranger, worker. So:

> **Infrastructure takes place nouns. AI takes personified nouns.**

A place noun cannot drift into meaning a model, which is a stronger guarantee
than picking a different word and hoping. It also decides the next collision
without another argument, and it is why `scout`, `ranger` and `warden` were
rejected here despite fitting the frontier theme.

The technically-honest alternatives were all taken, which is worth recording so
nobody re-proposes them: `daemon` is `AppType.daemon`, `worker` is **both**
`ServerRole.worker` and `AppType.worker`, `node` is Node.js in a JavaScript
framework, `runner` belongs to CI, `minion` to Salt, and `depot`/`porter`/
`warden`/`marshal` are already claimed in `IDEAS/package-map.md`.

**Ruled now rather than later because three of the renamed names are wire
contracts and nothing speaks them yet.** The Conduit target `outpost:<server-id>`,
the target `kind`, and the snake_case heartbeat payload (`outpost_version`,
`outpost_url`) are the protocol between Basecamp and a process that has not been
written. Basecamp's own half *is* written — both engines dispatch through it —
so the caller exists and the callee does not, which is the last moment this is a
find-and-replace instead of a compatibility window.

**What did not change.** `userAgent` is an HTTP header and stays. `CHANGES.md`
entries and closed `ISSUES.md` rows keep the word, because they describe what was
true when they were written. `db/legacy-sql/002_server_agent.sql` keeps its
filename — it is history, and `db/README.md` explains that it never worked.
The architecture question is still open: whether a server runs a resident process
at all, or Basecamp pushes over SSH, is argued in `IDEAS/deploy-plane.md` and
ruled nowhere. **This decision reserves the name, not the design.**
*Lives in:* `packages/basecamp/db/schema.lite` (`outpostVersion`, `outpostUrl`),
`api/src/engine/fleet.engine.ts`, `api/src/engine/deployment.engine.ts`,
`api/src/services/servers/servers.service.ts`, `docs/VISION.md`,
`IDEAS/deploy-plane.md`.

---

**2026-08-08 · A resource file is named for its noun — PascalCase, singular —
one Resource per file.** `App.mesa`, not `apps.mesa`. Repo Invariant 19.

The three realms are already **Model → Service → Resource**, and two of them
had settled naming: `model App` is PascalCase singular (2026-08-01) and the
accessor derived from it is `db.app`. The UI realm was the one that had not —
`web/src/resources/` was named after the *service* (`apps.mesa`), so the same
noun was spelled three ways across three files and only one of them matched the
declaration it came from.

**The export does not change.** `App.mesa` exports `apps`, and call sites still
read `apps.find()`. That is the same split the Data realm makes: the
declaration is PascalCase singular, the accessor is lowercase — a Resource is
one noun, the binding is a handle on many.

What the rename bought beyond consistency: **the irregular cases became visible
in the file tree.** `AlertRule.mesa` exporting `alerts` states, at a glance,
that `modelNameFor()` cannot bridge those two and `model:` has to be given —
which was previously a paragraph inside the file that you had to open to find.
`AuditEvent.mesa` is the same shape. A resource over no model at all keeps its
service noun, singularised: `Portal.mesa`.

Applied repo-wide the same day. `packages/basecamp`: 13 files renamed, 36 call
sites. `example/`: `shop.mesa` — three resources in one file — split into
`Order.mesa` / `Product.mesa` / `Customer.mesa`, and `notifications.mesa` →
`Notification.mesa`. One Resource per file is half the rule; a grouped file has
no single noun to be named for.
*Lives in:* `CLAUDE.md` Invariant 19, `packages/basecamp/web/src/resources/`,
`example/web/src/resources/`.

**2026-08-09 · A pagination control is `.pagination-link`, not `.page`.**
The gap beside it is `.pagination-gap`. `@frontierjs/css` v0.14.6, breaking.

`Page` is already a tier in the vocabulary — *what changes when you navigate*:
Screen, Pane, View, Tabs. So `.page` put one word on two subjects one file
apart, and `.page[aria-current="page"]` spelled it twice in a single selector
meaning different things each time: the class named a destination, the
attribute named the current one.

The clinching case is `Previous` and `Next`. Both carry this class and
neither is a page, so the old name was not merely ambiguous — it was wrong on
the two controls in a pager that get clicked most.

Chose the long form over `.pagelink` (which mirrors `.navlink`) because
`term-part` is what every other Anatomy class already does — `surface-header`,
`pill-close`, `navlist-label` — and it retires an exception rather than
growing one: `NOT_A_TERM.anatomy` in `vocabulary.js` is the register of parts
that carry no hyphen and therefore need naming by hand, and it drops from five
entries to four. `.pagination-gap` follows so one term does not ship two
prefixes.

Cheap to do now and never cheaper: no application in the repo used the class.
The only consumer was `@frontierjs/ui`'s `Pagination.mesa`.
*Lives in:* `packages/css/src/patterns/nav.css`, `vocabulary.js` (`ANATOMY`),
`packages/ui/components/display/Pagination.mesa`.

**2026-08-06 · The email component kit is `@frontierjs/email-kit`.**
Closes `FJS-D15`; fixes `FJS-051`. Not `@frontierjs/mesa-email`. Every other
package's npm name matches its directory, and `email-kit` is the directory —
so the directory was right and the name was the odd one out. It also says what
the package IS rather than what it is built on: `@frontierjs/ui` is a Mesa
component kit too and is not called `mesa-ui`.

`package.json` already carried the new name; what survived was the old one in
prose, comments and one filename, which is the shape this kind of thing takes
once the code is correct. Swept: README, `index.js`, `render.js` (including the
user-facing peer-dependency error), `PROJECT_STATE.md`, mesa's own docs, and
`mesa-email.test.js` → `email-kit.test.js`. The 2026-07 audit keeps the old
name: it is a dated audit and rewriting its findings would falsify the record.
*Lives in:* `packages/email-kit/`.

**2026-08-01 · Model names are PascalCase and singular, always.**
`model Lead` → accessor `db.lead`; `model PageView` → `db.pageView`. The accessor
rule derives the API from the model name, so mixed conventions produced three
spellings of one model across packages. Exception: `@@external` models mirror a
foreign physical table and keep its name verbatim.
*Lives in:* all examples/docs in `packages/litestone`; enforce in scaffolds and reviews.

**2026-08-01 · Named gate syntax is canonical; digits are the compact form.**
`@@gate(read: READER, write: USER, delete: OWNER)` in all docs and new schemas;
`@@gate("2.4.4.6")` remains valid shorthand. `write:` expands to
create+update+delete unless one is given explicitly; missing keys cascade
read→create→update→delete, read defaults to STRANGER.
*Lives in:* `packages/litestone/docs/access-control.md`, parser `parseGateArg()`.

**2026-08-06 · `Signal` and `Event` are two words for two things, both legal.**
**Signal** is Mesa's reactive cell — the thing `createSignal`/`watchProxy` make and
`$:` tracks. **Event** is Junction's announcement — the thing `publish()` fans out
and a channel carries. `ARCHITECT.md` §2 previously listed *signal* as a banned
synonym for Event, which was written to stop "signal" meaning *notification* and
accidentally outlawed the word Mesa's own runtime and docs use for
its core primitive. The ban is narrowed rather than dropped: **do not call an
Event a signal.** Calling a reactive cell a Signal is correct and required.
They cannot be confused in practice because they live in different realms — a
Signal never crosses a Boundary, an Event only exists to.
*Lives in:* `ARCHITECT.md` §2; `packages/mesa/runtime.js`;
`packages/junction/src/transport/channels.ts`.

**2026-08-06 · `Policy` keeps exactly one meaning, and it is not "business rule".**
A **policy** is a row/field predicate (`@@allow`/`@@deny`) compiled into SQL WHERE.
A **Gate** is the ordinal per-operation level check. Both were already ruled. A
third proposed sense — "declarative business rule, as opposed to imperative
mechanism" — is **refused**: it is the word doing three jobs, and the two existing
senses cost an audit to separate. Where that distinction is wanted, the words are
already there: a **Declaration** is what the schema states, a **Hook** is what runs.
*Lives in:* `ARCHITECT.md` §2 clarifications.

**2026-08-06 · `Projection` is adopted for a read model only.**
A **Projection** is a *stored or served* shape derived from the seed for reading —
a materialised view, a serialised subset, a report. What the compiler derives at
build time stays **derived**; what a component computes stays **derived**. Adopted
because the existing vocabulary had no noun for "a second shape of the same truth,
kept in sync", and FJS-005's fix (`IDEAS/scoped-sql.md`) needs one. Not a synonym
for derived — if it has no independent existence, it is not a Projection.
*Lives in:* `ARCHITECT.md` §2 (to add); `IDEAS/scoped-sql.md`.

## Access control

**2026-08-16 · `FJS-D05` — tenancy is DECLARED in the seed, one block, two
strategies; row tenancy compiles to `@@deny` and never to `@@allow`.**

The row as filed asked for a config shape. What it turned out to need was an
owner: db-per-tenant worked, and its configuration existed in three places that
could disagree — a `createTenantRegistry()` call, a `tenants:` slice in
`litestone.config.js` that the CLI read three keys of, and nothing at all in the
schema. So `litestone tenant create` and the running app could each be correct
about a different directory. The other half was worse: **row-level tenancy was
not a framework concept in any form**, and basecamp hand-writes
`@@allow('all', workspaceId == auth().workspaceId)` on fifteen models, which is
fifteen chances to leave one off and no way to notice.

**The block lives in `schema.lite`, beside `database { }`.** Which strategy an
app runs is a fact about the app, and everything downstream needs it: the
registry, `litestone tenant`, Studio's switcher, and Junction, which has to
resolve a tenant per request. Precedence is stated once — **an explicit option
beats the declaration beats the default** — so a test can still point one schema
at a temporary directory. `litestone.config.js` keeps its `tenants:` slice and
sits between the flag and the schema.

```
tenancy { strategy database  dir "./tenants"  registry "./tenants-registry.db"
          maxOpen 100  key env("TENANT_KEY")  resolve subdomain }

tenancy { strategy row  column workspaceId  claim workspaceId }
```

**Row tenancy desugars into `@@deny`, and that is the whole correctness
argument.** `@@allow` rules are OR'd within an operation, so adding one to a
model that already declares `@@allow('read', ownerId == auth().id)` *widens* its
reads to every row in the tenant — a tenancy feature that grants access. Deny
overrides every allow and applies to a model declaring no policy at all.
Basecamp's hand-written spelling is the allow form, which is safe only because
those models declare no other read rule; as a generated rule it would not be.

**Two rules per model, because create and read want opposite answers about an
absent value.** `checkCreatePolicy` runs BEFORE `applyAuthDefaults`, so on a
create the column the stamp is about to fill is legitimately `null` — denying
that refuses every create the stamp exists to serve. On a read a row holding no
tenant belongs to nobody and stays invisible. The anonymous branch
(`auth().<claim> == null`) is stated rather than left to SQL's three-valued
logic, which reaches the same answer by a route nobody should have to hold in
their head, and is what refuses an anonymous create in the JS evaluator.

**What the block cannot judge is answered per model, not inferred.**
`@@tenant(none)` says a model spans tenants on purpose; `@@tenant(column: "x")`
names a different column; a model declaring the column is scoped. Models
declaring none are **reported once by name** at parse rather than warned about
individually or silently skipped — cross-tenant data is sometimes exactly right
(a plan table) and sometimes the column somebody forgot, and only the app can
tell. `jsonl`/`logger` models are never scoped: there is no policy engine there,
so a rule would read as enforcement and not be it.

**Resolution is asked, not copied.** *Which tenant is this request for* is an
API-realm question over a Data-realm declaration, so `registry.tenantFor({host,
headers, principal})` applies the declared `resolve` and Junction contributes
only what a transport has and what the refusal's status is. `createApp({ tenants })`
installs `withTenantDb`, which **replaces** `withLitestoneDb` — one
`ctx.locals.db`, and two hooks assigning it is a race decided by hook order.
Work with no request behind it names its tenant with `{ locals: { tenantId } }`.

**Under `strategy row` Junction adds a refusal rather than a hook.** A
*signed-in* principal carrying no claim matches no row, so every screen is an
empty list with a 200 — indistinguishable from a tenant with no data, and almost
always a missing `sessionFields` entry. Refused by name on a scoped service.
Anonymous is left to the gate: nobody is not a caller missing a claim.

**Deferred, with a reason.** A model reached only through its parent
(`check(parent)`) is not generated: `check()` is conservative-allow on create,
because the related row does not exist when the create policy is evaluated, so a
generated rule would hold for reads and not for writes — half-enforcement in the
one feature where that is worse than none. `FJS-282`.

*Lives in:* `packages/litestone/src/core/parser.js` (`parseTenancy`,
`expandTenancy`), `src/core/tenancy.js` (`resolveTenancy`, `tenantFrom`),
`src/tenant.js`, `packages/junction/src/core/litestone.ts` (`withTenantDb`,
`tenantClaimGuard`); tests in `packages/litestone/test/tenancy.test.ts`;
reference in `packages/litestone/docs/multi-tenancy.md`.

**2026-08-15 · `FJS-D22` — a column says *the system writes this* with `@system`,
and the application fills it by naming the column on the write.**

Four things were decided together, because ruling the annotation without ruling
the fill path ships a column nothing can legitimately populate.

**The word, not the expression.** `@allow('write', false)` already enforced this
at the Data boundary and nobody had documented it, but a client marker keyed off
*is this policy expression statically false* is an analysis of an AST that grows
cases forever. `@system` is decidable, and it makes the vocabulary orthogonal:
`@guarded` locks read and write, `@system` locks the write and leaves the read
alone. The pair is legal and means both halves — the combination `FJS-235`
recorded as unspellable. A dynamic route (`@allow('write', auth().isSystem)`) was
refused: measured, the model's `@@gate` refuses the whole update before the field
policy is ever consulted, so the rule would depend on the app grading its own job
principal correctly.

**The fill path is a narrow hatch.** `update({ where, data, system: ['col'] })`
unlocks one column and keeps the gate, the row policies, soft-delete and the
audit actor. `asSystem()` writes the same value by dropping all of them. Same
shape as ``where: { $raw: sql }`` keeping every policy while `asSystem().sql`
drops them — the narrow hatch beside the coarse one — and naming the field is
what stops an escape hatch disabling a guarantee silently.

**A refused write throws for `@system` and still drops for `@allow('write', …)`.**
Static means nobody ever, so a payload naming the column is code that meant to
write it, and the client was told `readOnly`. Dynamic means it depends who is
asking, and the same payload is legitimate for another caller: basecamp's
`User.kind` / `status` / `isSystemAdmin` are written that way, and an ordinary
member saving a profile round-trips all three. Making both loud would 403 every
one of those saves on a column nobody touched.

**A `@system` column is never in create-mode `required`.** Listing it there is
what refused every create in the browser naming fields the caller was never meant
to send. SQLite's NOT NULL still catches an application that forgets, at the
layer that owns the value, with a message that says which side is missing.

Not ruled here, deliberately: `FJS-D23`, the same seam from the other side — a
payload key that is not a column. It wants the same vocabulary and a second word
(`@transient`), not this one stretched.

**2026-08-14 · The identity ladder: `@@gate("8")` is for credential material,
not for `User`. A model is bounded by three declarations, and a level is only
the first.**

`8` reads as *the safest number*, and it is not a stronger `5` — it means
*nothing outside `asSystem()` has anything to say to this model*. That is true
of a password hash, a session token and a reset token. It is false of the table
an app's own screens list: at `8` the member list, the admin zone and the user
picker all have to go through `asSystem()`, where **nothing is enforced at
all** — so raising the gate moves the whole surface into the bypass. `FJS-170`
moved auth's `User` to `"4.4.4.5"` for that reason.

What `FJS-177` then showed is that the level alone is not the ruling. A gate is
per MODEL, so update at USER(4) says *any signed-in caller may write any other
person's row*, and in basecamp that included `isSystemAdmin` — the column its
own resolver grades SYSADMIN(7) from. Measured, not inferred: a `developer`
promoted themselves.

**The rule.** Identity — and any model whose columns feed a level — is declared
with all three:

| | Question | On refusal |
| --- | --- | --- |
| `@@gate("4.4.4.5")` | what KIND of caller | throws, naming model and level |
| `@@allow('update', id == auth().id \|\| auth().isAdmin)` | WHOSE row | filters; the write matches nothing and answers |
| `@allow('write', auth().isAdmin)` on the graded columns | WHICH columns | drops the field, keeps the rest of the write |

Two consequences are the decision rather than the arithmetic.

**A column the caller can write is not a column a level can be graded from.**
Whatever the app's `getLevel` reads — `role`, `isAdmin`, a status, a membership
— must be out of that caller's reach, or the ladder grades a caller on a value
the caller chose. Where a level already covers it, that is enough:
basecamp's `WorkspaceMember.role` needs no field policy because writing the
membership is ADMINISTRATOR(5) and the caller being graded is USER(4).

**Write the policy against the same standing the level is graded from.**
`auth().isAdmin` is what `FrontierGateGetLevel` and `sessionGateLevel()` both
read for ADMINISTRATOR(5), so the level that deletes a person is the level that
sets their role — one idea, not two. This is why the scaffolds stopped grading
`role === 'admin'` in a resolver while the schema policy read a different field:
what `'admin'` MEANS is the app's decision, made once where the session is built
(`sessionFields`), and projected onto the standing everything else reads.

The cost, stated: a policy FILTERS where a gate REFUSES, so the write a policy
turns away returns normally. Nothing in a return value can tell you it was
refused — a test reads the row back through `asSystem()`.

**2026-08-10 · Basecamp's gate ladder: a level is a fact about a caller IN A
WORKSPACE, so it is resolved per request and carried on the principal.**

The gap `FJS-007` recorded for ten phases was never the resolver. It was that
the shape Junction ships — `sessionGateLevel()`, standing that travels with the
row in `user` — cannot say *admin of THIS workspace*. The same person is `owner`
in one workspace and `viewer` in the next, so grading them from their user row
answers USER(4) everywhere, in every workspace, including the ones they are not
a member of.

So the level is resolved from the `WorkspaceMember` row for the workspace the
request is for:

| | |
| --- | --- |
| no session, or `suspended` | STRANGER (0) |
| authenticated, no membership in the workspace named | VISITOR (1) — reads `Workspace`, nothing else |
| `viewer` · `billing` | READER (2) |
| `developer` | USER (4) |
| `admin` | ADMINISTRATOR (5) |
| `owner` | OWNER (6) |
| `User.isSystemAdmin` | SYSADMIN (7), above any membership |

Three things about it are the decision rather than the arithmetic.

**The standing goes on the PRINCIPAL, not on the client.** Junction scopes the
Litestone client in an around hook installed by `createApp({ db })`, before any
hook knows which workspace is being addressed — and `getTable()` re-derives its
own scoped copy from `ctx.auth.user` on first use. A standing put only on
`ctx.locals.db` is therefore dropped the moment a service touches a model.
`applyStanding()` builds a fresh principal carrying `memberRole`, assigns it to
`ctx.auth.user`, and re-scopes from that. Fresh, never a mutation: over
WebSocket the session is resolved once at upgrade and shared by every frame on
that socket — and the internal-call path freezes it — so mutating would either
throw or leak one call's role into the next.

**It re-resolves when the workspace changes mid-request.** The workspaces
service addresses `ctx.id`, not the header, and an admin of the workspace they
are looking at must not carry level 5 into a patch of a different one.

**The hooks stay.** A gate refuses with a level; `requireWorkspaceRole` refuses
with the sentence a person can act on (*requires admin or owner in this
workspace — you have developer*). Two ladders over one membership row, so they
cannot disagree about who the caller is, only about what they say when refusing.
The gate is the boundary and covers what a hook cannot: an engine calling a
service in-process, a custom action nobody wired a hook onto, a where-clause
built by hand.

**What a gate deliberately does not do is scope rows.** It is per model:
*may this caller touch Server at all*, never *may they touch THAT server*.
Tenancy stays the `workspaceId` filter in every service read plus
`scopeToWorkspace` refusing a non-member. Expressing it as `@@allow` is the next
step and is not claimed by this ruling.

**2026-08-10 · A tier above every tenant is a SEPARATE service, and the bit
that grants it is a column named for the standing it grants.**

Basecamp's four sysadmin screens read across every workspace. Nineteen of its
twenty services take `X-Workspace-Id` and refuse without it, so there were two
ways to answer them, and only one of them scales down to being wrong safely:

| | |
| --- | --- |
| Widen the existing services with `?scope=hub` | The tenancy decision moves into a **query string**, on nineteen services, each of which has to get it right. Nineteen chances to leak every tenant, and the one that forgets looks exactly like the eighteen that did not |
| One new service behind one hook | One place to be wrong. `requireSystemAdmin` is the whole guard, and `/hub` is greppable |

The second. What makes it hold is that the hub service takes **no workspace at
all** — there is nothing for a caller to widen. It reads through `asSystem()`,
not as a convenience but because `User` is the model auth's own fragment gates
at level 8, which even SYSADMIN(7) does not reach: no caller-scoped client can
read a user list, so writing those reads any other way would have meant
rewriting them when the gates landed. They landed the same day, and the hub
needed no change.

**The privileged bit is `User.isSystemAdmin Boolean`, and the name is
load-bearing.** Not auth's `role` — that column defaults to `"user"`, nothing in
the app reads it, and putting the grant there would give one column two owners.
Not an env allowlist, which cannot be granted or revoked by the people who need
to. The name is the one `sessionGateLevel()` already grades **SYSADMIN(7)** on
(`junction/src/core/litestone.ts`), so the column filling these screens today is
the column `@@gate` will read tomorrow. The cost, accepted: two fields beside
each other that both look like privilege, so the schema comment says which one
this app enforces on.

**Refusal is 404, not 403.** The hub is not a screen someone is being refused;
it is a surface they have no business knowing exists — the same reasoning the
workspaces service already uses for a workspace you are not a member of.

*Lives in:* `packages/basecamp/api/src/services/hub/hub.service.ts`,
`api/src/core/hooks.ts` (`requireSystemAdmin`); 4 data tests, 25 browser checks.

**2026-08-10 · A status column that nothing reads is not a state, and
suspension needs a door on each side.**

`User.status` had been a free `String` since the schema was written, and
@frontierjs/auth — which owns the model — never looks at it. So "suspended" was
a word the app could store and nothing anywhere would honour: a Suspend button
would have reported success and revoked nothing. The same would have been true
of a new `Workspace.status`.

Three things together make it real, and none of them is sufficient alone:

1. **The vocabulary is an enum** (`UserStatus`, `WorkspaceStatus`), so the
   column carries a CHECK and the service's copy of the list is held against it
   by a test in both directions. A free string beside a service that invents
   values is the shape that let `AlertRule.severity` default to a value its own
   API refused.
2. **The front door refuses.** A suspended user cannot sign in — checked AFTER
   the password, so the refusal does not tell an unauthenticated caller which
   addresses are suspended accounts.
3. **The already-open door refuses.** A token issued before the suspension stops
   resolving, at an app-level `before: all` hook. Deleting the `Session` rows is
   not enough on its own: an API key is a `Credential` and survives that.

For a workspace the one door is `scopeToWorkspace`, the hook every scoped
service already runs — so suspension bites in nineteen places by being written
in one. And it is **not** deletion: `@@softDelete(cascade)` stamps every child,
a status change stamps nothing, and conflating them would make a reversible-
sounding action unrecoverable.

*Lives in:* `packages/basecamp/api/src/core/session-auth.ts`,
`api/src/core/hooks.ts`; pinned by db tests and by `verify.mjs` § 13f.

**2026-08-10 · A machine account is created from an admin screen. A human is
not.**

The hub's Users screen creates `UserKind.bot` accounts and deliberately ships
without the mock's Invite button. The asymmetry is the whole point: creating a
bot hands nobody anything — it has no password credential, so there is no way
for it to sign in, and its only route in is an API key issued to it separately.
Creating a human from the same screen would be an administrator minting an
account with a password only they know, which is why the human path is
invite → accept and stays unbuilt (`FJS-032`).

Three rules fall out of it, each refused by name at the API:

- **A bot's address is at `bots.invalid`** — RFC 2606 reserves the TLD, so it
  resolves nowhere. `User.email` is required and unique and a bot has no inbox;
  a plausible-looking address would eventually be mailed.
- **A bot may not own a workspace.** An owner is the one member `removeMember`
  refuses to remove and the one role that can delete the tenant.
- **A bot may not hold the hub tier.** `isSystemAdmin` is a revocable human —
  the point of it is that somebody can be asked why they used it.

It also closes a gap `api-keys.service.ts` had recorded in its own comment since
Phase 6: a key was always minted for the caller, because nothing else existed to
own one, so CI's key was a person's key and revoking it when they left broke the
pipeline. A key may now name a bot — and only a bot, only in this workspace, and
only one that does not outrank you.

*Lives in:* `packages/basecamp/api/src/services/hub/hub.service.ts`
(`createBot`), `api/src/services/api-keys/api-keys.service.ts`
(`assertBotOwner`).

**2026-08-06 · Raw SQL is available through `asSystem()` only, on any schema
that declares access rules.** Fixes `FJS-005`.

`db.sql` goes straight to the read connection — no `@@gate`, no `@@allow`, no
`@guarded`, no `@scoped`, no `@@softDelete`, because all of those are enforced
above SQLite. For a deliberate escape hatch that is defensible. What was not is
that it was the **same function on every proxy**: `db.$setAuth(user).sql` closed
over the user and never read it, so a caller who had done everything right got
every row in the table, silently. Measured on one model with `@@allow` +
`@guarded` + `@@softDelete`:

```
$setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
$setAuth({id:1}).sql`SELECT * …`      → 3 rows, ssn plaintext, another owner's
                                         row and a soft-deleted one included
```

**The unscoped client was the wider gap, not the narrower one.** An
unauthenticated `db.invoice.findMany()` returns **0** rows — the policy
evaluates with `auth() == null` and matches nothing — while `db.sql` returned
all 3. So the defect is not "the scoped proxy drops its scope"; it is that raw
SQL ignores the schema on every path and the ORM never does. That is why the
rule covers `db.sql` too, overturning `IDEAS/scoped-sql.md`'s "unchanged".

The rule:

| Surface | Schema declares access rules | It does not |
| --- | --- | --- |
| `db.sql` | **throws** | unchanged |
| `db.$setAuth(u).sql` | **throws** | unchanged |
| `db.asSystem().sql` | works — the documented bypass | works |

"Access rules" means `@@gate`, `@@allow`/`@@deny`, `@guarded`, `@encrypted`/
`@secret`, field-level `@allow`, `@scoped`. **Not** `@omit` or `@@softDelete`:
those shape what a read returns rather than who may read it, and refusing raw
SQL for a soft-delete column would fire on most schemas for a lifecycle rule.

**Coarse per schema, not per statement, on purpose.** Deciding per statement
means parsing the statement, and a hand-written SQL validator that is subtly
wrong grants a FALSE guarantee — worse than an honest raw hatch, because people
trust it. The escape routes are numerous and all real in SQLite (`main.` and
`temp.` qualification, `ATTACH` — which litestone exposes on the proxy —
`PRAGMA`, views created mid-statement, comment and string-literal tricks).
SQLite's own authorizer would be the right mechanism and **`bun:sqlite` does not
expose it** (verified: `Database` has no `setAuthorizer`).

The refusal names both ways forward: `asSystem().sql` to bypass deliberately, or
`where: { $raw: sql`…` }` to stay on the ORM — verified to keep every policy
(1 row, `@guarded` column still withheld).

**Scoped raw SQL as a capability — a per-identity view set — is NOT built.**
`IDEAS/scoped-sql.md` designs it; it is a feature where this is a defect, and
the consumer that made it urgent (`herald`, the AI agent surface) does not exist.
Revisit with `herald`.

*Lives in:* `packages/litestone/src/core/client.js`
(`schemaDeclaresAccessRules`, `rawSqlRefusal`, `_runRawSql`); 9 tests in
`test/litestone.test.ts` § "raw SQL and the access rules it cannot enforce",
5 of which fail if the refusal is removed.

**2026-08-01 · Gates enforce by default when declared; undeclared imposes nothing.**
Any model with `@@gate` is enforced from the first request via the shipped
`FrontierGateGetLevel` resolver (null user → STRANGER) even with no GatePlugin
installed. A user-supplied `GatePlugin({ getLevel })` replaces the resolver
entirely. Models without `@@gate` are completely open. `asSystem()` bypasses
(except LOCKED). Rationale: a declared gate that silently does nothing is a
fail-open security default — verified live before the fix.
*Lives in:* `packages/litestone/src/core/client.js` (default plugin injection);
tests in `test/elegance-fixes.test.ts`.

## Query & write semantics (Litestone)

**2026-08-17 · Litestone has atomic update operators, and the COLUMN decides
one is an operator at all (`FJS-D27`).** `increment` `decrement` `multiply`
`divide` on a numeric column, `push` on an array one, on `update` and
`updateMany` only. Read-modify-write loses data — two callers read a counter,
both add one, the second write overwrites the first — and `@version` does not
fix that, it turns it into a thrown conflict the caller has to retry. `UPDATE t
SET views = views + ?` needs no read and cannot race.

The argument against was that the payload is otherwise VALUES, which is what
makes `writeData` simple enough to strip unknown keys safely: `{ views: {
increment: 1 } }` and `{ addr: { city: 'x' } }` are one shape to a parser. **They
are not one shape to a parser that knows the column**, and this one does — the
same resolution the where-side already makes between a typed-Json path and an
operator block. So a `Json @type(T)` column keeps taking an object, a numeric
column reads `increment` as an operator, and everything else is refused by name.

Refused, each with the reason: an operator on a column whose declared type
cannot carry it · an operator on `create`/`createMany` (there is no value to
change) or on `upsert`/`upsertMany` (its fast path SETs from `excluded` and its
slow path calls `update()` — one could apply the operator and the other could
not, which is the drift a refusal exists to prevent) · `divide: 0`, which SQLite
answers as NULL with no error · two operators on one column, where evaluation
order would decide the answer · an enum array pushed a member the enum does not
declare · **and a column carrying `@lt` `@lte` `@gt` `@gte` `@maxItems`
`@uniqueItems`**, because the new value is computed inside SQLite where
`validate()` never sees it, and a validator that silently stops applying is
worse than one that says it cannot. `@minItems` is not in that list: push only
grows.

`push` appends (`json_insert(coalesce(col,'[]'), '$[#]', ?)`) and takes one
value or several. The `coalesce` is the load-bearing half — `json_insert(NULL,
…)` answers NULL and raises nothing, so a push into a NULL column would drop the
value and report success. On a column that is not a declared array, `json_insert`
is a silent no-op (an object) or malformed JSON (a scalar), which is why the
declared type is the only thing that makes it safe.

*Lives in:* `extractWriteOps` in `packages/litestone/src/core/client.js`;
`test/write-operators.test.ts`; `docs/querying.md` § Atomic update operators.

**2026-08-16 · A write announcement has two shapes, and the write says which
(`FJS-307`).** `scope: 'row'` — one row changed, `result` is it, or `null` where
`select: false` skipped the RETURNING. `scope: 'collection'` — `count` rows
matching `where` changed, from a statement that never built them. The
discriminator is STATED, never read off `result`, because `result: null` is not
one fact: a `select: false` write is row-scoped and has no row, and treating that
as *no rows* is exactly what dropped it a layer up. Every write method announces;
seven did not, and a write matching no rows announces nothing.

**2026-08-16 · `announce` is per CALL, with a client-level floor (`FJS-D34`).**
`collection` (default) · `rows` · `none`; precedence option → `createClient({
announce })` → `collection`. **Not per model**, and not adaptive on size. Per
model was the tempting one — it is where `@@log` and `@@softDelete` live, and
declared-in-the-seed is the house thesis — but the batch size is a property of
the CALL: one `Order` model carries both a three-row cancel and a
two-million-row purge, and a model-level flag materialises the purge. Adaptive
was the other tempting one and it is not decidable: the count is unknowable
before the statement without a second query, so a threshold would have to spend
the memory before it could apply. Prior art is uniform on the shape and split on
the dial — Sequelize per call (`individualHooks`), Django per method, Rails per
verb, Ecto and Prisma refuse the question. `none` exists because a nightly purge
nobody is watching should not send every tab back to the server either, and
because *no subscribers* is not something a caller can express. An unrecognised
value is refused BY NAME before the statement runs: `announce: 'row'` is somebody
who wanted per-row announcements, and quietly handing them the coarse one is the
class of bug `FJS-307` closed.

**2026-08-01 · Unknown `where` fields: WARN on reads, ERROR on writes.**
Reads log once per model+field (did-you-mean hint) and still execute; writes
(update/delete/restore/upsert families) reject — a typo'd filter on a write is a
mis-scoped destructive operation. `AND/OR/NOT` are descended into; relation
sub-filters are not (their keys belong to the related model).

**2026-08-01 · Unknown `data` keys are silently stripped.**
Mass-assignment protection: pass a request body straight in without
whitelisting. This deliberately REPLACED an earlier reject-with-did-you-mean
behavior — do not restore the rejection. Safety net: a typo on a *required*
field still fails loudly via the required-field pre-flight.

**2026-08-01 · `take`/`skip` are rejected with a pointer to `limit`/`offset`.**
Prisma muscle-memory must fail loudly and helpfully, never be silently ignored.

**2026-08-01 · Missing required fields on create are a ValidationError.**
`name is required`, same shape as every other field rule — never a raw SQLite
`NOT NULL constraint failed`. Exempt: optional fields, arrays (implicit `[]`
DDL default), `@default`/`@updatedAt`/`@sequence`/generated/computed/`@from`,
`Int @id` (autoincrement). Applies to create/createMany/upsert-insert only —
updates stay partial.

**2026-08-01 · `@@strict` model flag: PARKED.**
(Would escalate read-warnings to errors per-model.) Revisit after the warnings
have been observed in practice; the warn infrastructure makes it nearly free.
*All four above live in:* `packages/litestone/src/core/client.js`
(`withArgValidation`, `checkWhereKeys`, `writeData`); tests in
`test/elegance-fixes.test.ts` and the rewritten block in `test/litestone.test.ts`
("write payload — unknown fields are silently stripped").

**2026-08-13 · Clock-relative derived fields: `@derived(expr)`, evaluated at query time.**
Supersedes the ruling written earlier the same day, which said no such tier
should exist. That ruling's reason does not hold: SQLite refuses a
non-deterministic function in a `GENERATED ALWAYS` column, because the column is
part of the table — it has no objection to the same expression in a `SELECT`, a
`WHERE` or an `ORDER BY`. Verified: `(dueAt < ? AND completedAt IS NULL)` works
in all three positions against one bound instant. The restriction was about a
storage strategy and was mistaken for a restriction on derivation.

```prisma
overdue Boolean @derived(dueAt < now() && completedAt == null)
```

Compiles three ways from one declaration — a SELECT expression for the value, a
substitution into `WHERE` to filter by it, a substitution into `ORDER BY` to
sort by it. This is not new machinery: `@from` already substitutes its subquery
into all three, and `where: { subCount: { gt: 1 } }` already works. A `@derived`
field is the same seam carrying a scalar expression instead of a subquery, with
the request's single instant (see `FJS-227`) as the bound parameter.

**Not `@generated`, and not a raw SQL string.** `@generated` creates a real
column — stored, migrated, indexable — and an attribute that sometimes creates a
column and sometimes does not is a migration trap. And the body must be the
**declarative expression language** `@@allow` already uses, not SQL text,
because a SQL string cannot travel: the browser cannot evaluate it. Being data
is the whole point.

**The client half is the reason this tier earns its place.** The JSON Schema
carries the expression and its dependency on `now()`, so a Mesa component knows
both that the value decays and how to recompute it — against the **viewer's**
clock and timezone, on a timer, without a refetch. Server and client can
therefore disagree by a few seconds; the viewer's clock wins for display, which
is correct. Litestone already compiles this language two ways (`compileSql`,
`evalJs`) and `verifyRowPolicies` already grades one against the other, so the
client evaluator is a function that exists and is tested. Unlike the four
`x-litestone-*` keys with no reader anywhere, this extension ships with its
consumer.

**The expression language gains a ternary**, right-associative and nestable:
`dueAt < now() ? 1 : 0`. It compiles to `CASE WHEN … THEN … ELSE … END` in SQL
and to a ternary in JS — **both halves or neither**, since a form added to one
compiler and not the other is the `FJS-195` defect exactly. This is also the
point at which the language stops being predicate-only and starts producing
*values*, so a `@derived` field's declared type is checked against its branches
at parse time.

**What survives of "store the boundary, not the state":** it was right about
what to *store* and wrong as a claim about what can be *derived*. `dueAt` is
still the column; `overdue` is a projection of it, not a second copy of the
truth. Nothing about a row's state is duplicated, so nothing can drift.

**Scopes shrink back to query shape.** A derived boolean gives
`where: { overdue: true }` for free, which was most of what a schema-level
`@@scope` was for. The existing `createClient({ scopes })` registry — named
fragments, chaining, all read methods, documented merge rules — keeps the cases
that are about the *shape* of a query rather than a fact about a row: bundled
`orderBy`, `limit`, `include`, and composition.

**2026-08-13 · Amended the same day: three tiers, not two. `@@scope` is
reinstated.** The paragraph above collapsed two different things into the
function registry, and the cell it emptied is one nothing else fills.

| | Declared in | Materialises a property? | A browser can name it? |
| --- | --- | --- | --- |
| `@derived(expr)` | schema | **yes** — row, generated type, JSON Schema, generated form | yes — `where: { overdue: true }` |
| `@@scope(name, expr)` | schema | **no** — a name and a predicate | yes — `where: { $scope: 'overdue' }` |
| `createClient({ scopes })` | JS config | no | **no** — server-side only, `db.task.overdue()` |

**The registry cannot be named by a browser, and that is the whole argument.**
Sierra's `createResource` sends a `where` **object** over HTTP; it cannot invoke
`db.task.overdue()`. Ruling that scopes live in the registry therefore moved
every query-shape scope to server-only without saying so. `$scope` is the one
spelling that travels.

The second cost is shape. `@derived` buys its filter by adding a property to the
model — carried in every SELECT, present in the generated type, in the JSON
Schema, and in any form built from it. Where the predicate is only ever a way to
*ask*, that surface is waste and it misdescribes the model.

`@@scope` is also about half the work: predicate-only, so `compileSql` alone —
no `evalJs` value branch, no dependency on the ternary (`FJS-234`), no branch
type-checking, no client evaluator, no JSON Schema property. What it adds is a
published name list, so `$checkWhere` accepts `$scope` and the client knows which
names are legal.

**The rule that keeps them apart: if the UI ever renders it, it is `@derived`; if
it only ever appears in a `WHERE`, it is `@@scope`.** A `@@scope` may reference a
`@derived` field.

`{ $scope: 'overdue', status: 'open' }` conjoins, and `$scope: ['overdue',
'mine']` is legal and also conjoins. Invariant 8 holds without an exception: a
`$scope` value is a **name looked up in a declared table**, never text
interpolated into a pattern — state that at the site, because it is exactly the
shape the invariant warns about.

**2026-08-14 · A commit scope is a declared wrapper, not a new hook phase.**
`FJS-089` asked for a phase that means *the call succeeded*. Junction gets
`transactional: true` on a service definition instead — a derived `around` hook
that wraps the whole pipeline in one `$transaction`.

**Why not an `afterCommit` phase.** It would promise durability it cannot
deliver. Rails' `after_commit` fires after the transaction is gone, so a process
that dies between the commit and the callback loses the effect and nothing
reports it; Rails documents that a callback raising there does not roll anything
back. A phase named for the commit invites people to put irreversible work in it
on the strength of a guarantee it does not have. `transactional:` makes exactly
one promise — the write is atomic with the rest of the pipeline — and keeps it.

**Why `around` and not a longer `before`.** `around` is the only phase that
reaches the after hooks, which is the whole point: an `after` hook throwing has
to roll the write back.

**What it deliberately leaves open.** A transaction rolls back rows, not SMTP.
The side-effect half of `FJS-089` is unanswered, and the route to it is the
transactional outbox — turn the effect into a row, which this can already roll
back. Where that table lives is undecided: Caravan's queue is its own SQLite
file today, so `app.jobs.dispatch()` from a hook buys retries and not atomicity,
and putting the table in the app's own database (a schema fragment, the way auth
contributes `User`/`Session`) is what would make the two one transaction.

**Not the default.** `BEGIN IMMEDIATE` holds SQLite's single write lock for the
whole pipeline including the after hooks, so an `after` hook doing network I/O
serialises every write in the app behind it. Declaring it is how an app says
that trade is worth making for a given service.

**It required a Litestone fix first** (`FJS-244`): `$transaction` treated a
concurrent caller as a nested one, so a second request's writes rode the first
request's rollback. This feature opens a transaction on every mutating request
and would have made that the normal path.

**2026-08-15 · A soft-deleted row KEEPS its `@unique` values.** The slot is not
released, and `create` naming a value a deleted row holds is refused — by name,
with the row's id and both ways to release it (`FJS-204`).

The alternative was a partial unique index (`CREATE UNIQUE INDEX … WHERE
"deletedAt" IS NULL`), which frees the slot and is what "the row is gone" would
imply. Rejected on two grounds and the first is decisive: **it makes `@unique`
false for any read that includes deleted rows.** `findUnique({ code },
withDeleted: true)` would legitimately match two rows, and every export, audit
query, migration and `release:check` that reads with deleted rows would see
duplicates on a column declared unique — a worse incoherence than the one being
fixed. Second, it makes `restore()` conditionally impossible: soft delete's
whole contract is a way back, and a way back that fails because a stranger took
the value in the meantime is not one.

Cost of the rejected option, for the record: SQLite cannot make an inline
`UNIQUE` partial, so every constraint would have to be re-emitted as an index
and every affected table rebuilt — 15 of basecamp's 37 models, `User`,
`Workspace`, `Domain` and `App` among them.

**Releasing a slot is therefore explicit**, which is the point: the row still
owns the value, so change it (`update({ where, data, withDeleted: true })`) or
stop keeping the row (`delete({ where, withDeleted: true })`). An app that lets
a departed user's email be re-registered says so in its account-deletion flow
rather than getting it as a side effect of a DDL choice.

No per-field opt-out. It would reintroduce the two-rows-claim-one-identity
problem per column, and nothing in the repo needs it yet.

**2026-08-18 · There is no `@@history` block, and the seed will not grow one.**
(`FJS-D39`, from the argument that produced `FJS-341` and `FJS-342`.)

The proposal was a fourth axiom — *one history* beside one origin, one name, one
owner — realised as a model-level declaration:

```
@@history(revision: version, actor: updatedBy, at: updatedAt)
```

The observation behind it stands and is worth keeping: the three axioms all
describe a fact **at a moment**, while most of the hard machinery here is the
same fact **at two times** — optimistic concurrency, a live store going stale,
an idempotency replay, at-least-once outbox delivery, a cron fire arriving
twice, a release pivot, a snapshot graded against a base ref. Eleven mechanisms
were counted, each argued well in isolation, none derived from anything.

**The declaration is refused; the consolidation was right.** `@@history` fails
the framework's own review (§V of `PHILOSOPHY.md`) on the two questions that
matter most:

- *Can it be derived instead of restated?* It already is. `@version`,
  `@updatedBy` and `@updatedAt` are declarations in the seed; `buildVersionMap`
  derives the revision field from them and `x-version` carries it to the
  browser. A model-level block naming those fields is a **second place to state
  one fact**, and the two can disagree — `@@history(revision: foo)` over a `foo`
  carrying no `@version` is a legal sentence with no meaning.
- *Does it enlarge the concept budget?* By one noun that buys no capability.
  Auto-adding a missing version column is scaffolding, not a fact; pairing actor
  and timestamp is sugar over two annotations that already pair themselves. The
  one genuine capability nearby — a revision keyed on a timestamp rather than an
  integer — is `@version` on a `DateTime`, a question about which types the
  existing annotation accepts, not a new noun.

**What the gap actually was, and both halves are closed.** Not a missing
declaration: a missing OWNER, twice.

- The revision was recorded from the wrong source. `createResource` remembered
  it off the store, so a WS push moved the number while moving nothing the
  person was looking at, and a draft saved afterwards carried a revision nobody
  had read (`FJS-341`).
- The occurrence key had no definition. Four mechanisms built one at their call
  sites and two interpolated caller-supplied text into it, so a job named
  `report:daily` and a job named `report` shared a fire id
  (`@frontierjs/toolbelt/history`, `FJS-342`).

Both were fixed without a word of new schema language. **That is the test a
proposed axiom has to pass here**: it earns a seed declaration by naming
something the seed cannot already say, and this one could not. The `/history`
kit deliberately ships the occurrence half ALONE — a revision-comparison export
would have no caller, and an export nothing asks for is the concept budget spent
on a guess.

Standing consequence for any future *fourth axiom* proposal: state which
declaration it adds, then check whether the annotations already in the seed
derive it. If they do, the work is an owner, not a word.

## Migrations (Litestone)

**2026-08-17 · A rebuild that would destroy an app-created schema object is
BLOCKED, not warned about (`FJS-183`).** `rebuildSQL` drops the table, which
takes every trigger and index on it; litestone's own are regenerable from the
schema and are restated afterwards, and one the app wrote exists only in the
live database with nothing to restate it from. Naming them in a comment above
the SQL was the earlier answer, and it was the wrong one for the reader who
matters — somebody applying a generated migration without reading it, which is
who a generated file is for. The rebuild is emitted commented out with the ways
forward, the same shape an un-defaultable new column already used, because both
are *litestone cannot decide this for you* and one mechanism for that beats two.
`autoMigrate` reports `state: 'blocked'` with the same list and writes no hash,
so it resurfaces every startup.

Re-emitting a captured trigger verbatim was the third option and is not taken:
its body may name a column the rebuild drops, so it would restate SQL that fails
at CREATE or, worse, at the next write.

**2026-08-01 · The executor owns the transaction.**
`apply()`/`autoMigrate()` strip in-file `BEGIN/COMMIT` + FK pragmas and provide
the real thing: one transaction per migration, ROLLBACK on failure,
`recordMigration` committed atomically inside it, FK pragma restored in a
finally. Generated files keep the in-file pair for hand-running in a sqlite
shell only.

**2026-08-01 · Rebuilds copy only the old∩new column intersection.**
Added columns are never named in the copy-SELECT (SQLite's double-quoted-string
fallback turns unknown identifiers into literals — this silently corrupted or
destroyed data). A rebuild that adds a NOT NULL column with no default is
generated BLOCKED (commented out, with fix options); `autoMigrate` reports
`state: 'blocked'` and does not write its hash, so it resurfaces every startup.
*Both live in:* `packages/litestone/src/core/migrate.js` + `migrations.js`;
tests in `test/migrations-fixes.test.ts`.

**2026-08-16 · `FJS-D09` — there is no `down`. The way back is a copy taken
before the run, and `--backup` is where it comes from.**

A generated `down` cannot undo the migration it reverses. A rebuild is a `DROP
TABLE`, so the inverse of *drop a column* is *invent the values it held*, and
the inverse of a JS migration that rewrote every row is unwritable by anything
but the person who wrote it. What a down migration reliably does is run, report
success, and leave a database that looks restored — which is worse than having
none, because the operator stops looking for the backup.

**The framework already grades this question, and the two halves fit.**
`release:check` classifies a schema change as expand — N-1 still serves, so the
deploy is taken back by redeploying the CODE — or contract, the pivot, after
which only forward. A down migration is not needed for an expand and not
sufficient for a contract. So the only reversal litestone offers is the file:
`litestone migrate apply --backup[=dir]` copies **every** SQLite database the
schema declares before the **first** one is migrated — a copy taken inside the
per-database loop is a copy of a half-migrated fleet — and refuses to migrate
anything at all if a copy fails, which is the whole point of having asked. It is
off by default: a multi-gigabyte copy on every deploy is a cost nobody asked
for, and the deploy that wants one says so.

**The other half is saying it while it is still true.** Without `--backup`,
apply names the pending files it cannot take back: one that drops a table (which
a rebuild is, so a dropped column is in this class) and every `.js` migration,
whose contents nothing here can read. It warns and proceeds — refusing would
make the flag mandatory for the ordinary case, a dev database nobody wants
copied.

**2026-08-16 · `FJS-D09` — a rebuild asserts its own row count before it drops
the original.**

`INSERT INTO t__new SELECT … FROM t` followed by `DROP TABLE t` has a gap in it:
a copy that read fewer rows than the original holds is an error to nobody. Not
to SQLite, which inserted what it was asked for, and not to the runner, which
saw a statement return. One statement later those rows are gone and the
migration reports ✓ — measured by editing a generated copy step, which is a
thing the file's own header invites.

The generated rebuild now compares the two counts between the copy and the drop.
SQLite has no assertion — `RAISE()` is legal only inside a trigger body — so the
comparison is a CHECK on a one-row temp table whose CONSTRAINT NAME is the
message SQLite prints: `CHECK constraint failed: rebuild of post lost rows`. It
aborts inside the migration's own transaction, so the rollback leaves the
original table where it was. It is emitted even when nothing is copied, which is
the case it changes most — a rebuild sharing no column name with the old table
used to empty it under a comment reading *nothing to copy*.

**2026-08-16 · `FJS-D09` — a migration is named after the last file in its
directory, not after the clock.**

Filename order IS apply order, and the stamp is second-granular. Two migrations
created inside one second break that in one of two ways, both silent: with the
same label the second `writeFileSync` overwrites the first and the change in it
is simply gone; with different labels they sort by LABEL, so `evolve` applies
before `initial` and a migration runs against a table its predecessor was to
have created. Neither is hypothetical — a script that creates two migrations, or
a test that seeds and then evolves, is enough.

`nextMigrationName` reads the directory and steps the stamp past the highest one
already there. The timestamp still says roughly when; now it also says after
what. Loosening the name pattern was the alternative and is not available: the
14-digit prefix is where the ordering guarantee comes from.

Closes `FJS-D09`.
*Lives in:* `packages/litestone/src/core/backup.js` (`backupSqliteTo`, the one
owner of copying a live SQLite file — `db.$backup` and the CLI hold different
handles and would otherwise answer *is this copy safe under an open WAL* twice)
· `src/core/migrate.js` (`rowCountGuard`) · `src/core/migrations.js`
(`nextMigrationName`) · `src/tools/cli.js` (`preApplyBackup`,
`irreversibleMigrations`); tests in `test/migrations-fixes.test.ts` and
`test/cli-smoke.test.ts`.

## API design (Junction)

**2026-08-17 · `FJS-D23` — a payload key that is not a column says so in the
seed, with `@transient`, and Junction lifts it onto `ctx.transients`.**

The other half of `FJS-D22`, and the same shape of answer: that one asks how a
column says *the system writes this*, this one how a payload says *this is not a
column*. Both are facts about a model's write surface, both were conventions
held by a hook and a comment, and both are now a word in the schema.

**The word is in the seed, not on the service.** The alternative on the table was
a service option — `accepts: { secret: 'string' }` that `autoValidate` spares.
It was refused on a measurement: `autoValidate` is derived from a model and runs
on `create`/`patch`/`update` alone, so the only payload a key can be stripped
from is the write payload of a MODEL service. A service with no model validates
nothing and always did pass every key through; `remove` and every custom method
are untouched. So the option would have added vocabulary for a surface that has
no problem, and left the surface that does with two places to look.

**It is the mirror of `@computed`, and that fixes its meaning.** Both are fields
with no column; they differ in which way the value travels.

|              | column | caller writes | caller reads |
| ------------ | ------ | ------------- | ------------ |
| `@computed`  | no     | no            | yes          |
| `@transient` | no     | yes           | no           |
| `@system`    | yes    | no            | yes          |
| `@guarded`   | yes    | no            | no           |

Everything downstream follows from the mirror rather than being decided again:
`@computed` is emitted into the READ modes of the generated JSON Schema and
`@transient` into the WRITE modes, marked with `writeOnly` — the keyword
`readOnly` is the other half of. `@computed` is out of the create/update types
and `@transient` is out of the row type and out of `Where`. Both are absent from
the DDL, and `isStoredField` in `ddl.js` is now the one answer to what becomes a
column, because `CREATE TABLE` and the rebuild's `INSERT … SELECT` were asking
it separately and had already drifted.

**The value leaves the payload, and lands somewhere the framework owns.**
`autoValidate` validates a transient key with the model's own rules — `@length`,
`@required`, the `@label` in the message — and then MOVES it to `ctx.transients`.
It has to leave: the Data boundary refuses a transient key by name, so a service
passing `ctx.data` on whole would fail the write rather than the field. And it
has to be validated first, because validating it is most of what declaring it
buys.

`ctx.transients` is a fifth context field rather than a corner of `locals`, and
the rule that separates them is who writes it: `locals` is scratch a hook keeps
its own state in, `transients` is call INPUT the framework parsed — the same
thing `directives` is to the `$`-params the bridge splits off a query. Fresh
`{}` per call, does not propagate, no seed option; a model declaring none leaves
it `{}`, so `ctx.transients.x` is a read rather than a crash everywhere.

**A bulk write carrying one is refused by name.** The rows a service receives are
the ones that PASSED validation — `partitionBulk` parks the rest — so an
index-aligned array of per-row transient values would pair one row's credential
with another row. A correlation bug that silent is worse than a refusal that
says *send the rows one at a time*.

**What the declaration buys, stated:** the browser gets it. Sierra registers the
create-mode schema, so a declared transient field reaches `buildFieldRules`,
`<Form>` renders a control for it, and `createResource`'s own coercion and
validation apply the schema's rules to it — where a wire-only field known to a
server hook alone was stripped in the browser before the request was ever made.
A typo is now distinct from a field the model does not have. And nothing that
reads a row can see it: not the DDL, not `@@log(audit)`, not a `where`, not an
`orderBy`, not a policy predicate, each refused by name with the reason rather
than by SQLite reading an unbindable identifier as a string literal.

**Refused along the way**, all by the same test — does the attribute describe
storage, derivation or a read?

- **`@default`, `@unique`, `@index`, `@encrypted`, `@guarded`, `@system`,
  `@omit`, `@check`** and sixteen others beside `@transient`: each names a
  column that does not exist. `@@index([secret])` would have built an index over
  nothing and reported success.
- **A field `@allow('write', …)`.** The rule is evaluated at the Data boundary,
  which the value never reaches, so it would be declared and never run.
  Half-enforcement reads as enforcement.
- **Keeping it a hook concern** — the 2026-08-08 ruling below, which stands as
  the description of what a service does with the value and is superseded only
  in where the value comes from. Its own cost paragraph is what closed this:
  *nothing enforces this; the framework cannot tell one from a typo.*

*Lives in:* `packages/litestone/src/core/parser.js` (`@transient` + its
conflicts), `src/core/ddl.js` (`isStoredField`), `src/core/client.js` (the write
refusal, the filter/sort/aggregate reasons, the policy check),
`src/jsonschema.js`, `src/tools/typegen.js`, `src/testing.js`;
`packages/junction/src/core/context.ts` (`ctx.transients`),
`src/core/litestone.ts` (`liftTransient`), `src/transport/bridge.ts`,
`src/core/app.ts`; `packages/sierra/src/junction/field-rules.js` (`writeOnly`).
Tests in `packages/litestone/test/transient-field.test.ts`,
`packages/junction/tests/{context-contract,real-litestone-client}.test.ts`,
`packages/sierra/tests/form-fields.test.js`. Proven in basecamp's `channels`,
where `captureCredential` is deleted.

**2026-08-16 · `FJS-D10` — the deferred API cluster, ruled. Two adopted, two
refused, and the fourth item turned out to be a defect wearing a naming
question.** Four proposals deferred 2026-08-01 pending `FJS-D06`. Graded one at
a time, because they were only ever related by having been deferred together.

**1 · `IAuth` partial acceptance — ADOPTED. `{ verifySession }` is a complete
provider as far as Junction is concerned, because that is what Junction calls.**
The interface declares six methods. Junction invokes exactly two of them:
`verifySession` (`transport/http.ts`, on the HTTP and the WS path) and
`sessionFor` (`core/app.ts`, behind `runAs`, which already throws by name when a
provider lacks it). `login`, `logout`, `createUser` and `deleteUser` are called
by `@frontierjs/auth`'s own `/auth/*` routes and by nothing in this package — so
Junction was demanding six to use two, and an app wanting to authenticate
against something it already has had to stub four methods that would never run.
A stub that throws is indistinguishable from a provider that works until the day
something calls it.

Under `FJS-D06` an auth backend is a **Provider**, and the rule a Provider
contract follows is **declare what you call**. So the type splits: Junction's
requirement is `verifySession`, with `sessionFor` optional, and the full
six-method contract stays `IAuth` — the thing a complete auth package
implements and the thing `/auth/*` needs. `IAuth` extends the narrow one, so
`@frontierjs/auth` is unaffected and every existing caller still typechecks.

**2 · `publish()` string shorthand — REFUSED.** The proposal is
`publish('posts')` beside today's `publish(fn)`. The declarative spelling
already exists and is `channel: 'posts'` on the service, and
`svc.pipelines()` **refuses a service that declares both**, naming the method.
So a shorthand would be a third way to say what two already say, one of which
exists only to police the other. `publish(fn)` earns its place by deciding a
channel per record; a constant does not need a function, and `channel:` is
where a constant goes.

**3 · Typed `createSchema` inference — REFUSED as filed, adopted in the cheap
form.** Full zod-style inference means `parse()` returning a type derived from
the field map. The argument against it is the thesis: **the seed is where types
come from.** A model service is validated by `autoValidate` off the generated
JSON Schema and has no hand-written schema at all; `createSchema` is the hatch
for a shape the seed does not describe. Conduit already documents the seam as
validator-agnostic — *`createSchema`, zod, valibot or a hand-written predicate
all satisfy it* — so building an inference engine here means competing with zod
on zod's ground, for the case the framework tells you to avoid.

What the filing was really reaching for is that `parse()` answers
`Record<string, unknown>`, so a custom method's body casts. That is answered by
letting the author state the type they already have —
`createSchema<CreateOrder>({ … })`, with the field map constrained to
`CreateOrder`'s keys so coverage is checked — which is a signature change, not
an engine.

**4 · `createClient` options grouping — REFUSED. `setters`/`getters` →
`read`/`write` — ADOPTED IN NAME, BLOCKED IN FACT.** Grouping 22 flat options
into namespaces does not touch the thing that is actually hard to hold, which is
the precedence ladder between four of them (`databases: ':memory:'` >
`databases: { main: { path } }` > `db` > the declaration). Renaming the
container leaves the ladder exactly as subtle and breaks every app to do it.

`setters`/`getters` are the wrong words and `read`/`write` are the right ones —
a delete is not a set, and `SETTER_OPS` has always listed the deletes. That is
`FJS-D06` §1's tiering applied: these are **Hooks**, they mutate `args`, and
`write` is the alias the filing asked for.

**But the rename is held, because grading the name uncovered that the mechanism
does not work.** `hooks.before.all` expands over sixteen declared operations and
**four of them ever reach the runner** — `create`, `update`, `findMany`,
`findFirst`, `count`. Every delete, every bulk write, `upsert`, `findUnique` and
`search` are silent; `exists` runs for a directly-named key and is in neither
set, so `all` misses it too. Measured, not read. An audit or stamping hook
registered on `all` therefore does not see a `deleteMany`, and nothing says so.
Renaming the keys first would give an accurate name to a broken mechanism and
make the hole harder to find, so `FJS-288` is wired first and the rename lands
with it.
*Lives in:* `packages/junction/src/auth/types.ts` (`SessionVerifier`) ·
`packages/junction/src/core/schema.ts` (`createSchema<T>`) ·
`packages/litestone/src/core/client.js` (`buildHookRunner`, `FJS-288`).

**2026-08-16 · deferred work runs as the ENQUEUING PRINCIPAL, re-resolved — not
as a system identity, and not as nobody.**

A job had no principal, and no principal is STRANGER(0), refused by the model's
own `@@gate`. The documented workaround was to pass `{ auth: { user: SYSTEM } }`
by hand from every job. Three candidates were on the table; the choice is
between them, not merely for the fix.

**Rejected — SYSTEM by default.** It removes the refusal by removing the
question. Every background write is then made with the app's full standing,
including work a customer asked for: booking a courier for one person's order
would carry the authority of the shop, and the audit trail would name `system`
for all of it, which is exactly what `example` showed before the change. A
default that silently escalates is worse than one that silently refuses, because
the refusal is at least visible.

**Rejected — snapshot the session at dispatch.** One line shorter, and it grades
the caller at the standing they held when they ASKED. A user demoted, suspended
or stripped of a role between the dispatch and the run keeps that authority for
as long as the retry schedule runs — a captured privilege that outlives its own
revocation. Revocation that does not reach queued work is not revocation.

**Ruled — record the id, re-resolve when it runs.** `dispatch()` stores
`app.principal()?.userId`; the worker calls `app.runAs(actorId, …)`, which
rebuilds the principal through `IAuth.sessionFor(userId)` and opens the ALS scope
the handler runs in — so a service call inside a handler names no `auth` and
inherits one, through the same propagation `FJS-D03` gave nested calls. The
standing is whatever the caller holds NOW.

Three consequences, all deliberate:

- **Nobody asked → `createApp({ system })`.** A cron fire, a boot-time enqueue.
  This is the one place an app says who it is when acting on its own behalf, and
  an app declaring none gets `null` rather than an invented privileged identity.
  A cron STATES `actor: null` rather than inferring it, so a timer cannot depend
  on whether an unrelated request happened to be in scope.
- **An unresolvable actor fails the job by name.** A deleted user, or a provider
  with no `sessionFor`. Downgrading to STRANGER(0) is the defect being removed;
  upgrading to the system principal is the rejected option above. Neither is a
  safe fallback, so there is none.
- **`IAuth.sessionFor` proves no credential** and must never be reachable from
  anything a request can name. It is optional on the interface for that reason:
  a provider that cannot honestly answer should not pretend to.

Where it shows: `example`'s audit trail. The `book-courier` write now names the
staff member who pressed Ship, where every background write used to say
`system`. `caravan/tests/job-context.test.ts` runs all of it, including a user
demoted between the dispatch and the run.

**2026-08-16 · `FJS-D20` — the developer-facing auth API. A route is what
ESTABLISHES a session; everything after it is a service. The browser half
belongs to the client that holds the token.**

The question was left open as *what should the surface be*, on the grounds that
`/auth/*` bypasses the Service abstraction. That half was never the problem —
**login cannot be gated by login**, so register, login, logout and the two
recovery flows stay raw routes and always will. The line is whether a call can
be refused for want of a session: if it can, nothing is lost by making it a
service, and a great deal is gained — the hook pipeline, the audit trail, the
schema validation, the WebSocket transport and the browser client, none of which
a hand-written route has. So `GET /auth/me` is now `account.get('me')`, and the
three things an app could not do at all — see where else it is signed in, revoke
one of those, change a password, issue an API key — are services rather than
absences. `logout` stays a route because it is the other half of `login`: one
pair, one owner of the token's life.

**What was actually broken was the other end.** There was no developer-facing
auth API in the browser at all. `client.authenticate()` signed in and stored
nothing; Sierra's `login(token)` stored a token and signed nobody in; and the
two dogfood apps each carried their own `session.js` — 87 and 201 lines — to
bridge that gap, differently. Neither ever called `POST /auth/logout`: signing
out dropped the local token and left the session row valid until it expired, in
both apps, for the whole life of the framework. A surface nobody can use without
rewriting it is not a surface, and the seam it was missing from is not `auth` —
it is the client that holds the token, opens the socket and knows both prefixes.

So the wire half is `client.auth.*` on the Junction client, next to the `IAuth`
contract Junction already declares, and it works with no UI framework at all.
The UI half is Sierra's `session` — a reactive object, a boot restore, and a
`ready` promise the navigation guard awaits, which is the redirect flash both
apps had solved by hand. **The token has one owner**: `tokenStorage` on the
client, so signing in and restoring at boot cannot disagree.

Three smaller rulings fall out, each because the alternative was measured here:

- **A level is opt-in.** `account.me` answers the caller's gate level only when
  the app passes a resolver, because the app owns the role→level mapping and a
  default answer would be a second one that disagrees near a gate boundary.
- **A service name collision is refused at boot, naming the option.** The
  registry is a Map; the alternative is one of the two silently replacing the
  other depending on registration order. Basecamp has its own `api-keys` — a
  workspace's keys rather than a person's — and turns auth's off by name.
- **A 401 keeps the server's own sentence.** The client threw `Unauthorized`
  without reading the body, which is why every sign-in page in the repo
  re-mapped the status to produce "wrong email or password".

Left open deliberately: OAuth (`Credential` already carries the columns), and a
bus for many observers of an auth event — `FJS-042` ruled single handlers, and
that ruling stands.

**2026-08-15 · `FJS-D13` — a stream sits OUTSIDE the result envelope. `kind`
stays `single | list`.**

The envelope answers *what did this call return*: one record or a page of them,
with `total`/`limit`/`offset` and the bulk protocol's `errors`. A stream returns
nothing and then repeatedly, so every field of the envelope is either meaningless
for it or a lie. There is no third `kind`.

**The cost of the alternative is measurable and it is silent.** `kind` is
branched on at ten sites — `envelope.ts`'s own header lists them: the bridge,
`app.service()`, `callService`, `channels.publish`, the WS handler, the browser
client's `find()` and `resource()`, `hooks-builtin`, devtools, `service.ts`. A
third value lands in each of them as *not a list*, which every one of them treats
as a single. That is precisely the drift this module was created to end, and it
would arrive with no error.

**The framework already streams, and it already answered this question the other
way.** `publish()` is an after-hook, so a pushed frame IS `ctx.result` — it has
been through `protect()` and the whole pipeline — and `unwrapResult` strips the
envelope at the wire. Streaming here is *unwrap at the edge*, not *grow a kind*.

**The corollary is the half with teeth: each FRAME is a result; the stream is
not.** `ctx.sse()` is a transport primitive on a raw route, so a stream built
there has no `gateAuth`, no `autoValidate`, no `protect()` and no app hooks.
That is correct for a heartbeat and wrong for records — and the July password
leak this envelope module was written after came from exactly one confusion about
where protection applies. A stream of records belongs on a channel, where the
pipeline produced each frame, or the app writes the protection itself and knows
that it has.

**Enforced, not asserted.** `wrapResult` refuses a `Response`, a
`ReadableStream`, anything with `getReader`, and an async iterable, by name.
Before this it wrapped them: both a Response and a ReadableStream have no
enumerable own properties, so a service method that returned one answered
`{"kind":"single","data":{}}` — an empty object with a 200, the stream destroyed
and nothing said. 5 tests in `tests/envelope.test.ts`.

**What this does not decide.** Whether a service method may *declare* itself
streaming — an action that yields frames through the hook pipeline — is a
feature, and this ruling neither blocks it nor requires it: it says only that
whatever such a thing returns is not a `ServiceResult`. Nor does it decide
per-subscriber filtering of a frame, which is `FJS-011`'s residue and 4.6's
argument; a pushed frame and a streamed frame have the same problem and should
get one owner rather than two.

**2026-08-13 · A service is a definition and a compiled runtime, and `methods:`
declares.** (`FJS-D01`, closing `FJS-016`.)

A Junction service was *options + methods + internals in one object*, ending in
`[method: string]: unknown` so actions hung off the same namespace as
configuration. Two things followed, and both had already shipped bugs.

Nothing could ask what a key meant. "Option or action" was answered by
exclusion — two hand-maintained sets — and six consumers re-applied that rule.
The sets had drifted across five copies once; the option-forwarding list, a
third statement of the same fact, stopped at `hooks` and made
`createService({model, softDelete})` **hard-delete rows** where
`createBaseService` soft-deleted them.

Nothing said when a service was finished being built. `hooks()` mutated the live
service and had to remember to null a cache that four writers touched, the
registry monkey-patched `hooks()` on the instance to recompile, and `callService`
read a ladder in which the cache **beat the app hooks the transport had just
handed it** — so a stale entry was a wrong answer, not a slow one.

**Ruled: go on the split, and only the split.** Export tiering (`FJS-046`) and
the middleware/hook renaming (`FJS-017`) were part of the original proposal and
are refused here; they stay open on their own merits.

*Since:* `FJS-017` closed 2026-08-13 **without** doing what this ruling refused.
It turned out to name three concrete symptoms — three rate limiters with three
vocabularies, a third copy inside `@frontierjs/auth`, and `apiPrefix` resolved by
hand in four files — not a request to merge the two tiers. The limiters became
one definition with three adapters; middleware and hooks remain separate
concepts, and the transport limiter is the argument for keeping them so: it
counts a flood that never reaches a service, which a pipeline hook cannot see.
This ruling stands.

The shape is Feathers 5's, adapted rather than copied:

| Feathers 5 | Junction |
| --- | --- |
| options are a separate `app.use()` argument | options stay on the definition; the built `Service` loses its index signature |
| options behind a `SERVICE` symbol | `describe()` — one answer for /manifest, OpenAPI and /metrics |
| custom methods **declared** in `methods:` | `methods:` declares; the scan is the compat fallback |
| a per-method hook manager owns the chain | `pipelines(appHooks)`, memoised on both inputs |
| `wrapService` guards re-wrapping | `Symbol.for('junction.service')`, and the loader tests it |

**`methods:` inverts.** It used to be validated *against* the scan; it is now the
source of truth, which is what makes an action nameable after an option key —
`cache`, `schema` and `channel` were eaten by the deny-list with no error at any
point. Absent, the scan runs exactly as before, so **inline actions stay
supported permanently and no app was migrated**. The one caveat is honest: an
option that is *typed* on `ServiceDefinition` needs a cast to be an action, since
`cache` cannot also be declared a function.

**What is not adopted:** Feathers' `Object.create(service)` prototype wrapper.
Feathers wraps user-authored instances it did not construct; Junction's factory
already returns a fresh object, and a prototype member is invisible to `{...svc}`
— which the autoloader and a dozen tests depend on.

**The measured result:** the typecheck baseline 211 → 199, one deleted line
accounting for most of it. Not the justification, though — the register claimed
the baseline was mostly this defect and it was not: 137 of the 211 were in tests
and examples. The justification is four bugs of one class, fixed four times.

**2026-08-10 · A method may answer what it likes; an ANNOUNCEMENT is about a
row, so it carries one.** (`FJS-D08`, closing `FJS-020`.)

A custom method's return value is also its broadcast payload, and those two jobs
want different things. A caller asked for `setVariable` and can be answered with
whatever suits it. A subscriber was told *this row changed* and has nowhere to
put anything that is not the row: the browser store upserts BY ID and replaces
wholesale, so an id-less payload is appended as a phantom row and a partial one
replaces the record and loses every field it omitted — in every open tab, with
nothing said.

Basecamp shipped four of them: `setVariable` answering `{ id, variables }`, the
deployment engine's five-field projection, `servers.heartbeat` answering
`{ ok, server_id, status }` with no id at all, and `jobs.trigger` answering
`{ id, queued: true }`. **All four were found by looking at a screenshot** — a
page doing the obvious thing rendered `undefined` as its heading while every
other assertion passed. *A partial row is indistinguishable from a full one
until it breaks.*

Three options, and the difference is who pays:

| | |
| --- | --- |
| Document the rule | What already happened. Four times, in one app, by the people who wrote the rule |
| Warn and send it anyway | Names the mistake, still corrupts every subscriber's store |
| **Send the row** | The announcement is correct whatever the method answered, and the service is told once so the *caller's* half gets fixed too |

The third. `announcementPayload()` in `core/litestone.ts` — one owner, called
from the one announcement point in `callService`:

- the payload when it already is a row (extra keys are fine — `{ ...job, queued: true }`
  is a row and a flag, and only an OMISSION makes it a projection)
- otherwise the row re-read by `payload[idField] ?? ctx.id`, which is why a
  collection-level action and an id-bearing one behave differently
- otherwise the payload, as the **signal** it is

**Dropping that last case was the first design, and it was wrong.** An action
that changes MANY rows has no single row to carry — `volumes.report` answers
`{ serverId, reported, added, updated, forgotten }` — and its subscribers use
the event as a trigger to re-read, not as a record. Suppressing would have
stopped a live screen updating with nothing but a server-side line to say why:
the same silent failure this ruling exists to remove, introduced by the fix for
it. Caught by asking what basecamp actually returns before running its drive.
The phantom-row half is closed on the client instead, where `Store.upsert`
refuses a record with no id — which is the better place for it anyway, since a
payload from a hand-rolled `channel.send()` never reaches the server-side check.

**The warning is once per `service.method`**, names the missing columns and both
ways out. Per-call would be a log nobody reads, which is the same silence in a
louder font.

**Two things are deliberately left alone.** `ctx.dispatch` — a stated payload is
a declaration of what to send, and second-guessing it would make one switch mean
two things. And a service with **no model**: there is no row for its answer to be
a partial version of, so nothing is inferred. *I cannot tell* is not *this is
wrong* — the same rule `$checkWhere` follows for an unknown accessor.

The response half is NOT fixed by this and cannot be: a method that answers a
projection still answers a projection, and a caller assigning it over a record
still loses fields. That is what the warning is for.

**2026-08-10 · An app's own User columns reach the session through one hook, at
the point the row is already in hand.** `createLitestoneAuth(db, {
sessionFields })`.

@frontierjs/auth OWNS `model User`; every app that uses it EXTENDS that model,
and until this existed there was no way to get an app's own column onto the
`SessionContext`. Basecamp needed three (`isSystemAdmin`, `status`, `kind`) and
the only route was to wrap `verifySession` and re-read the user — a **third
query on the hottest path in the app, forever**, for a row auth had just
fetched.

`sessionFields(user)` is called from `toContext()`, which is the single place
every issued session is built, so one hook covers login, `verifySession`, an API
key and `createUser` alike. Two kinds of thing belong in it: the **standing**
`sessionGateLevel()` grades on (`isAdmin` / `isOwner` / `isSystemAdmin` /
`activatedAt` / `verifiedAt`) — which is how an app whose privileged bit is its
own column reaches `@@gate` at all — and the app's own keys, which travel on the
session untouched and which only the app's hooks read.

It is spread **last**, so an app that states a field wins. The other order would
mean adding any key to `toContext` silently overrides what an app asked for,
which is a breaking change nobody would see.

*Lives in:* `packages/auth/auth.ts` (`toContext`), `packages/auth/types.ts`;
consumed at `packages/basecamp/api/src/core/session-auth.ts`. 83 auth tests
green, `example/` 37/37 unchanged (the option is additive).

**2026-08-10 · A saved view names a declared kind. It never stores a query.**
Ruled while building basecamp's `Dashboard` + `DashboardWidget`; the question
had been open since the screen inventory was written.

A dashboard widget has to say what it shows. The two candidates were a
free-form query stored on the row — `{ accessor, where, orderBy }`, one renderer
for everything — and a declared vocabulary, where a widget names one of a fixed
set of kinds and carries only a subject and a few knobs.

**A stored query is a read that no policy graded.** The row travels: it is
seeded, exported, copied between workspaces, and read by everyone who opens the
board. The policy does not travel with it — `@@gate` and `@@allow` grade a
CALLER against a MODEL, and neither can say anything about a string. So the
server would end up running a query one person wrote on behalf of another, at
the second person's privilege, with nothing in the schema able to see it. The
generous version of the same idea — validate the stored query at read time — is
`IDEAS/scoped-sql.md`, deliberately unbuilt for the reason recorded there: a
wrong validator grants a *false* guarantee.

**A declared kind reads through the service that owns the data.** Each kind
names a read this app already answers, and the browser makes that call with the
reader's own session — so a dashboard shows exactly what its reader could have
opened for themselves, and a card they may not read refuses in words rather
than quietly appearing for everybody. Nothing new is readable because a widget
exists.

**The vocabulary is an enum in the schema, which is what makes the picker
honest.** It reaches the browser as a `$def` on the model's JSON Schema — the
path every other enum already takes — so the Add-widget list is built from the
same declaration the column's CHECK constraint is, and cannot offer a kind the
write would refuse. What the schema cannot express (which kinds need a server,
which need an app, which config keys each reads) is one table in the service,
fetched by the screen through a `kinds` action rather than copied into the
bundle. A data test holds enum and table together in both directions.

The cost is real and accepted: **adding a widget kind is a migration.** That is
the honest price of a kind that cannot be added without something being able to
draw it — a widget nothing renders is a blank rectangle on somebody's morning
screen.

The same reasoning applies to anything else that saves *what to look at*:
a report, a filter preset, a scheduled digest. Name the shape; do not store the
query.

**2026-08-10 · Where a declared vocabulary cannot bound the act, the RECORD
bounds it — and the two live on separate screens with separate roles.** Ruled
while building basecamp's `/recipes/` and `/cleanup/`, the day after the saved-view
ruling above, because the obvious move was to apply that ruling again and it
does not apply.

A recipe is a saved shell script run on a machine. It looks like the same
question — something stored on a row that later decides what happens — but the
argument above turns on a fact that is not true here. **A stored query is
dangerous because it is executed at the Data boundary, where `@@gate` and
`@@allow` grade a caller against a model and a string cannot be graded.** A
script is not executed at that boundary at all: it is handed to an Outpost and run
on a machine, where there is no model, no caller and no grade. It runs at
whatever the Outpost has, for everyone, every time. A vocabulary of allowed
scripts would buy nothing — the danger is not *which read it stands for*, it is
that it is code.

So the safeguards are different in kind:

| | `/cleanup/` — declared | `/recipes/` — arbitrary |
| --- | --- | --- |
| What is stored | target names from a fixed list | a script |
| Refusal | an unknown target, by name | none possible |
| Authoring | developer | **admin or owner** |
| Running | developer | developer |
| Record | what the Outpost said it freed | the script AS RUN, per server |

**Authoring and running split, and that split is the point.** Writing the script
is the privileged act; running a vetted one is the ordinary act somebody on the
pager does at 3am. Collapsing them would make recipes admin-only in practice,
which is how people end up pasting the script into a terminal instead — the
thing this screen exists to stop.

**A run keeps the script it ran.** `RecipeRun.script` is a copy, not a foreign
key: a recipe is editable, so output read against a script that has since
changed is not evidence of anything. Same reason the run row is per SERVER —
a fleet run is N executions with N exit codes, and one row would have to pick a
single status for *three succeeded and two failed*.

**The declared half is declared as far as the tooling allows, and no further.**
`enum ReclaimTarget` is not in the schema, because `targets ReclaimTarget[]`
does not parse — *array [] is only supported for Text, Integer, File, or a model
name for many-to-many* (`FJS-141`). A declared enum beside a `String[]` column
would be two homes with no CHECK joining them, which is exactly the shape that
let `AlertRule.severity` default to a value its own API refused. So the list has
one home in the service, the API refuses anything outside it by name, the screen
fetches it rather than copying it, and a data test asserts the schema declares no
competing enum.

**The premise expired 2026-08-11.** `FJS-141` is closed: `targets
ReclaimTarget[]` parses, and the members are checked at the Data boundary. What
does NOT follow is that the enum belongs there automatically — the CHECK this
paragraph asked for still cannot exist (SQLite forbids the subquery `json_each`
would take), so the schema declaration buys the type, the JSON Schema `$def` and
one home, not a database-enforced one. Moving basecamp's list into the schema is
a live option and a migration; the decision above stands until someone takes it.
*Lives in:* `packages/basecamp/api/src/services/cleanup/targets.ts`,
`api/src/services/recipes/recipes.service.ts`, `api/src/engine/fleet.engine.ts`,
`db/schema.lite` § FLEET ACTIONS; tests in `db/test/schema.test.ts` § Recipe and
CleanupRun.

**2026-08-08 · A field that is accepted on the wire but is not a column is
captured in a BEFORE hook, never read from the method body.** Ruled while
building `channels`. **Superseded 2026-08-17 in one respect and only one**: the
field is declared `@transient` and the framework lifts it, so the hook below is
no longer written by hand. Everything else here — why the value belongs off
`ctx.data`, and why each alternative was refused — is what the ruling above was
argued from.

Some payloads carry a value the model does not — and should not — declare. A
notification channel is created with the plaintext credential in `secret`, which
is deliberately not a column: the service lifts it into a `Secret` row
(`@encrypted`) and keeps only `secretId`. The same shape shows up wherever the
API takes something *about* a write rather than *part of* one — a confirmation
token, a "notify the owner" flag, a raw value that is stored somewhere else.

**Junction's derived `autoValidate(model, method)` deletes every key the model
does not declare, and user hooks run BEFORE the derived ones.** That ordering is
not incidental — it is what lets a hook shape `ctx.data` before validation sees
it, which is how `stampWorkspace` supplies a required column the client was
never meant to send. The consequence for a wire-only field is the mirror image:
**a before-hook is the only place it still exists.**

```ts
// The rule.
function captureCredential(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  if (typeof data.secret === 'string' && data.secret) ctx.locals.credential = data.secret
  delete data.secret          // explicit, so the intent is not "autoValidate got it"
}

hooks: { before: { create: [requireWorkspaceRole(…), captureCredential, stampChannel] } }
```

`ctx.locals` and not `ctx.data`: locals is per-call scratch that nothing
serialises, which is exactly what a value on its way somewhere else should be.
The `delete` is written out even though `autoValidate` would strip the key
anyway — a reader should see the field leave the payload on purpose, and the
hook must behave the same if it is ever reused on a service with no model.

**Why the obvious alternatives are refused:**

- **Reading it in the method body.** This is what was written first, and it is
  silent: the service answered *Slack needs a credential — send it as `secret`*
  about a request that carried exactly that. The failure names the caller for
  the framework's behaviour, which is the worst kind.
- **Declaring the field on the model so it survives validation.** That puts a
  plaintext credential in the schema, in the DDL, in `x-`whatever reaches the
  browser, and in the audit trail. The whole point is that it is not stored.
- **`{ validate: false }` on the resource, or dropping `model:` from the
  service.** Both disable schema-derived validation for the *entire* service to
  admit one key — the coercion, the labels, the field rules and the required
  list go with it.
- **A second endpoint that takes only the credential.** Two writes where the
  user made one, and a channel that exists for a moment with no credential.

**The cost, stated:** nothing enforces this. A wire-only field is a convention
held by a hook and a comment; the framework cannot tell one from a typo, and the
symptom of getting it wrong is a message about the field being missing. `FJS-095`
is the same seam from the other side — *nothing can say "this column is written
by the system, not by a user"* — and the two want one answer, not two.

That paragraph is what `@transient` was built from, and both halves now have
their word: `@system` (2026-08-15) and `@transient` (2026-08-17).
*Lives in:* `packages/basecamp/api/src/services/channels/channels.service.ts`
(`captureCredential`), `packages/basecamp/CLAUDE.md` § What bites here,
`CLAUDE.md` § Live hazards.


**2026-08-06 · A custom action announces like any other write, under its own
name.** Closes `FJS-D21`; fixes `FJS-033`. `callService`'s one announcement
point derives `orders pay` for an action exactly as it derives `orders patched`
for a patch — no past tense is invented, matching what the `publish()` hook form
had always put on the wire and what the browser client's `*` handler had always
upserted. Only `find` and `get` are excluded, by name.

The alternative considered was opt-in: an action announces only if it set
`ctx.dispatch`. Rejected because it makes the safe case the one you have to
remember — a transition is the ordinary reason to have an action at all, and a
framework whose live updates work for `patch` but not for `pay` until you add a
line is one that looks broken in the exact place it is being shown off.

Rulings inside the ruling:

- **An action that only READS opts out with `ctx.dispatch = false`.** At this
  layer a `search` action is indistinguishable from a `pay` one, so the leak
  direction is real and accepted; `dispatch` is the existing one switch,
  suppressing browsers and the in-process bus together. No new vocabulary.
- **Nothing announces without `channel:`.** Unchanged. Broadcasting is still
  opt-in per service, because row policies are evaluated on read and a broadcast
  does not re-evaluate them per subscriber.
- **The gap was structural, not a slip.** Both halves existed and neither side
  could see the other: the client listened for action events, the server sent
  none, and every app masked it by re-issuing `find()` after each action — which
  made the *acting* tab correct and every other tab stale. Nothing in the repo
  watched a client that had not acted until `example/web/test/verify-live.mjs`.

**2026-08-06 · A service narrows its method set with one key: `methods`.**
Closes `FJS-D07`; fixes `FJS-004`. Two forms on the same key —
`methods: ['find', 'get']` is the general allow-list, `methods: 'readOnly'` is
shorthand for exactly that list. Absent means every method, so nothing that
exists changes.

The allow-list is the general form because a narrower method set is not only
ever "read only": `['find','get','create','approve']` says *no patch, no remove,
one action*, which a boolean cannot express and which otherwise goes back to a
hand-written hook. `'readOnly'` is sugar **on the same key** rather than a
second option, so there is still one place to look.

Rulings inside the ruling:

- **CRUD and actions share one list.** Being defined on the service is not being
  offered; an action the list omits is refused like any verb.
- **405, not 404 or 403.** The route is real and the service exists; the verb is
  not offered, to anybody. A 404 sends someone hunting a mounting problem and a
  403 implies a different identity would succeed.
- **Enforced in `callService`, ahead of the hook pipeline.** That is the one path
  every caller takes, so an in-process `app.service('audit').create()` is refused
  exactly as the wire is — the alternative leaves jobs, engines and hooks free to
  do what a request cannot. Ahead of hooks because the policy is structural
  rather than authorization: nothing an identity could change, already public in
  `/manifest`, and running `before` hooks for an impossible call means running
  their side effects. Consequence, accepted: an anonymous caller gets 405 where
  it used to get 401.
- **An unknown name throws at construction.** `['find','gett']` would otherwise
  silently block `get` and only read as broken after a 405 in production.
- **The three advertisers filter by the same predicate** — `/manifest`,
  `/metrics` and the OpenAPI spec — so what a service answers and what it claims
  to answer cannot drift. `isMethodAllowed()` / `allowedMethodNames()` are the
  one owner, beside `isCustomMethod()` / `customMethodNames()`.

*Lives in:* `packages/junction/src/core/service.ts`; consumed by
`plugins/manifest`, `plugins/openapi`, `transport/health.ts`. 21 tests in
`tests/method-policy.test.ts`; 7 of them fail if the enforcement is removed.
First consumer: `packages/basecamp`'s `/audit`, which drops four hand-written
`MethodNotAllowed` stubs for one line.

**2026-08-01 · Custom service actions stay on `X-Service-Method` header dispatch.**
Proposal to move to sub-path dispatch (`POST /api/notes/:id/summary`) was
considered and declined. Case is preserved for action names (`getStats` works);
CRUD names remain blocked from header override; `restore`/`upsert` match
case-insensitively.
*Lives in:* `packages/junction/src/transport/bridge.ts`.

**2026-08-01 · `createService({ model })` carries the derived hook layer.**
The model path must always include schema-derived gates/validation
(`base.hooks` = user hooks + derived); hook-less custom actions run the `'*'`
(all-hooks) pipeline, never an empty one. Litestone error names map across the
package boundary: `AccessDeniedError` → 403, `ValidationError` → 400.
*Lives in:* `packages/junction/src/core/service.ts`, `core/hooks.ts`,
`core/errors.ts`.

**2026-08-02 · The result envelope has one owner, and `kind` is the discriminant.**
`{ kind, object, data, errors, total?, limit?, offset? }`. `kind` is `'single' |
'list'` and is THE field to branch on; `object` is the SERVICE name for both
kinds (`'posts'`, never `'list'` and never `'Post'`), so it is a stable identity
a client can key a cache or a type off. The shape was built in one place and
taken apart in twelve others, each with its own rules, and they had drifted:
the same `find()` returned a full envelope over HTTP, a bare array to internal
callers, and a bare array to the browser — `total` was reachable from curl and
nowhere else. Detection was `'object' in value`, which classifies any row with
a column named `object` as an envelope.
**The rule, everywhere: a list keeps its envelope, a single unwraps to the
record.** A list carries metadata that has nowhere else to live; a single does
not. `$wrap` is tri-state on the wire — absent = the rule, `true` = envelope the
single too, `false` = unwrap the list to a bare array (Feathers' `paginate:false`).
*Lives in:* `packages/junction/src/core/envelope.ts` — `wrapResult`,
`unwrapResult`, `resultData`, `isServiceResult`, `isListResult`, `single`, `list`.
Import them; do not reach into `.data`.

**2026-08-02 · `$` is transport syntax, not an internal data model.**
`ctx.query` is FILTERS ONLY (which records); `ctx.directives` is DIRECTIVES
(how to shape the result) — `limit`, `offset`, `orderBy`, `select`, `populate`,
`search`, `withDeleted`, `onlyDeleted`, structured and unprefixed. The bridge is
the only place that understands `$`. Conflating them is not theoretical: the
bridge stripped `$limit/$offset/$orderBy/$select` from `ctx.query` as "reserved"
while `parseQuery` looked for exactly those four keys there — the transport
deleted precisely what the query builder read, so pagination, ordering and field
selection were ALL inert over HTTP, and the unprefixed `?limit=1` became a WHERE
clause on a nonexistent column and returned zero rows. Internal callers pass
`{ directives: { limit: 10 } }` via `CallOptions`.
*Lives in:* `packages/junction/src/transport/bridge.ts` (`parseDirectives`),
`src/core/context.ts` (`QueryDirectives`, `RESERVED_PARAMS`),
`src/core/litestone.ts` (`parseQuery`).

**2026-08-02 · `errors[]` is load-bearing: bulk writes return partial success.**
Kept, not dropped — and now written to. A bulk create saves what it can and
returns the failures as `{ data, error }` pairs: the input that failed, paired
with why, so a caller can tell WHICH of fifty rows was rejected rather than
"some subset broke". This is Feathers issue #562's 2017 envelope proposal,
which never shipped there because the migration cost across its ecosystem
killed it; Junction had carried the field with nothing writing to it. Bulk stays
opt-in (`allowBulk: true`). Deliberate trade-off: rows are created individually,
so there is no all-or-nothing rollback — atomicity and partial success are
mutually exclusive; wrap the call in a transaction if you want the former.
*Lives in:* `packages/junction/src/core/envelope.ts` (`BulkFailure`,
`toBulkFailure`, `partitionBulk`, `BULK_FAILURES`), `src/core/litestone.ts`.

**2026-08-14 · Partial success extends to a filtered PATCH and REMOVE, and the
reason is enforcement rather than symmetry** (`FJS-D11`, closing `FJS-044`).
A bulk patch/remove selects its rows and writes them one at a time, answering
the same `{ data, errors }` list envelope bulk create does. Symmetry was the
weaker half of the argument. The stronger half: Litestone does not enforce
`@@transitions` on `updateMany` — a deliberate power-tool exemption, whose own
note says to loop `update()` where transition safety matters — and Junction was
the caller that never did, so `PATCH /orders/1` was refused by the state machine
and `PATCH /orders?status=draft` was not, for the identical move. `@version` was
the same shape: bumped by a bulk write, never required, so optimistic
concurrency was off for the writes touching the most rows. Both are properties
of `update()`. Calling it per row is what brings them back AND what produces a
per-row outcome — one change, two reasons, which is why this ruling is not the
"scope it to creates" alternative it was written to consider.

Three consequences, all deliberate:

- **A row cap, `bulkMax`, default 1000.** One statement per row means an
  unbounded filter is an unbounded number of statements under SQLite's single
  write lock. Over the cap the call is refused naming the count, before anything
  is written. This is the one place the change can break a working app — a
  filter that matched 50k rows used to be one statement.
- **Only rows the caller can READ are touched.** Selecting the targets applies
  the read policy; the write then applies the update/delete one. A row updatable
  but unreadable was reached by `updateMany` and is not reached now.
- **Still no atomicity**, on the same terms as bulk create: `transactional:` on
  the service is how a caller trades partial success back for all-or-nothing.

A caller-supplied `@version` on a bulk patch is **refused by name** rather than
applied: one value cannot be right for N rows, so it would conflict on every row
but the one it was read from. Each row is written against the version selected
with it, which makes the loop a read-modify-write and turns a row that moved
underneath into a `VersionConflictError` in `errors` rather than a silent
overwrite.

`restore` is the third filtered write and is NOT looped — there is nothing
per-row to enforce and `restore({ where })` already answers the rows. It called
a `restoreMany` that does not exist (`FJS-245`).
*Lives in:* `packages/junction/src/core/litestone.ts` (`bulkByRow`), tests in
`packages/junction/tests/bulk-partial-success.test.ts`.

**2026-08-02 · One event origin, and broadcasting is declared on the service.**
A mutation is announced ONCE, in `callService`, and fans out to two consumers:
the in-process bus (`posts:created`) and the channel manager (`posts created`).
They were independent origins, which cost three separate things: two places
derived the event name and disagreed; `ctx.dispatch = false` suppressed the
socket but not the bus, so a hook that deliberately withheld a broadcast still
handed the record to every server-side subscriber including webhook fan-out;
and an app that forgot to wire the publish hook had half a real-time layer with
no signal. `ctx.dispatch` is now the single switch for both — `false` announces
nothing, any other value replaces the payload.

**The separator is the discriminator, and it is not decoration.** A colon means
the in-process bus, a space means the wire — `posts:created` is a server-side
reaction (webhooks register exactly these), `posts created` is a frame a browser
receives. Two audiences with different semantics: the bus is synchronous and
unfiltered, the socket obeys channel membership and can be suppressed. Keeping
one spelling for both would make a log line and a subscription unreadable as to
which layer they belong to, and would make a subscriber wired to the wrong one
look correct — which is precisely how jetty came to subscribe on the WIRE to
`${name}:created`, the bus spelling (`FJS-059`). Colon is also the conventional
NESTING character and junction already nests with it (`webhook:delivered`),
while the browser client's parse is exact-two (`split(' ')`, `parts.length === 2`
in `client/index.ts`) — so the two separators are doing different jobs rather
than the same job twice. Do not unify them, and do not swap them: the swap
lands Feathers muscle memory on the side where it is most misleading, since
junction's payload semantics are not Feathers'.

A service declares its target with **`channel:`** — `'posts'`, a
`(rows, ctx) => Channel` function, or `false` for a declared opt-out. Named
`channel` and NOT `publish` because "publish" is an ordinary action name
(publishing a draft — the openapi suite has exactly that service) and reserving
it as an option key would stop a service from having one. A noun cannot collide
with a verb-shaped action.
**Bulk writes announce once per record**, as Feathers does: the browser's
created/patched/removed handlers each take one record, so a single event
carrying an array lands as one malformed upsert.
*Lives in:* `packages/junction/src/core/service.ts` — `callService`,
`publishToChannels`, `PublishDeclaration`.

**2026-08-02 · Broadcasting is opt-in in the framework, opt-out in the scaffold.**
`createService({ name, model })` broadcasts nothing. `@@allow` row policies are
enforced when a row is READ, and a broadcast does not re-evaluate them per
subscriber — so a default of "announce everything" hands every connection in a
channel rows it could never have fetched. This is exactly Feathers' split: its
core publishes nothing without a publisher, and its *generator* scaffolds
`app.publish(() => app.channel('authenticated'))` — the line its own docs then
tell you to replace. `fli make:model` / `make:scaffold` emit `channel: '<name>'`
with the scoping warning attached, so a generated app is live out of the box and
the line is in front of the developer who has to narrow it.
*Since (2026-08-18, `FJS-334`):* an app may register ONE fallback,
`app.channels.publishDefault(fn)`, consulted only where a service declares
nothing — so the opt-in above is unchanged (there is no default until an app
writes one) while an app with one scoping rule for twenty services writes it
once. It is a default and not a second broadcaster: `channel:` is never asked
it, `channel: false` refuses it, and nothing can send one record twice. **No
string form** — a single channel name for every service is exactly the shape
this ruling refuses, so the fallback is handed the record and decides per
record. Because that inverts the failure mode — a forgotten `channel:` used to
mean a screen that never updates, and now means a broadcast on somebody else's
rule — the plugin names at boot which services fall through, and `channel: false`
takes them off the list.

*Lives in:* `packages/cli/commands/make/model.md`, `make/scaffold.md`;
rationale in `publishToChannels()`, the fallback in
`packages/junction/src/transport/channels.ts` (`publishDefault`).

**2026-08-17 · Caravan owns the clock; `app.scheduler` is in-process only.** (`FJS-D36`, closing `FJS-047`.)

Junction constructs a scheduler directly (`app.ts`, `createScheduler()`) and
Caravan registers a cron for any `handle()` carrying one — so an app has two
ways to run something on a timer and they share nothing. `FJS-047` filed that as
an ownership overlap; the ruling is that both stay, with the boundary stated,
because they are not the same feature.

**`app.scheduler` is a timer and nothing else** — in-process, no persistence, no
retry, no principal, gone when the process is. `app.jobs` is durable work: a
SQLite row, retry backoff, and the principal re-resolved through `app.runAs`.
Deleting the scheduler was the tidier option and is refused: Caravan is an
*optional* peer, so *run this every hour* would then require a second package
and a database file, which is a real tax on an app that wanted a heartbeat.

**The rule that follows is the whole ruling: a timer that dispatches into a
queue is the QUEUE's schedule, not the scheduler's.** Reaching for
`app.scheduler` to fire `app.jobs.dispatch(…)` buys a clock with none of the
queue's durability while looking like it has it — which is exactly what
basecamp did, and it cost two defects that only a restart or an edit could
show (`FJS-327`, `FJS-328`). `app.scheduler` is for work with no row behind it:
a cache sweep, a metrics tick, something whose missing a beat costs nothing.

*Since:* Caravan gained the counterpart `schedule()` never had — `unschedule(name)`.
A schedule declared in a `*.job.ts` file lives as long as the process, so nothing
needed it; one registered from a DATABASE ROW stops being true when the row is
deleted, and with no way back the timer went on firing for a job nobody could
see. The handler stays registered — a run already queued still has to find
something to execute.

*Lives in:* `packages/junction/src/scheduler/index.ts`,
`packages/caravan/src/cron.ts`; the app-side pattern is
`packages/basecamp/api/src/engine/job-schedule.ts`.

**2026-08-17 · A durable effect is a NAME and a PAYLOAD in the app's own
database, and the queue stays a separate file.** (`FJS-D35`.)

`ctx.afterCommit(fn)` bought the ORDERING half (`FJS-089`): the effect runs only
if the call succeeded and the transaction committed. It buys nothing against a
crash — the process dies between the commit and the callback and the effect is
never done, with nothing anywhere recording that it was owed. The durable answer
is the standard one, an intent written as a row inside the same transaction. The
question `FJS-D35` held open was **which database that row is in**, and it had
three candidate answers.

**A second declared `database` block is not one of them, and that is measured
rather than argued.** Litestone opens one connection per declaration
(`client.js`, `new Database(absPath)`) and there is exactly one transaction
manager, over main's write connection. A probe: `$transaction` writing to both
and then throwing rolled main back and left the second database's row standing.
`$attach` does not rescue it either — SQLite's atomic multi-file commit needs
rollback-journal mode on every attached file, and both Caravan's queue and
litestone's tenants run WAL.

So the row goes in **main**, on the connection the pipeline is already writing
through, and it is a `.lite` model rather than a litestone-created system table:
a system table is invisible to migrations, to `ddl.snapshot.sql` and to
`access.snapshot.md`, which makes a stuck outbox a thing nobody can query. The
model ships as `packages/junction/db/outbox.lite` and is IMPORTED, never pasted
— the same split `@frontierjs/auth` makes, and for the same reason: it is
`@@gate("8")` machinery that changes when junction changes, so an upgrade has to
reach an installed app. `fli outbox:install` writes the import line;
`outboxSchemaFragment(db)` is the in-memory alternative for an app assembling
one string.

**The queue stays its own file, and the split is intent versus execution.** Main
takes one small insert per durable effect; Caravan keeps every byte of its
polling on its own database, in WAL, behind its own write lock. That is also
what makes the handoff **at-least-once**: two files cannot be one transaction, so
a crash between the queue insert and the delivery mark replays.

**`ctx.enqueue(job, payload)` is a second verb, not a flag on `afterCommit`.** A
closure cannot be written to a table. Everything durable has to be addressed by
name, so the API says so rather than letting the first crash say it — one verb
takes a function and dies with the process, the other takes a name and a payload
and does not.

*Refusals, by name rather than degradation:* outside a transaction (asked of
`db.$inTransaction`, not of the `transactional:` declaration — a hook can run
against a method the declaration does not name), on a schema with no
`OutboxMessage`, and with no relay installed. A row nothing delivers is worse
than a refusal.

*Since:* Caravan's `dispatch({ id })` — a STATED job id, which is the
idempotency `unique` deliberately is not. `unique` frees itself the moment a job
is terminal, which is exactly when a replay is most likely; the primary key
lasts. The relay dispatches under the outbox row's own id, so the replay above
is a no-op instead of a second email. Litestone gained `$inTransaction` on every
flavour of client for the refusal above.

*Still open beside this:* delivery is at-least-once, so a handler must be
idempotent — the framework hands it the outbox row id and says nothing else.

*Lives in:* `packages/junction/src/core/outbox.ts`,
`packages/junction/db/outbox.lite`, `packages/junction/src/plugins/outbox/`;
the worked example is `example/api/services/orders.service.ts` (`pay`).

**2026-08-17 · Login stays HTTP; cycling the socket IS the login event.** (`FJS-D30`.)

Feathers authenticates over the socket because authentication is a *service*
there, so it inherits the transport — and because a Feathers connection outlives
the identity on it, which is why its `channels.js` needs an `app.on('login')` to
move the connection out of `anonymous` and into `authenticated/account/<id>`.
Junction's `/auth/*` is deliberately not a service (`FJS-D20`), the socket
dispatches one frame type, and there is no auth frame.

**The recorded reason to reopen it was requirement (3) — channel membership must
be torn down and rebuilt when the identity changes — and (3) is already done, by
discarding the connection rather than mutating it.** `setToken` cycles the
socket: `_disconnect()` then `_openWs()`, so the upgrade carries the new token,
`handleConnect` runs again, `channels.on('connection')` fires with the NEW
session, and membership is rebuilt from nothing while the old connection's
channels are dropped on close. That is Feathers' leave-anonymous /
join-authenticated transition, spelled as a reconnect. Every other line of a
Feathers `channels.js` has an exact equal here and both apps in this repo
already write it.

So what a WS login would still buy is **one HTTP round-trip at login**. What it
costs is a mutable `ws.data.user`: the WS session is resolved once in `_wsOpen`
and shared, frozen, by every frame on that socket (`FJS-007`), and basecamp's
`applyStanding()` is built on that — it constructs a fresh principal rather than
mutating one. Making the socket's identity reassignable to save a round-trip is
the wrong trade, and a half-logged-in socket — new token, old channel set — is a
silent failure, since a channel that never fires is indistinguishable from
nothing happening.

**The rule that follows: identity change is a NEW connection.** Anything that
needs to run when the caller becomes somebody else belongs in the `connection`
handler, which is the one place it can be written once. An app switching tenants
mid-session is the case that is NOT an identity change and must not reconnect —
basecamp handles it by joining a channel per membership at connect, so the switch
needs no new socket.

*Not a prerequisite for splitting the API onto its own origin:* the WS upgrade is
itself an HTTP request, so CORS is required either way.

*Still open beside this:* Junction has no app-level publisher — the half of a
Feathers `channels.js` that has no equal here (`FJS-334`).

*Lives in:* `packages/junction/src/client/index.ts` (`setToken`),
`packages/junction/src/transport/channels.ts` (`handleConnect`, `on('connection')`),
`packages/junction/src/transport/http.ts` (`_wsOpen`); the worked wirings are
`example/api/app.ts` and `packages/basecamp/api/src/core/app.ts`.


## UI substrate (Mesa)

**2026-08-16 · A UI plugin contributes a CONTROL, and a control is two
registrations in two packages.** (`FJS-D17`)
`registerControl(name, resolve)` in Sierra's `field-rules.js` answers *which
control does this column get* — a name, a whole descriptor, or null to decline.
`registerFormControl(name, Component)` in `@frontierjs/ui/controls` answers *what
does that name render as*. Both are consulted before the built-in table, and the
last thing registered is the first thing asked, so an app beats the kit it
imported without either of them coordinating.

Why two and not one: the split is a dependency rule, not a taste. `field-rules.js`
is a leaf that has to run in plain Node — `formFields()` is called from a test, a
prerender and a snapshot, where no component can be loaded at all — and
`@frontierjs/ui` peers only on mesa and css, so it cannot import Sierra to learn
what a `Float` is. A NAME is the only thing that crosses that boundary, and naming
the answer is also what keeps it inspectable.

What was there before is why the row said *limited*: `controlFor` was a `switch`
inside a published package and `<Form>` was an `{#if}` ladder over the five names
that switch could answer, so contributing a control meant forking both. The five
are now entries in the same table a contribution enters (`FormField.mesa`), which
is what stops the extension path being a second-class one that rots — a
registered name **replaces** a built-in of the same name, so swapping the kit's
`select` for a combobox everywhere is one line.

Two things the ruling refuses. **A control over a `readOnly` column**: `@system`,
`@computed`, `@generated` and `@from` are the Data boundary saying the value is
not the caller's to write, so a control over one is a form that cannot submit —
the registry is not consulted for those fields at all. And **a resolver's answer
is a name, never a component**, even where a bundler could carry one, because the
half that can be asked without a browser is the half three other callers use.

The rest of the question — *what else should a plugin contribute?* — is three
surfaces and one mechanism: a form control (this), a **cell / detail renderer**
and a **filter control**. Each is the same `(rule, ctx) → name` plus a
name→component binding. Neither of the other two ships until its generator does,
because a registry with no consumer is a name nobody can call and there is no
generated table, detail view or filter bar to call it. `IDEAS/overview.md` 1.1.

*Lives in:* `packages/sierra/src/junction/field-rules.js` (`registerControl`,
`defaultControlFor`), `packages/ui/controls.js`,
`packages/ui/components/forms/FormField.mesa`; pinned in
`packages/sierra/tests/form-fields.test.js` and `packages/ui/test/form.mjs`
(a contributed control rendered in a real `<Form>`, negative-controlled).

**2026-08-15 · Braces mean *run code*; parentheses mean *watch*. A block whose
body only reads values is refused by name.** (`FJS-D18`)
`$: (a, b)` is a multi-path watch. `$: { (a, b) }` is a compile error — as are
`$: { }`, `$: { count }` and `$: { cart.total }`. The two forms parse to the
*same AST* (a `SequenceExpression` of identifiers), so the parentheses are the
only thing that separates them and the check reads them from source position.

Why: effects do not drive renders in Mesa — a template's `{a}` tracks its own
reads — so an effect with no side effect is unobservable, and every one of those
forms is somebody reaching for braces to express a watch. Reporting it costs
nothing, because it is decidable, and the previous behaviour was worse than
either alternative: `$: { (a, b) }` compiled to
`orderedGroup([{ deps: [a], handler: <the value of b> }])` and threw
`fn is not a function` the first time `a` changed. The message names the form
the author wanted, and it distinguishes the two intents — an unparenthesised
sequence with an identifier tail is an attempted `dep, handlerRef` and is told
to write `() => f()`, anything else is told to drop the braces.

Consequence — the handler shorthand is **unbraced-only** (RULE 52). `$: a, syncFn`
is fine; `$: { a, syncFn }` is refused, because `{ a, syncFn }` and `{ a, b }`
are indistinguishable and a block is where several handlers are ordered, which is
worth one arrow per line. An empty block is its own message: `[].every()` is
true, so length is checked explicitly or an empty block reads as a watch group.

*Lives in:* `packages/mesa/src/compiler.js` (`_isInertBlock`, the `$:` label
walk), spec at `packages/mesa/docs/VISION.md` §4.4 / §4.8 (RULE 14b, 50, 52) and
the §4.9 table, pinned in `packages/mesa/test/inert-block.test.js`.

**2026-08-05 · A component's composition API is snippet props, and a snippet's
arguments are getters.**
`{#snippet row(r)}` written inside a component tag is passed as the same-name
prop (VISION §9.5, implemented 2026-08-04), and `{@render row(order)}` hands
`() => order` rather than the value.

Why: a named slot cannot take a parameter, so a snippet prop is the only
parameterised composition the language has — a table that draws rows, a
component with a trailing icon per item, a list with a per-row action. And a
snippet's DOM is built once, so an argument read as a value is frozen at that
moment: the first version of this shipped a kit `Table` that drew its first
page of rows and then ignored the store. Reading through a getter keeps the
fine-grained model — the read happens inside each binding's own effect.

Consequence: a snippet held in a variable and invoked from ordinary JavaScript
takes `(anchor, ...getters)`.

**2026-08-05 · `$attributes` is the REST of the props, and a portal is a
delegation root.**
`$attributes` excludes everything the component declared, plus `class` (which
arrives as `$class` and is *merged* by `bindClassPassthrough`, never replaced).
`<mesa:portal>` registers its target as a delegation root for as long as it is
open, reference-counted.

Why both: a component kit cannot enumerate every attribute a caller might need
— `id`, `aria-label`, `title`, `data-*` — so forwarding has to be possible;
before this, `$attributes` was every prop unfiltered and spreading it wrote
`tone="danger" variant="ghost"` onto the DOM node. And delegated handlers are
found by walking from the event target up to a registered root: portalled
content is appended to `document.body`, outside the app's container, so every
menu item, command-palette row and toast dismiss button in `@frontierjs/ui` was
inert — correct markup, correct ARIA, no error, and a click that did nothing.
Reference counting is what stops the first of two open portals from taking
`document.body`'s listener away from the second.

**2026-08-05 · A compiler error fails the build.**
`analysis.errors` is not advisory: Sierra's `mesa-plugin` throws rather than
serving the module.

Why: a settings screen with five `bind:` errors in it — each one correctly
diagnosed as "must be a writable top-level `let`" — rendered, looked right, and
silently collected nothing, because the plugin forwarded `warnings` and never
looked at `errors`. A diagnosis nobody sees is the same as no diagnosis, and
this repo's recurring failure mode is exactly that: the compiler knew.


**2026-08-04 · `x = x` forces a notify — the same idiom for local state and for
watched imports.**
Self-assignment on a reactive binding compiles to a write that skips the
equality guard, so `user.score += 10; user = user` re-renders. It reads as a
no-op and deliberately is not one: it is how you say *"I mutated this in place,
notify anyway"*.

Why: the idiom already existed and already meant exactly this — for an
**imported** proxy root, `themeNew = themeNew` compiles to `$$fire_themeNew()`
(ES module bindings are read-only, so the assignment could never have been
literal). For a **local** `let` it compiled to an ordinary `$$set_user(user)`,
and signals write through `Object.is`, so the identical reference was skipped and
nothing happened. One idiom, two behaviours, no diagnostic — and the natural
guess for anyone arriving from Svelte, where `x = x` is the standard nudge.

**The force is per-write, never per-signal.** `track()` has carried an unused
`_alwaysNotify` flag that would have made a binding always notify; that is the
wrong shape, because it discards the equality optimisation for every ordinary
write to that binding. `createSignal`'s `write(next, force)` and
`set(tracked, value, force)` take the flag per call instead, and only the
self-assignment call site passes it. RULE 43 is unchanged: a bare mutation with
no assignment is still inert.
*Lives in:* `packages/mesa/src/compiler.js` (`rewriteAssignments`, beside the
imported-proxy case it mirrors), `packages/mesa/src/runtime.js`
(`createSignal`, `set`), VISION **RULE 43**; pinned by three tests in
`test/compiler.test.js`, one of which asserts an ordinary equal write is still
skipped.


**2026-08-03 · Scoped CSS binds to the selector's SUBJECT, not to an ancestor.**
A component's `<style>` rules are emitted by appending the component hash to the
**rightmost compound selector** (`button` → `button.mHASH`), and every element in
a styled component carries that hash. Two things follow, and both reverse the
previous behaviour: a component **can** style its own root element, and it
**cannot** reach the markup of a child component. Cross a component boundary with
`:global(...)`.

Why: the previous form emitted `.mHASH button` — an ancestor selector — while
putting the hash *on* the element, and those cannot both be true. `.mHASH button`
matches a button *inside* a `.mHASH` element, never the `<button class="mHASH">`
carrying it, so any rule targeting the component's own root silently did nothing
in every environment. It went unnoticed because a second bug cancelled it: the
prerenderer de-scoped CSS before shipping it, which made component styles apply —
globally, to the whole page. `addStyles` was well covered as a *mechanism* (19
assertions) and nothing had ever asserted that the selector matches the markup.

This is a **breaking change** for any component that styled a child's internals.
*Lives in:* `packages/mesa/src/compiler.js` (`_appendScope`, `_scopeSelector`, the
element writer), VISION **RULE 55**, `packages/mesa/CHANGES.md`;
computed-style proof in `packages/sierra/tests/fixtures/island-site/verify.mjs`.

**2026-08-03 · CSS scope ids are content-addressed, never generated.**
The component hash is `cssHash(styleContent)` — a pure function of the `<style>`
content, so the same component yields the same id in any process, any build, and
any compiler. It replaced `genId()` (clock + counter), whose one caller this was.

Why: three separate things needed it. Reproducible builds — output could not be
diffed or content-hashed, and checking a compiler change for byte-identity
reported 13 false differences that were all scope ids. Cross-compiler identity —
a prerendered island is compiled by Mesa's renderer *and* by Vite for its chunk,
and two ids meant the same rules shipped twice under two hashes with the markup
swapping class on mount. And debuggability — a class that changes every build
cannot be searched for.

**Hash the style content and nothing else.** Including the filename would break
cross-compiler identity the moment the two disagree about a path (absolute vs
relative, a Vite id with a query, a symlinked workspace) and would do it
silently. Two components with byte-identical CSS therefore share an id; that is
harmless, because their rules are the same rules.
*Lives in:* `packages/mesa/src/compiler.js` (`cssHash`, `processCSS`);
`genId()` remains exported and non-deterministic with no caller.

**2026-08-03 · A page assembles its own styles; the renderer offers both shapes.**
`renderComponent` returns `.styles` — `[{ id, css }]` per component in tree order
— alongside the concatenated `.css`, and `styleTag: false` suppresses the blob it
otherwise prepends to `.html`. A caller emitting `<style id="mHASH">` per
component gets dedupe for free: the id is the scope hash, so the runtime's
`addStyles` treats the block as already present. Sierra's prerenderer does this,
taking an island's CSS on a static page from three copies to one.
*Lives in:* `packages/mesa/src/render-component.js`,
`packages/sierra/src/build/prerender.js` (`wrapDocument`).

**2026-08-03 · The NEAREST delegation root owns an event; ancestors stay out.**
`_makeDelegatedHandler` now scans the composed path first and returns if any
registered root sits between the target and its own root. Before, each root
walked the path independently, so a handler ran **once per ancestor root above
it** — one click, two increments.

Roots nest whenever two mounted trees sit at different depths, and `mount()`
registers the anchor's parent element, so this is the ordinary shape for Sierra
islands: one island directly in `<main>` and another inside a `<div>` in that
`<main>` is enough. It went unseen because the fixture happened to put every
island in the same parent.
*Lives in:* `packages/mesa/src/runtime.js` (`_makeDelegatedHandler`), pinned in
`runtime.test.js` ("a handler fires ONCE when delegation roots nest").

**2026-08-03 · An ancestor island's mount is authoritative; `client:static`
under a live parent cannot be honoured.**
Mesa's `island()` short-circuits on the client, so a mounted island renders its
nested `client:*` children **directly** — live, in its own delegation root,
before their directives fire. Sierra's loader therefore defers to the ancestor
rather than racing it: a subsumed island resolves nothing and downloads nothing,
mounting clears the range as it stands *now* (not the scan-time list) and
disposes any descendant that mounted first. `client:static` inside a live island
is the one case with no correct answer — the parent renders its children — so it
warns instead of being silently reinterpreted. A `client:static` **parent** never
mounts, so it does not subsume anything inside it.
*Lives in:* `packages/sierra/src/islands/loader.js`, pinned in
`packages/sierra/tests/islands.test.js` and end-to-end in
`tests/fixtures/island-site/` (`Outer.mesa` / `Inner.mesa`).

**2026-08-03 · A prerendered page's CSS keeps its scoping; only the inlining
targets flatten it.** `renderComponent`'s `email` and `fragment` targets push
declarations into `style=""` attributes, so their selectors are consumed and
flattening them is harmless. The `html` target ships a `<style>` block, where the
hash is the only thing keeping one component's rules off another's markup.
*Lives in:* `packages/mesa/src/render-component.js` (`compileTree`, `opts.descope`).

---

## Design system (`@frontierjs/css`)

**2026-08-08 · There is no Menu term. A dropdown menu is Popover + Items.menu
+ a keyboard contract, and the third one is not CSS.**

Asked while building the wizard: does the vocabulary need Menu or Dropdown?

It does not, and the reason is the same one that made Bar and Toolbar two
terms rather than one with a variant. **A role is a promise the app owes.**
`role="menu"` tells a screen reader the list is one tab stop and the arrow
keys move within it; a stylesheet cannot implement any of that. A term named
Menu would advertise a contract the package has no way to keep, and the
person who trusted it would ship a menu harder to use than a plain list of
links.

The composition already exists and is what everything real uses:
`.popover` is the surface, `.items.menu` is the list, and the behaviour comes
from whatever opens it. `@frontierjs/ui`'s `DropdownMenu` is exactly that —
`.popover`, `.items.menu`, `role="menu"`, focus management — which is the
evidence rather than the argument.

**What was missing was a route, not a term.** Nothing could get you from "I
want a dropdown menu" to Popover unless you already knew the answer, so the
wizard's `anchored` question now names it, the Popover outcome states the
three parts, and the Popovers page has a Dropdown menu section with a live one.

**Three defects fell out of asking:**

- The wizard's own Popover markup taught the anti-pattern `lists.css` warns
  about in its header — `<li class="item">Rename</li>`, a row styled to look
  clickable with no control in it.
- `popovers.css` told you to position it with `class="popover absolute
  top-12 left-0"`, Uno utilities the package does not ship and, since the
  UnoCSS ruling, may not require. Replaced with anchor positioning, which is
  the platform's answer and needs no JavaScript. `[popover]` is in the top
  layer, so a `position: relative` parent means nothing and the menu opens in
  the corner of the viewport — worth stating, because it looks like a bug.
- **`.item` on a `<button>` or `<a>` needed a control reset nobody shipped.**
  The documented-correct way to build a menu row is to put a real control in
  it, and then the control arrives with a UA background, border, font and
  width the row cannot override — so everyone who followed the advice wrote
  the same eight lines. `lists.css` owns it now, scoped through `.items`
  because `.items.menu .item` is (0,3,0) and a bare rule loses the cursor on
  a disabled row. The copy in the kit is gone (`FJS-126`, closed 2026-08-08) — deleting it also removed a `gap: 0.625rem` literal that disagreed with `.item`'s own rung and could not move with density.

---

**2026-08-08 · The guide gets a decision wizard, and its tree names terms
only.** `guide/decisions.js`, first page of the guide, new `Learn` nav group.

The guide was 48 reference pages and no entry point. Every one of them answers
"how does Badge work" for somebody who has already decided they want a Badge —
and nothing answered the question that comes first, which of the 54 terms the
thing in front of you actually is. That question is where the mental model
lives: Pill or Badge, Bar or Toolbar, Alert or Toast or Dialog, Item or Row.

**A wizard rather than a lesson**, chosen deliberately over a linear
first-principles walkthrough. A lesson is read once; a decision tree is
returned to, and the near-miss pairs are the thing people get wrong repeatedly
rather than the thing they fail to learn initially.

**Questions are about behaviour, placement and promise — never about looks.**
That ordering IS the system. Pick the term first and the look is three further
decisions that all compose; pick the look first and you get
`class="card-small-blue-bordered"`.

**The tree holds no facts about a term.** An outcome names one, and the
element, class, tier and meaning are read out of `vocabulary.js` at render
time. What lives in `decisions.js` is only what the reference cannot hold: the
question that reaches a term, and the near misses. A distinction like
Pill-versus-Badge belongs to neither page alone, which is why neither page
could ever state it.

**Both directions are tested**, the same insight that made `vocabulary.spec.js`
worth having. Forward — every outcome names a real term — would eventually be
noticed by somebody copying dead markup. Reverse — **every shipped term is
reachable by some path** — never would: a component ships, the teacher does not
mention it, and the one page whose job is completeness is quietly incomplete.
`Chip` and `Surface` are the only exclusions, and they take a reason: they are
the two lineages, so you never choose them.

Writing it found **eight errors in the first draft that reading it could not**:
`.pill.outlined` and `.badge.outlined` do not exist, `menu`/`hover`/`divided`
belong on the list container rather than the entry, and `pills`/`stretch` and
the tone belong on `.tablist` rather than `.tabs`. Each would have rendered a
control that did nothing, which teaches that treatments are decorative. The
test that catches them asks whether the generated markup matches a rule it did
not match without the class — not whether the class exists, which it does.

---

**2026-08-08 · Syntax highlighting is `glow()` in `@frontierjs/utils`, and its
theme is element selectors in `@frontierjs/css`. Neither side knows a class.**

The guide had 137 code samples and no highlighting. The obvious shape — a
highlighter that emits `<span class="token keyword">` and a stylesheet that
styles those classes — was rejected on both halves of the split.

**The output is elements, not classes.** glow marks a token with the HTML
element that already means it: `<em>` a value, `<sup>` a comment, `<b>` an
identifier, `<strong>` a keyword, `<label>` an at-rule, `<i>` punctuation. The
whole theme is therefore `code[language] em { … }`, which means the package
ships **no new class** — nothing to add to `vocabulary.js`, nothing for a
consumer to import, and any other highlighter emitting the same shape is themed
for free. The wrapper carries the language as an attribute so a theme can key
on it without the caller adding anything.

**The function lives in `@frontierjs/utils`, not in `css`.** `glow(source,
opts)` is a string in and a string out with no clock, no I/O and no framework
import — the exact rule that package was created around, and its first export.
`@frontierjs/css` stays what it claims to be: CSS, no build step, `main` is a
stylesheet. `css` takes `utils` as a **devDependency** for the guide and the
test suite; nothing it ships imports it.

*(The package was `@frontierjs/utils` when this was ruled and is
`@frontierjs/toolbelt` now — `glow` is the `/glow` kit, the ruling is unchanged.
See § Repo conventions, 2026-08-15.)*

**The guide imports the sibling package's real file** — `../../toolbelt/src/
glow/glow.js` — rather than vendoring a copy. A browser clamps `..` at the origin,
so `demo/serve.js` now serves the workspace root; over `file://` the path just
resolves. That is also why `guide.js` became an ES module. `vocabulary.js`
stays a classic script, because `test/run.js` inlines its source.

**The tone palette is clamped, not blended.** A tone is tuned as a *fill behind
white text*; as text on a surface it mostly fails. Measured across the eight
shipped themes the raw tones came in as low as 1.65:1, and only one theme had
all six roles above AA. Blending each tone toward `--ink` fixes it at 55% but
flattens every well-tuned theme equally. Instead each tone passes through a
lightness window in oklch — hue and chroma untouched — which is a **no-op
wherever the tone already reads**, so a theme that was fine stays looking like
itself.

The window is two tokens rather than a derivation because CSS cannot derive it:
relative colour syntax exposes the channels of one origin colour, and the origin
is the tone, not the surface it will land on. So a dark theme has to declare the
inverted window, the way it already declares `color-scheme: dark`. `code: every
token clears AA in theme-*` pins all eight.

*(Amended 2026-08-16, `@frontierjs/css` v0.16, closing `FJS-027`. The window is
`--tone-l-min` / `--tone-l-max` and was `--code-l-*`: the ruling is about a tone
rendered as **text**, and code was only the first place it happened.
`.btn.outlined`, `.btn.link` and a toned `.btn.ghost` were painting the raw tone
onto a surface and were under AA on 34, 30 and 24 of 72 tone × theme pairs
respectively, worst 1.19:1. `--tone-ink` in `tones.css` is the same clamp off
whatever tone the element carries, declared on `*` like the tint ramp so it is
guaranteed-invalid untoned and `var(--tone-ink, X)` states the untoned look. The
blend was re-measured on that grid and still loses — `--tint-ink`'s 55% toward
`--ink` puts `sunset`/`warning` at 4.05:1, where the clamp's worst case across
all three variants is 6.02:1. `.outlined`'s border takes the same colour, which
is WCAG 1.4.11 rather than 1.4.3: a boundary at 1.99:1 is the variant not being
drawn.)*

Comments and punctuation are deliberately **not** derived — they are the
theme's own `--ink-mute` and `--ink-soft` verbatim, so retuning a theme's ink
ramp moves them, and a theme whose muted ink does not read is visible as a
theme defect rather than absorbed here (`FJS-125`).

---

**2026-08-16 · A theme ships no selector, so anything a look needs is a token — and a token has to reach a descendant to count.**

The contract was already this, and `themes/press.css` exists to probe it: if a
design needs a rule of its own, the token that would have carried it is missing.
Four were (`FJS-158`, `-159`, `-160`, `-161`), and only one of the four was
simply absent. The other three are the interesting shape: **a token that stops
at the element it is written on**, which looks identical to a working one in any
demo that is one element deep.

`--border-width` is the structural hairline — card, field, table, topbar, code
block, tab strip, seventeen literals before it — with `--field-border-width` and
`--table-border-width` falling back to it, because a Field's box and a Card's
edge are not the same decision in every design. `--surface-shadow` is resting
elevation on the Block tier, `none` by default, so `--shadow-*` stops being an
overlay-only ladder. `--app-bg` / `--topbar-bg` / `--sidebar-bg` / `--dialog-bg`
are the frame's own grounds; basecamp's prototype had three distinct dark
surfaces and had recorded losing two of them to `--surface`. `--space-*-base` is
the ladder's shape, because a rung is `base × density` and only the base
inherits.

**Three rules follow, and each one is a way to get it wrong:**

*A default that is another token is a use-site fallback, never a `:root`
declaration.* `--topbar-bg: var(--surface)` at `:root` resolves once, against
`:root`'s own `--surface`, and inherits that colour past every `.theme-*`. The
same alias trap `--ring` and `--badge-radius` are already written around.

*A token a theme must reach cannot be declared on the component.* `.table {
--table-border-width: var(--border-width) }` reads correctly and makes the token
unreachable — the component's own declaration beats the same token set on any
ancestor. Read it at the use site instead. `--table-bg` stays declared, and the
difference is who the token is for: one is for a caller styling one table, the
other for a theme styling every table.

*What is drawn with `border` and is not a border does not scale.* A spinner
ring, a tooltip arrow, a step marker's disc. Widening those with the theme's
hairline distorts a shape rather than thickening a line. The one pair that must
stay related is the tab indicator: `calc(var(--border-width) + 1px)`, bleeding by
the strip's own weight, or a heavy theme draws a 3px rule with a 2px underline
over it and the selected tab reads as a gap in the line.

**What a token deliberately does not do is carry ink.** A dark sidebar in a
light app does not follow from `--sidebar-bg` — the labels inside still read the
light ramp. The answer needs no new mechanism, because a theme is a class of
inheriting tokens and nothing else: `<nav class="sidebar theme-dark">`. Grounds
separate surfaces WITHIN one ramp; a theme class inverts one.

`theming.spec.js` holds all of it, and every assertion measures a descendant of
the element carrying the token.

---

**2026-08-08 · The tint ramp is three named tokens, and `tones.css` is the only place the percentages live.**
`--tint-surface` (10% into `--surface`), `--tint-rule` (30% into `--rule`),
`--tint-ink` (55% into `--ink`). The names say which token each one tints, so
there is nothing to look up.

Those three numbers already existed — inside `surface.css`, private to the
block lineage. An app that wanted a strip tinted like a toned Card had to
re-derive them by hand and then promise to keep them equal forever.
`surface.css` now *reads* the ramp instead of restating it, so there is one
definition and a test that fails if that stops being true.

**Not `lighten-N` / `darken-N`, and the difference is the reason.** A lighten
scale mixes toward **white**; these mix toward `--surface` and `--ink`, which a
theme redefines — so one set of percentages is correct in light and dark alike.
A fixed "lighten 90%" is a light-theme assumption wearing a neutral name. (The
v0.5 `lighten-N`/`darken-N` Uno shortcuts wrote `--bg`/`--color`, which no rule
ever read; they never worked and were removed in v0.6. These are not their
replacement.)

**Declared on the universal selector, deliberately.** Listing the seven tone
classes again would make adding an eighth tone *two* edits in `tones.css`, and
that file's whole promise is that it is one line. There is no selector for "any
element where `--bg-mix` is set", so the derivation is declared everywhere and
the cascade decides: `--bg-mix` is registered `inherits: false` with no
initial-value, so on an untoned element it is guaranteed-invalid, each
`color-mix()` becomes invalid at computed-value time, and the token stays unset
— which is what makes `var(--tint-rule, var(--rule))` degrade on its own. The
same mechanism means every element computes from its **own** tone, so nothing
leaks into an untoned child.

Every rendered colour in the package is byte-identical after the change —
verified in a browser against a captured baseline (toned/untoned Card, nested,
dark theme, both lineages), not assumed. Five tests in `tones.spec.js` pin it,
including one that overrides `--tint-surface` and asserts a Card follows.
*Lives in:* `packages/css/src/foundation/tones.css`; read by `surface.css`;
`guide/guide.js` → *Tones & contrast* → "The tint ramp".

**2026-08-08 · `Bar` and `Toolbar` are two terms. The difference is a promise, not a pixel.**
They render identically. `Bar` is a horizontal strip and nothing else — no
role, no keyboard contract, contents are whatever you put there. `Toolbar` is a
strip whose contents are *controls*, presented to assistive tech as one widget
with **one tab stop**.

Splitting them rather than renaming Bar, because both things are real and the
package already had both: this file's own comments used the word "toolbar"
three times to describe what `Bar` was doing. The word was load-bearing and had
nowhere to live, which is the definition of a missing term.

**`role="toolbar"` is the reason this needed a decision.** It is a composite
widget: Tab enters and leaves once, arrow keys move between the controls
inside. CSS cannot supply that, and this package ships no JS — so the same
split as `tabs.css` applies (Principle 6): *visual treatment is a class,
keyboard behaviour is a component*. The app owes a roving `tabindex`,
Left/Right, and Home/End.

The rule that follows, and the reason `Bar` is not deprecated: **a toolbar that
announces itself and then ignores an arrow key is worse than a plain Bar**,
because it has told the user a lie about how to operate it. If you are not
providing the keys, use `.bar` — same strip, promises nothing.

Layout is shared through `:where(.bar, .toolbar)` at zero specificity; defaults
differ because they follow the meaning (a Bar splits, a Toolbar packs to the
start). Bar's five rendered variants are unchanged — verified in a browser
against the previous computed values, not assumed.
*Lives in:* `packages/css/src/patterns/bars.css`; `vocabulary.js`;
`guide/guide.js` → *Bar* → "Bar or Toolbar?".

**2026-08-08 · The vocabulary covers everything the stylesheet ships, and a test says so.**
Six tiers / 35 terms → **eight tiers / 53 terms**. Nothing was designed: the CSS
already shipped every addition and the vocabulary simply did not name it.

The guide had claimed *"all 35 vocabulary terms ship CSS"* since v0.6. True, and
half the question — **the reverse was never asked, and it was false eighteen
times.** `table` had its own guide page and no term. `tabs`, `disclosure`,
`switch`, `progress`, `spinner`, `skeleton`, `empty`, `breadcrumb`, `pagination`
and the nav list all shipped unnamed. `stack`/`cluster`/`center`/`split`/
`container` were documented on their own page and absent from the list. And
**`chip` and `surface` — the two lineages every other term extends — were not
in the vocabulary at all**, while the Composition page taught nothing else.

Two new tiers, because neither fits the containment ladder: **Base** (Chip,
Surface) and **Layout** (Stack, Cluster, Center, Split, Container — Every
Layout's names, kept deliberately: it is the vocabulary people already have).

**The vocabulary moved out of the guide** into `vocabulary.js`, because a
vocabulary only the documentation knows about is one nothing can check. One
file, two readers: the guide loads it with `<script src>`, the runner inlines
the same source into its page. It is a classic script and cannot become a
module — the guide needs it to run *before* `guide.js`, and module scripts are
deferred past every classic one.

`test/specs/vocabulary.spec.js` asks both directions **against the real CSSOM,
not the source files** — the two disagree, because `.chip` and `.surface` never
appear as their own rule and exist only inside a `:where()` group, so a grep
concludes they are not shipped. A class containing `-` is Anatomy by the
package's own convention and is skipped; everything else must be a term or be
listed in `NOT_A_TERM` under tone / treatment / modifier / container / anatomy /
heading, with a reason. Shipping something unnamed now fails the suite, and the
fix is a decision rather than an edit that makes red go away.
*Lives in:* `packages/css/vocabulary.js`; `test/specs/vocabulary.spec.js`;
`guide/index.html` loads it.

**2026-08-08 · `Pill` is the count and `Badge` is the status. Kept, against the industry.**
The distinction is right and every large system draws it. Nobody agrees on
which word goes where, and **`badge` is the word they disagree about** — it
names the *count* in more systems than it names the *status*:

| System | The count | The status |
|---|---|---|
| **FrontierJS** | **Pill** | **Badge** |
| Atlassian | Badge | Lozenge |
| Material 3 | Badge | Chip |
| Primer | Counter label | Label |
| Polaris | — | Badge (Tag = a removable keyword) |
| Bootstrap | Badge for both; `rounded-pill` is a *shape* |  |

So FrontierJS agrees with Polaris and contradicts Atlassian, Material and
Bootstrap on the one word an arriving reader is most likely to have opinions
about. And `pill` is a shape word nearly everywhere else — Bootstrap's
`rounded-pill`, Uno's `rounded-full` — so it reads as a modifier rather than a
noun.

**Kept regardless.** The pair is internally consistent, both words are short,
and the shape carries the meaning rather than only the name: a rounded end
reads as a value, a square uppercase box reads as a label. Renaming buys
agreement with an industry that does not agree with itself, at the cost of
every app in the repo.

**What the decision obliges instead.** The failure mode is silent — a count in
a `badge` renders fine, nothing complains, and the vocabulary stops meaning
anything. So the collision is documented where a reader meets it, not only
here: the guide's *Badges & Pills* page carries the comparison table, and both
stylesheet headers state it. If a third place starts explaining this, that is
the signal the name lost.
*Lives in:* `packages/css/src/components/pills.css`, `badges.css`;
`guide/guide.js` → *Badges & Pills* → "What these words mean elsewhere".

**2026-08-08 · UnoCSS is supported alongside `@frontierjs/css`, not banned.**
Amends Invariant 13, which previously read "No UnoCSS, no utility classes,
anywhere." The semantic half of the invariant stands unchanged and is the part
that matters: style with a **tone** and a **treatment**, never a colour. What
is withdrawn is the ban on an app *also* running Uno.

The ban never described the package anyway. `packages/css/README.md` has
carried a measured §Using it with UnoCSS since v0.10.1 — layer position for
`uno.css`, the unlayered-reset trap that silently zeroes `.btn` padding and
`h1` size, and the three colliding class names — all verified against UnoCSS
66.7.5 with `presetWind3`. A repo-level invariant said "never" while the
package shipped the instructions, so the two documents contradicted each
other and the README was the one that had been run.

**The boundary that replaces it:** a package in *this* repo ships no utility
classes. `@frontierjs/ui`, `example/` and `basecamp` must render correctly with
Uno absent, because a component that needs Uno to look right cannot be used by
an app that does not run it. Uno is a consuming app's choice, one layer, opt in.

The `text-*` collision is now a third option rather than a fork: the scale is
`--text-*` tokens, so an app that prefers Uno's 4px grid retunes the tokens and
gets *one* scale under both sets of class names, instead of blocklisting.
*Lives in:* root `CLAUDE.md` Invariant 13; `packages/css/README.md`
§Using it with UnoCSS; `packages/css/src/foundation/tokens.css`.

**2026-08-08 · The type scale is tokens. No literal `font-size` in a component.**
`--text-2xs … --text-4xl` (11 → 36px) plus six unitless `--leading-*`, declared
once in `tokens.css`. The `.text-*` utilities and `h1`–`h6` read the **same**
rungs, which is why `.text-xl` and `<h4>` are one number rather than two that
agreed by hand.

Before this, 53 sizes were literal across 20 files, and 4 of them were written
in two spellings at once: `13px` **and** `0.8125rem`, `14px` **and**
`0.875rem`, `11px` **and** `0.6875rem`, `22px` **and** `1.375rem`. The px half
does not scale when a reader raises their browser's base font — so the same
nominal size was accessible in a table cell and not in a popover, in one
package, by accident. Every substitution was pixel-identical except
`.empty-title` (17 → 18px), which was off the ladder entirely.

Values are **literal** in `:root`, never `--text-sm: var(--text-md)` — the
2026-08-02 alias ruling above applies to this ladder exactly as it does to
`--ring`.
*Lives in:* `packages/css/src/foundation/tokens.css`; every file under
`src/components/` and `src/patterns/`.

**2026-08-02 · An alias token declared in `:root` is always wrong.**
If token A should follow token B, write the fallback at the *use site* —
`var(--ring, var(--color-primary))` — and do not declare A at all. The
`:root` form (`--ring: var(--color-primary)`) looks equivalent and silently
is not: the `var()` resolves once against `:root`'s own value and the result
inherits straight past every `.theme-*` override. This has now bitten twice:
`--badge-radius` (Elite's square buttons kept round badges) and `--ring`
(**every** focus ring in **every** theme was the default blue). There is no
case where the `:root` form does what it looks like it does.
*Lives in:* `packages/css/tokens.css`; tested in `test/specs/focus.spec.js`.

**2026-08-02 · One focus ring, in the last cascade layer.**
`focus.css` writes the whole recipe once, at `:where()` specificity, in the
`a11y` layer. Variation goes through `--ring-color` / `--ring-width` /
`--ring-offset`, never a second recipe. It is in the last layer so a component
cannot switch the ring off by accident — which is exactly what had happened:
`.btn.outlined { box-shadow: none }` and the ring's `box-shadow` were the same
specificity in the same layer, so outlined and link buttons had **no focus
indicator at all**. A consumer's unlayered CSS still overrides deliberately.
*Lives in:* `packages/css/focus.css`; `test/specs/focus.spec.js`.

**2026-08-02 · A Treatment class works on every element that reads it, or it is a bug.**
This was already the rule for the seven tones; it applies equally to
`.raised` / `.outlined` / `.ghost`. Only `.outlined` was implemented on `.btn`,
so a toolbar of `.btn.ghost` rendered as solid primary blue. The test for a new
Treatment consumer is not "does it look right" but "does every value of that
Treatment do something".
*Lives in:* `packages/css/buttons.css`; `test/specs/components.spec.js`.

**2026-08-02 · Competing background inputs compose through a variable, not specificity.**
Stripe, hover and tone all want a say in a table row and only one can own
`background`. They set `--row-base` and the tone mixes into it, so a tone
survives a stripe instead of being out-specified by it. Any future "several
things tint the same surface" follows the same shape.
*Lives in:* `packages/css/tables.css`; `test/specs/tables.spec.js`.

**2026-08-02 · `.icon` means "this element IS an icon". The icon-only button is `.btn.square`.**
**Breaking rename**, v0.10. One class cannot mean both, or `<button class="btn
icon">` sizes the button itself to 1.15em. Icon sizing is one rule in
`icon.css` — it was previously hand-copied into three files with three
different sizes and a missing selector branch — covering the components the
package owns, plus `.icon` for anywhere else, varied by `--icon-size`.
Note the old markup fails *quietly*: with `border-box` a width under
padding+border clamps, so a stale `.btn.icon` floors at 30x30 and looks
roughly right while having lost its `aspect-ratio` and padding.
*Lives in:* `packages/css/icon.css`, `buttons.css`; `test/specs/core-gaps.spec.js`.

**2026-08-02 · Interactive state is styled from ARIA, never from a class.**
`[aria-selected]`, `[aria-current]`, `:user-invalid`, `[hidden]`, `[open]`.
A class lets the visual state and the announced state drift the moment someone
updates one and forgets the other; keying off the attribute makes that
divergence unrepresentable. Every affected component has a test asserting that
adding `.active` / `.current` / `.selected` fails to fake it. The one documented
exception is a completed Step — there is no ARIA token for "done", so the markup
owes assistive tech a `.visually-hidden` word.
*Lives in:* `tabs.css`, `nav.css`, `steps.css`, `form-core.css`.

*(A 2026-08-04 ruling that Basecamp declare no `@@gate` was withdrawn the same
day. It rested on the premise that no `getLevel` could grade a `@frontierjs/auth`
session past `VISITOR(1)`; `example/` disproved that by running it —
`sessionGateLevel()` plus a one-line role wrapper grades a verified user 4 and a
verified admin 5. Invariant 6 has no exceptions. Basecamp's gates are outstanding
work, not a decision.)*

## Repo conventions

**2026-08-15 · A surface is a sub-project — `widgets/` and `extension/`, peers of `api/`
and `web/` — and an app may have it and nothing else.** Widgets were built out of
`web/src/Embeds/`, inside the SPA's Vite root, which made them share three things
they do not share in practice. **The config is a different target**: `widget`
emits N self-contained IIFEs, `spa` emits one app, and one Vite root is one of
those. **The tests are a different shape**: a widget is proved on a host page it
does not own, with markup and CSS written to be unhelpful, not by driving a
router. **The release is a different release**: static files on an origin a
stranger's page links to, shipped when the pages embedding it are ready, which is
not when the API is. Under `web/`, a widget shipped when the SPA shipped and
nothing said so.

So `widgets/` carries the same six folders every sub-project carries, `db/` stays
at the root owned by nobody, and **which surfaces an app has is the app's
business**: `fli new --template widgets-only` is a whole FrontierJS project whose
product is the embeddable scripts, with no `api/` and no `web/`.

**The same ruling covers `extension/`** — a `@frontierjs/jetty` browser
extension — and the three answers are further from the SPA's than a widget's
are. Its config emits a *manifest*, and one source becomes two builds under
`--browser chrome|firefox|both`. It is loaded unpacked into a browser profile
rather than served, so there is no URL for a drive to point at and its tests are
instructions plus what the build can assert. And it ships as a signed upload to
two web stores under a review measured in days, which no deploy here waits for.
`--template extension-only` is the project whose product is the extension.

**The rule this generalises to**, for whatever surface comes next: a directory
at the app root earns the name when its **config**, its **tests** and its
**release** are all different answers. One of the three differing is a folder;
all three is a sub-project. `db/` stays at the root under every one of them,
owned by none.

**The app owns the install.** One `package.json`, at the app root, for every
surface — `web/`, `widgets/` and `extension/` alike. A `package.json` inside a
surface would look tidier and would break resolution that walks up from it; jetty
found this the hard way, by probing two fixed directories for the Mesa compiler
and silently finding none in the very layout this ruling defines.

**`fli check`'s `app-layout` changed with it.** It used to demand `db/` + `api/` +
`web/` and warn about any missing one, which contradicted its own comment that
api-only and web-only are legitimate, and would have been wrong for widgets-only
three ways. It now asks the two questions that are decidable and silent when
wrong: is the schema at the root, and is a surface hiding inside another one.

**The generator is one function** — `packages/cli/core/widget-surface.js`, called
by `fli new --widgets` and by `fli make:widget`. An app scaffolded by one and
extended by the other cannot be two shapes.

— `packages/cli/core/widget-surface.js`, `core/checks.js`, `packages/sierra/src/build/widget-build.js`, `README.md` §Project Structure, `CLAUDE.md` Invariant 3.

**2026-08-14 · Invariant 17 is a standard, not a wall — `package-root-md` warns.**
The four files at a package root (`README.md`, `CLAUDE.md`, `PROJECT_STATE.md`,
`CHANGES.md`) stay the standard, and the reason stands: the root is the index, and
an index nobody can hold in their head is a directory listing. What changed is the
verdict on a fifth. **The rule cannot tell a stray design note from the next thing
everyone needs at the root**, and it was refusing both — `packages/css/AGENTS.md`
sat behind a named allowance whose own text admitted the question was unruled, and
a generated `surface.snapshot.md` failed a build for being generated output the
rule had no word for.

So it names what it found and asks. An allowance under `structure` in
`scripts/ci-allowances.json` is where the answer gets written down once someone
gives one, which is what that file was always for: a named path with a reason, not
a loosened rule. Generated `*.snapshot.md` is exempt outright — it is gated output
rather than documentation, and nobody is asked to hold it in their head.

**Why not simply raise the number to five.** A count is not the constraint; the
constraint is that a person can read a package root and know where they are. Five
named files would refuse the sixth for the same bad reason, and the rule would
still be unable to say which of the five earned its place. A warning that names
the file puts the judgement where judgement lives.

— `packages/cli/core/checks.js`, `CLAUDE.md` Invariant 17.

**2026-08-15 · `FJS-D32` — FrontierJS adopts a linter and refuses a formatter,
and the refusal is measured rather than preferred.** `IDEAS/tooling-decisions.md`
framed this as a taste call the maintainer owns — keep aligned columns and take a
linter only, or drop alignment and take one tool that does both jobs. It is not a
taste call, because the alignment rule is not only in `CLAUDE.md`: **the code
`fli new` generates is written that way**, so the first `format` run of any of the
three candidates rewrites the app the scaffold had just written. A default whose
first use undoes the tool that produced it is not a default.

So: **Biome, linter only.** `formatter.enabled: false`, and `assist.enabled:
false` with it — Biome's import sorting reorders an aligned import block, which is
a format change wearing a lint rule's clothes. Per-block `biome-ignore format:`
comments are refused under every branch: a comment whose only reader is a tool, in
a house whose rule is that a comment must be load-bearing or deleted.

**The rule set is curated, and coverage is not the objective.** Measured on this
tree: `recommended` gives 7,249 findings; correctness + security + suspicious +
a11y, minus the rules that are taste, gives ~600. `style`, `complexity` and
`performance` are off, because with the formatter refused a linter that argues
about style is a formatter that cannot fix anything.

**The boundary is the half that outlives the tool.** A linter owns generic
JavaScript correctness; `fli check` owns everything derived from the seed; neither
reimplements the other. It is not a maturity gap — Biome reads neither `.mesa` nor
`.lite`, and doctor-class questions are cross-file anyway (*does this resource
name resolve to a model?* cannot be answered from the file it appears in). Without
the sentence, four of `IDEAS/diagnostics.md`'s checks get written as lint rules,
two registries disagree, and neither is authoritative — the shape Invariant 4
exists to prevent. A scaffolded app's `bun run check` therefore runs `fli check`
**first**.

**What is still open** is only this repo's own adoption: ~600 findings, 123 of
them unused imports. That is a countable cleanup with a direction, not an
argument — `FJS-266`.
— `packages/config/`, `IDEAS/tooling-decisions.md` 1 · `ISSUES.md` `FJS-266`.

**2026-08-15 · `FJS-D33` — what a scaffolded app is given is a dependency it
extends, never a file copied into it.** The generated `package.json` and config
files are the framework's real opinion about tooling, and far more people will
read them than will ever read this repo. A copy is frozen at the moment it was
written; `@frontierjs/config` can be corrected for every app that already exists.
`tsconfig.json` and `biome.json` are one line of `extends` each, and the app keeps
only what is about its own layout — `paths` and `include`.

`.editorconfig` is the single exception and it is a mechanical one: EditorConfig
has no extends. It is therefore a hand copy, byte-pinned by a test on both sides
(`packages/config/test` and `packages/cli/tests/app-config.test.js`) — the same
shape as every other hand copy in this repo.

**An app gets a CI workflow**, because the alternative is that it never gets one,
and the workflow calls `bun run check` and nothing else — the rule this repo holds
itself to, one level down: a gate that only exists inside a CI provider cannot be
run before pushing. **`@frontierjs/cli` is a devDependency** rather than a global
assumed on PATH: three of the four scripts call `fli`, and a globally installed
one of a different vintage generating files for this app's framework version is
exactly the drift a pin removes.

**`typecheck` is `fli typecheck`, not `tsc --noEmit`**, and that is forced. Every
`@frontierjs` package ships TypeScript source — each `exports` map points at a
`.ts` — so tsc follows those imports and checks the framework as part of the app's
program: a freshly scaffolded app gets several hundred diagnostics from inside
`node_modules` and none of its own. `skipLibCheck` covers `.d.ts` only and there
is no tsc option for *check my files, not the ones they import*, so the filtering
happens on the output, in `packages/cli/core/typecheck.js`, whose other caller is
this repo's own `scripts/typecheck.mjs`. `FJS-268` holds the underlying question
of whether the framework should ship declarations.
— `packages/cli/core/app-config.js`, `packages/config/`, `IDEAS/overview.md` 5.13.

**2026-08-15 · `drift-report.md` is retired; its synthesis is
`IDEAS/coherence-review.md` and the rest is deleted.** The twelve-package audit
of 2026-07-31 wrote four things into one root-level file, and by now they had
four different half-lives. The resolution log (fixed 2026-08-01) is in the
packages' own `CHANGES.md`. The twelve per-package sections are snapshots of a
tree four months old, and each package's `PROJECT_STATE.md` is the live version.
The appendix bug list said so itself — *the live register is `ISSUES.md`* — and
named two entries that had already proved wrong.

**What was worth keeping is the cross-package synthesis, because it is the only
copy of an argument still in play.** `FJS-D06` points at it — ruled 2026-08-16
for the vocabulary alone, and §2/§3/§5/§8 keep their own ids; §7's
Slice axis and §8's *every convention-wired bridge found was broken somewhere;
every named or typed one had survived* exist nowhere else. Those eight findings
are now an `IDEAS/` record, which is what `IDEAS/` is for — argued, not started —
and the record says in its own header that it is not a register.

**Why delete rather than archive.** A root-level file is read as current; that is
what a root is for. This one had already misled once — `FJS-070` warned for ten
days that its line-number citations were stale, and it had no line numbers at
all. Keeping it as `docs/` would preserve the per-package snapshots, which is
precisely the material that goes wrong quietly: a paragraph describing junction
in July, read in November, with nothing in the text to say which. Git holds it.
— `IDEAS/coherence-review.md` · `ARCHITECT.md` §6 keeps the audit METHOD, which
is reusable and outlives any run of it.

**2026-08-15 · `FJS-D14` — the four claimed folders are named: two collapse into
one package, two are V2.** `orion` is the automations engine and platform.
`toolbelt` is the core pure-function library, shared across repos and meant to
stand on its own outside FrontierJS — which is the reason it is not folded into a
framework package. `datetime-kit` is the date / time / timezone solution.
`oracle` is the solutionizer: it takes a requirement and hands back the mental
model of it.

**Two of the four are now settled by the naming itself.** `toolbelt` as
described *is* `@frontierjs/utils` — core pure functions, shared across repos,
worth having outside FrontierJS — so **`utils` is gone and toolbelt is the
package**, holding everything it held and inheriting the substrate standing
`FJS-D26` granted. `datetime-kit` is not a neighbour of it but a room inside it:
**one package, one kit per subpath**, `@frontierjs/toolbelt/glow` and
`@frontierjs/toolbelt/datetime`. A consumer importing one kit pays for one kit,
and they ship together because a project that wants one usually ends up wanting
two.

The alternative was an umbrella package depending on separately published kits.
It was refused for the size the thing actually is: N package.jsons, N versions
and N release rows buy independent versioning for a set of pure functions that
will be released together anyway, and they put the umbrella itself — a package
with dependencies — in the position substrate is supposed to occupy.

**Purity is not per subpath. It is the whole package**, because it is the whole
of the argument that litestone and mesa may import it (`FJS-D26`). The
framework-aware tier the old `toolbelt/README.md` reserved — env reading, path
resolution, a Junction `ctx` — does not exist and does not get a room here on
spec; a helper that needs a runtime stays in the package that needs it until
something rules otherwise.

**`orion` and `oracle` are V2 and are deferred until FrontierJS core leaves
alpha.** Neither is a gap in the framework: one is an automations *application*
(basecamp's partner) and the other is a domain-modelling tool that stops one
step short of `db/schema.lite`. Both would be built ON the framework, so
building them now spends alpha time on consumers of a thing whose seams are
still moving — and each carries a decision the core has not made yet. Orion's
primary trigger is a model event, which needs a Junction subscriber for
litestone's `onEvent` (`FJS-010`, blocked on `FJS-D04`); Oracle would be the
first `fli` command to call an LLM, which is a posture question about the CLI
rather than about Oracle.

So they stay claimed folders, exempt by name in `scripts/ci-allowances.json`,
and **that exemption is now the answer rather than a placeholder**. Nothing is
owed on either until core is out of alpha; at that point this ruling is the
thing to reopen, and the two READMEs already state what each would cost.

This closes `FJS-D14` — all four folders are named, two collapsed into
`toolbelt`, two deferred.
— `packages/toolbelt/` · `packages/orion/README.md` · `packages/oracle/README.md`.

**2026-08-17 · `FJS-D37` — the terminal is a surface with a tone vocabulary, not a
palette of colour names; `fli` output stays line-oriented; a TUI buys its engine.**
Four rulings from one question, because `packages/cli/core/color.js` and the shape
of a future TUI turn out to be the same decision asked twice.

**§1 — output is styled with a tone, never a colour, and the table lives in
`@frontierjs/toolbelt/tty`.** Invariant 13 already says this for the browser, and the
argument it rests on — a colour name is a fact about one rendering, a tone is a fact
about the message — does not stop at the DOM. `color.js` is chalk-compatible by
design, which was correct for dropping zx off the read-only paths (~85ms of a ~200ms
invocation) and which inherited chalk's vocabulary as a side effect: call sites say
`red`, nothing can retheme, nothing adapts to a light terminal, and the one accent in
the CLI is a hex literal inside a markdown renderer (`core/prose.js:33`).

The table is `tone.*` for the message and `part.*` for what a fragment IS — a path, a
value, a command — and it resolves through a **backend**, because the same vocabulary
has to reach ANSI, terminal cell attributes and the eleven `theme-*` blocks
`@frontierjs/css` already ships. Three palettes for one system is what having no
ruling produces. It lives in toolbelt because a formatter is pure and depends on
nothing, so `FJS-D26` holds and litestone and mesa may import it — which they must,
since they are two of the packages printing today. `color.js` becomes a thin
re-export, so no call site changes on the day it lands.

**§2 — command output and runtime log are two formats with two owners.** Booting
basecamp prints four prefix vocabularies in nine lines — a bracket tag, a
timestamp-level-scope triple, a vite arrow followed by a JSON blob, and a different
bracket tag — from four packages that each had to guess. Invariant 4 says one owner
per translation and *an event becomes a line* has none. They are not one format:
command output is transient, read once by a human watching a command finish, and
wants a verb column with no timestamp; a runtime log is a stream, tailed and
filtered, and wants a timestamp, a level, a scope and a JSON mode. Naming the two is
most of the repair.

**§3 — the shapes are borrowed, not invented.** Cargo's right-aligned verb column for
anything that acts (Rails generators invented it and `fli make:*` has the same job),
rustc's code + `file:line:col` + caret + `help:` for anything that judges, and `gh`'s
rule that every reporting command takes `--json` so nobody scrapes the pretty output.
`fli check`'s eleven rules exist because each is silent when broken; a bullet list is
the weakest available rendering of that.

**§4 — prompts do not grow into a TUI.** A clack-style gutter with a spinner
repaints, owns the cursor and must restore on `SIGINT` — it is a third of a
full-screen renderer, and built incrementally inside a CLI it becomes a private
half-renderer nobody owns. Either prompts run on a TUI stack or they stay
line-oriented; the incremental path is refused by name because it is the default
outcome rather than a choice anyone makes.

**§5 — if a TUI is built, the engine is bought.** Measured against
`packages/mesa/src/runtime.js`: the reactive core (lines 1–760) holds **2** DOM
references and the rest **99**, and the compiler emits a template as an HTML *string*
parsed by `htmlToFragment()` and walked by `refer(root, path)` (`compiler.js:1211`,
`:6880`). Mesa has no renderer abstraction — rendering is DOM-shaped by construction,
which is also why it is fast. Every Mesa target that exists produces markup, server
rendering and `email-kit`'s `target: 'email'` included, so nothing in the tree is
evidence that a non-markup target is cheap. What FJS would differentiate on is one
`.mesa` file and one signal graph reaching a third surface; it is not cell-buffer
diffing, yoga layout, kitty-protocol input parsing or grapheme width, and writing
those is how the interesting half never gets built.

**§6 — a TUI is not scheduled before core leaves alpha**, on `FJS-D14`'s reasoning
unchanged: it would be built ON the framework, so it spends alpha time on a consumer
of seams that are still moving. What is owed now is `FJS-D38` alone — whether a TUI
reuses `.mesa` — so that §1–§3 do not foreclose either answer.
— `packages/cli/core/color.js` · `packages/toolbelt/` · `IDEAS/terminal-surface.md`.

## Dependencies & the ecosystem

**2026-08-14 · `FJS-D31` — FrontierJS wraps third-party binaries, it does not
fork or republish them. It controls the VERSION, never the artifact.** Asked of
Litestream specifically, and the answer generalises.

Litestream ships as GitHub release tarballs, `.deb`, Homebrew and a Docker image;
there is no official npm channel. So publishing `@frontierjs/litestream` would
not be mirroring — it would be **creating** a distribution channel and owning it
forever: six-plus platform tarballs republished on every upstream release, bytes
signed off that we did not build, and bug reports arriving at a name that reads
as *FrontierJS's litestream*. That trade is bad in general and worst here,
because Litestream is a **durability** tool: lagging behind a data-corruption fix
is the one thing this dependency must never do. (The npm name is also already
taken — by an unrelated stream utility, untouched since 2022 — so anyone typing
`bun add litestream` today gets a stranger's package. That argues for documenting
the real install, not for adding a fourth thing with the same name.)

Forking the source is worse again: it means owning WAL parsing, checkpoint
timing and S3 multipart, which is a product, not a feature.

**What we own is the wrapping, and the wrapping is where being Litestone pays.**
Litestream's config names *this file, that bucket*. Only Litestone knows that the
schema declares three databases and one of them is the audit trail. That is the
seam — Litestream owns the bytes, Litestone owns which databases and from where —
and `litestone replicate` already sits on it: it generates the YAML, checks WAL
mode, forwards `SIGINT`/`SIGTERM` so the binary flushes cleanly, and removes the
generated config on exit.

Control of the version is bought four ways, none of which make us a publisher: a
single pinned supported range checked by running the binary; a fetch of that
pinned upstream release with its checksum verified, from `deploy:setup` and
`litestone replicate --install`; `$LITESTREAM_BIN` so an operator with a packaged
copy is not fought; and a digest pin in the Dockerfile `make:deploy` writes.
`FJS-243` is that work — today there is no version check at all.

**Revisit only on a named trigger**: upstream goes unmaintained *and* a CVE
lands; a patch we need is refused upstream; or "install a Go binary first"
measurably costs adoption — and even then a per-platform downloader wrapper (the
esbuild/biome shape) beats a fork, because it still ships upstream's bytes.
*Lives in:* `litestone/src/tools/replicate.js`, `cli/commands/deploy/_steps-setup/`.

**2026-08-15 · SQLite is the only database FrontierJS supports, and serverless
follows from that rather than being refused separately.** Both were recorded
because they were *silences*: an outside framework's feature catalogue listing
*"DynamoDB, SQLite, MySQL, Postgres"* and *"Serverless — on-demand, auto-scaling,
zero maintenance"* mapped to nothing here, and a grep for `postgres` or `mysql`
across all of `IDEAS/` returns one incidental mention inside a Fly anecdote. *Which
databases do you support* is the first question any evaluation asks, and an
unwritten refusal reads to everyone outside this repo as an oversight.

**SQLite only. Not a stage, not a default.** Three reasons, in the order they bite.
**Litestone is a compiler, not a query builder over a driver** — `@@allow` compiles
to a `WHERE`, `@@gate` to a refusal, `@encrypted` and `@guarded` to column handling,
`@@fts` to FTS5 virtual tables with sync triggers, `@@softDelete` into every
generated statement, `@version` into an optimistic-concurrency `UPDATE`. Each of
those is emitted SQL, so a second dialect is not a driver but a second compiler
backend, and every derived guarantee the project sells is asserted against one
emitter's output: the access snapshot, the DDL snapshot, schema mutation testing,
the 14 × 12 matrix. **The other guarantees rest on the file, not on the database** —
`createTestEnv` clones a template database per test (476ms → 13ms) because that is a
filesystem copy; backup and restore (2.11) and time travel (4.13) are affordable
because the Data realm is a file; Litestream replicates a file. A Postgres path
keeps none of it and needs a second answer to each. And **it is the pitch**: one
binary beside one file is the deployment story, and the reason the Release realm can
be honest about what a revert restores.

The cost stated plainly: an application that outgrows one machine's write throughput
outgrows the framework. That ceiling is acceptable because it is high — measured,
5,000 rows at 3.3 µs/op through `createMany()`, reads at 1.13× raw SQLite, live
memory under 10 MB — and because the applications it excludes already have a
platform team. Read scaling, if it is ever wanted, is replicas of the file, never a
second dialect. **Revisit only on a named trigger**: a real user hits the write
ceiling with 2.16's batching already applied, or a requirement arrives that the
database be operated by the customer's own DBA — which is a procurement fact rather
than a technical one, and should be answered as one.

**Serverless is refused as a consequence, not as a taste.** Three things that
already ship assume a stateful, long-lived process, and any one of them alone rules
out request-scoped execution: the database is a file on local disk in WAL mode;
Junction holds WebSocket sockets and channel membership in process memory; Caravan is
an in-process queue and cron. Making them serverless means an external database, an
external pub/sub and an external queue — at which point every advantage above is
gone and the result is a weaker version of a framework that started there.

**Keep the distinction**: serverless as a *runtime* is refused; **static asset
delivery over a CDN is not a framework question at all.** Sierra's `static` target
already emits a directory any host or CDN serves, and nothing prevents putting one in
front of an app's assets. The single place it touches the design is 2.3d, whose
retention window becomes a cache-invalidation window as well — to be stated there
when that row is built, not pre-empted here.
*Lives in:* `litestone/src/core/ddl.js` and `client.js` (the emitters) ·
`IDEAS/speed-and-footprint.md` (the numbers).

**2026-08-15 · `FJS-D26` — `@frontierjs/toolbelt` is substrate, not a member of
the dependency graph. Any package may import it, mesa and litestone included.** The question was what *leaf* meant, and it was undecidable while two
documents wrote down two answers: Invariant 1 said mesa carried zero workspace
dependencies and the pure-function package's README claimed the same standing to
grant itself an exemption from it. Invariant 1 now states the dependency
direction alone, which settles it in the README's favour — `Litestone ← Junction
← Sierra` is a rule about *framework packages*, and substrate sits below the
arrow rather than on it.

What makes the exemption safe is what the substrate may itself depend on:
**nothing**. Zero dependencies, workspace or otherwise, and pure functions only —
no clock, no filesystem, no network. That is the whole of the argument that
importing it cannot create a cycle or route a package around the direction, so a
single `Date.now()` in its `src/` retires the argument rather than bending it.
`scripts/ci.mjs` § hygiene enforces it (`FJS-258`): no dependency in the
manifest, and under `src/` no clock, no global, no network call and no import
that is not relative — one blunt rule instead of a list of forbidden names.

Unblocks `FJS-191` (mesa runs a forked `glow` with the bugs the other copy fixed)
and `FJS-192` (four inflection rule sets resolving one invariant). Both are one
import away and were waiting only on this.

**The package's NAME is not ruled here** — `FJS-D14` carries whether this is
`utils` or `toolbelt`, and the standing travels with whichever wins.
*Lives in:* `packages/toolbelt/` (`@frontierjs/utils` until the same day, see
§ Repo conventions) · `CLAUDE.md` § Invariants 1.

**2026-08-17 · `FJS-D16` amended — `createStore` does NOT move to the substrate,
and the reason is the licence rather than the effort.** The 2026-08-15 ruling
named three things to move: `createMakeFromSchema`, `createStore`, and the
`mergeHooks`/`runPhase`/`runAroundHooks` pipeline. Two moved and are now
`@frontierjs/toolbelt/jsonschema` and `@frontierjs/toolbelt/hooks`. The third
cannot: **a store is state**, and `FJS-D26` grants toolbelt its standing below
the dependency graph on *every export is a pure function* — "purity is not per
subpath, it is the whole package, because it is the whole of the argument that
litestone and mesa may import it". A factory returning a mutable subscription
list is not that, and admitting one costs the standing that makes the package
worth having.

**The second finding is that the two stores were never one fact anyway.**
Sierra's `createStore(service, opts)` is service-backed and stamps each request,
so a slower earlier `find` landing second cannot overwrite newer rows; jetty's
`createStore(opts)` takes no service at all — Junction lives in Harbor, not in
the page — binds an `idField` at construction and exposes `populate(service, …)`
instead. Different signature, different semantics, and the shared remainder is a
~40-line subscribe/notify list. That is the same test the ruling applied to the
orchestrator and reached the same answer: *duplication is not the defect, a fact
with two owners is.*

**`mergeHooks` changed shape on the way, for the same licence.** It merged in
place; it now answers a NEW map and mutates neither argument. Both callers hold
their hook map in a variable and reassign. The in-place spelling read as
`mergeHooks(a, b)` with the result discarded, so the failure mode after this
change — forgetting the assignment — is a map that never grew, which is louder
than one silently rewritten. It is re-exported from `@frontierjs/jetty/resources`
and that surface changes with it.

**What the move was worth beyond the dedupe**: jetty's `make()` was Sierra
v0.1.0's and had drifted two versions behind. Measured against one schema, the
old copy answered `customerId: 0` for a foreign key — customer #0, a claim
nobody made, which passes coercion and validation and is refused by SQLite as a
500 — and `trackingCode: ''` for a `readOnly` column, a key the Data boundary
refuses BY NAME so the form could not submit at all. Both are correct now
because there is one implementation rather than because anyone noticed.
*Lives in:* `packages/toolbelt/src/{hooks,jsonschema}/` ·
`packages/sierra/src/junction/resource.js` · `packages/jetty/src/resources/`.

**2026-08-15 · `FJS-D16` — all three duplications CLOSE, by three different
mechanisms, because the obstacle is different in each. The rule underneath is
one: the owner is whoever already computes the fact, and a copy exists because a
door was shut — so open the door rather than keeping the copy in sync.**

A "keep in sync" comment is not a mechanism. All three carried one, and two had
already drifted: `auth/install.md` once emitted `@@gate("9")` — LOCKED, above
`asSystem()` — so a generated schema locked the auth tables against the auth
package itself, and jetty's resource copy is 302 lines against sierra's 1003
under a header still claiming it "mirrors sierra … exactly".

**The HMR algorithm → import it from `@frontierjs/mesa`.** No new package, no new
edge: mesa already ships `mesa-vite/` in its `files:` and exports `./vite` and
`./vite/client`, and sierra and jetty both already peer-depend on mesa. The copy
exists because half the algorithm was reachable and half was not — `client.js`
is exported, `injectHMR` is module-private. Export the second half, push sierra's
improvements to the first half UP into mesa, and delete sierra's two files.
Sierra's stated reason for reimplementing — frontmatter stripping, the fence
preprocessor, slot rewriting — is about the PLUGIN, which stays sierra's; it was
never an argument about these two files.

**The copy was ahead of the original in three ways, which is the argument for
merging rather than choosing.** Sierra's client falls back to
`import.meta.hot.invalidate()` where mesa's only warned and lost the edit; its
`canInject` fails CLOSED where mesa ran two `.replace()` calls that are silent
when they stop matching; and its `hot.accept` sets `__setMark` on the NEW
function rather than the old module's, without which the first update registers
with `hmrMark: undefined` and the SECOND drops the entry as stale — **mesa's HMR
worked once per page load and then reported no connected instances.** Nothing
tested the boundary in either package, which is how that survived.

**Jetty's is an ADAPTATION and stays**, which is the line this ruling draws: its
registry is on `globalThis` rather than module exports, `hot_update(id,
moduleOrFn)` resolves two shapes and answers a count, and there is no
`import.meta.hot` anywhere in it — an MV3 content script is a classic script and
Vite's HMR client is not in the page. The one fact with two owners in there is
the ~30-line DOM swap between the mark and the anchor. Extracting it is worth
doing and is filed (`FJS-259`); it is not done here because that surface has no
test and the package's suite is already red for an unrelated reason, so it would
be untested surgery on the one thing jetty's dev loop depends on.

**jetty's copy of sierra's `resources/` → the pure half to the substrate, and
NOT a new package.** `docs/future-refactors.md` plans
`@frontierjs/resources-core`; that is refused. A fifth published package costs a
release cadence, a peer range, an install entry and a `files:` field, for ~190
lines that are pure and zero-dependency — which is the definition the substrate
package already wrote for itself (`FJS-D26`). `createMakeFromSchema`,
`createStore` and the `mergeHooks`/`runPhase`/`runAroundHooks` pipeline move
there and both sides import them.

**The orchestrator stays duplicated, deliberately**, and that is the part of the
extraction plan being rejected rather than deferred: sierra calls
`client.service(name)`, jetty calls `harbor.request('service:call')`, and that
is where the 1003 lines and the 302 actually differ. A `defineResource({
transport })` seam is worth having when something needs it; forcing it now
couples sierra's release cadence to jetty's for no coverage gained, which is the
reason the plan was deferred and is still true. **Duplication is not the defect —
a fact with two owners is.** A transport is not a fact; it is two of them.

Jetty's Feathers-style event names are a **separate bug**, not a duplication, and
must not ride the extraction: it subscribes on the WIRE to `${name}:created`,
which is the BUS spelling (§ API design, 2026-08-02).

**The auth schema copy → resolve the owner out of the APP, then delete the
concept.** The obstacle here is resolution, not direction: `fli` is a global CLI,
is not installed beside the app, and the app's auth version varies, so neither a
dependency nor a peer range can reach it. `auth:install` installs
`@frontierjs/auth` already — install FIRST, then resolve it from the app's own
`node_modules` and call `authSchemaFragments(db)`. One owner, and the fragments
match the auth the app will actually run.

That is the interim. **The end state is that nothing is copied at all**, and it
is small: litestone already resolves `import "./models/users.lite"` inside a
schema, but only as a path (`resolve(dirname(currentPath), imp.path)`). Teach it
that a non-relative specifier goes through node resolution and an app's
`schema.lite` can say `import "@frontierjs/auth/schema.lite"` — which also fixes
what the interim cannot: today the fragments are pasted as TEXT, so an auth
upgrade never reaches a schema that was generated once.

Closes `FJS-D16`; fixes `FJS-038` and the duplication half of `FJS-059`.
*Lives in:* `packages/mesa/mesa-vite/` · `packages/toolbelt/src/` ·
`packages/cli/commands/auth/install.md` · `packages/litestone/src/core/parser.js`
(`parseFile`).

**2026-08-15 · `FJS-D12` — FrontierJS ships English, and the seam is reserved by
six constraints rather than by a catalogue.** The premise the row was filed under
expired before the ruling did: it said i18n had to be decided *before* schema→UI
shipped, and schema→UI shipped without it, because the generator authors no
string — a label is `@label` where the schema declares one and the title-cased
column name otherwise, which is exactly what a hand-written control already
resolved. What generation multiplies is call sites, not strings. So this is no
longer a gate on anything; it is the question of what may be written down now so
that a catalogue can arrive later without a `.lite` syntax change.

**Nobody in this space has solved it at the schema level, and that survey is what
makes deferring safe.** ZenStack is the closest cousin — the same shape of
attributes over a schema, `@@allow` included — and it takes a literal message per
validation attribute (`@length(min: 8, max: 32, message: '…')`), single-locale,
exactly our `@required("…")`; it has no i18n at all, and the community answer is
to key off the error CODE and translate on the client. Prisma declares no labels,
so it has no problem to have. Rails is the one that proves the cheap path:
`human_attribute_name` resolves a DERIVED key path and falls back to the
humanised column name, and validation messages are keyed by the validator's name
— zero authored keys, and zero cost for an app that never translates. Django adds
lazy resolution (`gettext_lazy`), so the declaration holds a promise and the
locale is decided at render rather than at parse. Payload does two separate
things and is right to: a label keyed by locale for the configuration string, and
`localized: true` per field for the DATA, negotiated with `?locale=` plus a
fallback locale. Drupal's three-way split states the shape most clearly —
interface strings, configuration strings, content — three mechanisms on purpose,
and conflating any two is the classic mistake. Paraglide is the modern mechanism:
compile messages into typed tree-shakeable functions, so a page carries the
strings it uses instead of a catalogue and a parser.

**What we take is the derived key, and the rest is six constraints that cost
nothing today:**

1. **`@label` is a default English string, never a key.** A string's address is
   derived — `Model.field.label` — the way litestone already derives a table
   name. No `.lite` syntax changes when a catalogue arrives.
2. **An error carries a stable code and its params; the sentence is a fallback,
   not the contract.** `x-messages` is already keyed by rule name *and* by the
   JSON Schema keyword it compiles to, and `toFieldErrors` is already the one
   owner of thrown value → per-field messages. This is error design that happens
   to make translation possible later.
3. **Configuration strings and content are two mechanisms, never one attribute.**
   `@label` is configuration. A per-locale column VALUE is content, stays
   unbuilt, and whatever it ends up called is not `@label` with a second
   argument.
4. **`@frontierjs/toolbelt/inflect` is structural English and never takes a
   locale.** It crosses `model Post` ⇄ `posts` ⇄ `db.post` for five callers, so a
   locale there renames tables (Invariant 2). Message pluralisation is CLDR
   plural categories and belongs in a different module.
5. **A kit component's strings are props with English defaults.**
   `@frontierjs/ui` peers on mesa and css alone, and a component that needs a
   catalogue installed before it can render `Close` is unusable by an app that
   has none — Invariant 13's argument, applied to strings.
6. **Formatting gets one owner the day it arrives.** There is no `Intl.` anywhere
   in the tree today; keeping it that way by rule is what stops locale-aware
   dates and numbers landing at every call site.

Deferred to V2: catalogues, locale negotiation, pluralisation, per-locale data,
and `lexicon` as a package. The deferral is safe because of (1) and (2) — every
user-facing string is addressable and every error is identifiable, so the
catalogue is GENERATED rather than excavated.

**Three things are reserved as ours, as candidates rather than commitments.** A
`strings.snapshot.md` gated by the `snapshots` phase, derived from the seed, so a
new column with no label is a diff rather than an archaeology dig — the
Rails-world equivalent is a third-party grep over source, and nothing derives the
register from the schema. Locale as a client flavour, `db.$setLocale('es')`
beside `$setAuth` / `asSystem` / `$scopedBy`, where Payload uses a query
parameter and Directus a join table. And per-locale prerender on the `static`
target, which is Paraglide's bundle win out of a loop the build already runs.

Closes `FJS-D12`, and retires the *1.5 precedes 1.1* dependency in
`IDEAS/overview.md`.
*Lives in:* `packages/litestone/src/core/parser.js` (`@label`) ·
`packages/sierra/src/junction/field-rules.js` (`labelFieldFor`, `toFieldErrors`)
· `packages/toolbelt/src/inflect/inflect.js` · `IDEAS/ecosystem-gaps.md` 4.

## Open (discussed, not yet ruled)

**Moved to `ISSUES.md` § Needs a decision (2026-08-05)** — every unruled question
in the repo is listed there with an id, so that "what is waiting on me?" is one
table rather than six. A ruling comes back **here** and closes the row there.

What was listed here has since been ruled, every one of it, and each ruling is
above: `FJS-D01` junction structural refactor (2026-08-13) · `FJS-D11` bulk
PATCH/REMOVE partial success (2026-08-14) · `FJS-D04` litestone `onEvent`
post-construction subscribe (2026-08-16) · `FJS-D06` coherence-review vocabulary
(2026-08-16) · `FJS-D09` migrations second tier (2026-08-16) · `FJS-D10` the
deferred API cluster (2026-08-16). What is still unruled is `ISSUES.md`
§ Needs a decision, which is five rows.
