# Decisions

Dated rulings by the project owner. These are settled unless explicitly reopened —
do not "fix" behavior back toward what a decision replaced. When a decision is
reversed, amend it here (strike and date it), don't delete it.

Format: **decision — why — where it lives.**

A ruling is a `###` heading under its section, carrying its date and its id:

```
### <a id="fjs-d00"></a>2026-08-08 · `FJS-D00` — the claim, stated flatly
```

The id is what a code comment, an issue row or another ruling cites, and the
anchor is what a link resolves to. **A section runs newest first**, so a new
ruling is prepended to its section and the top of one is the current thinking —
which was the practice in seven sections of nine and written down in none, so
the other two had drifted into a legacy block at the foot. Ids are NOT in date
order and never were: an id is issued when a question is filed and a ruling can
answer it weeks later, so the date on the heading is the only ordering fact.
`fli register:check` grades this file against those rules — an id issued twice, a
citation pointing at nothing, a ruling nobody named, a section out of order — and
CI runs the same engine.

---

## Naming & vocabulary

### <a id="fjs-d203"></a>2026-09-04 · `FJS-D203` — `@@strict` is deleted and `@@noStrict` stays. One word for a boolean whose default is already the answer.

Two words spelled one boolean, and the default was strict either way. The
redundant one was not merely redundant: **nothing read it.** `isStrict()` asks
for `noStrict` and returns true otherwise; the parser returned
`{ kind: 'strict' }` and no consumer ever looked. So the word parsed, was
documented, sat in the catalog, the reference and the tier lists, and changed no
DDL — `FJS-761`'s shape one word along, where `@map` was parsed, documented,
emitted by four importers and applied by nothing.

**Neither word appears in any `.lite` in this repo.** Not `example`, not
`basecamp`, not `cli/db`, `auth` or `junction`. Nothing has been deployed, so
there is no schema in the world to meet and no migration path owed.

**The alternative was one word with an argument** — `@@strict(false)`, the move
made the same day for `@@softDeleteCascade` → `@@softDelete(cascade)`. It loses
on a convention five attributes hold: every boolean argument in this language is
NAMED — `@@log(audit, reads: false)`, `@@arc([…], optional: true)`,
`@@unique([…], nullsDistinct: true)`, `@time(seconds: true)`. A bare positional
`@@strict(false)` would be the first of its kind, so the nicer word costs an
argument shape the language currently agrees not to have. A negative word that
is the only way to say the thing beats a positive word that needs a new grammar
to say it.

**The muscle memory fails loudly**, which is § IV's clause for it: `@@strict` is
an unknown model attribute now and is refused by name at parse, the same answer
every other word the language does not have gets.

### <a id="fjs-d198"></a>2026-09-04 · `FJS-D198` — **Queue** is the noun for a Job's container, and its verbs split into what an app calls and what an operator runs

`FJS-D06` gave the Hook three tiers by asking who may act. This is the same
question one realm over, and it arrives because `caravan-12` listed what a queue
cannot do — pause, resume, drain, purge, rate-limit, cancel work already
running — and every one of those turned out to be the same kind of verb.

**The noun is a regularization, not a coinage.** Job is already
non-negotiable, and a Job runs somewhere; that somewhere is a STRING today,
spelled three times — `queue:` on a handler, `queue:` on a dispatch, and a key
in `queues:`. `QueueConfig`, `QueueWorker`, `ensureQueue` and `queues:` are
already the code's own words. What this adds is that the word is ADDRESSABLE —
`app.jobs.queue(name)` — and that it sits in `ARCHITECT.md` § 2's left column
where a reader will find it.

**The set of Queues is derived and must stay derived.** `queueConf` is built
from the `queues:` option, then from job files, then by `ensureQueue` at runtime
dispatch. No `.lite` keyword, no manifest, no second declaration — and a Queue
handle is a VIEW over that map and never a copy. A copy is the second origin
this file exists to refuse.

**Two verb tiers, and the split decides three arguments at once.**

- **App verbs** — `handle`, `dispatch`, `schedule`. Written in a source file,
  run inside a request, reach a queue by name.
- **Operator verbs** — `pause`, `resume`, `drain`, `purge`, `cancel`, and the
  rate limit. In no source file. They run during an incident, against
  production, from a console.

An operator verb is gated at ADMINISTRATOR or above, it is audited, and it does
not live in a service file. That is not style: `purge()` destroys queued work
and `drain()` blocks, and a verb of that cost reachable at the level that
dispatches a job answers § V's *is the failure mode proportional to the cost of
being wrong* with a no.

**Two states must not be invisible.** A paused queue and an idle queue look
identical from outside, so the pause is carried in `stats()` and rendered by
`fli` and by basecamp. And `queue('typo')` refuses by name, listing what exists:
`ensureQueue` auto-creates, which is right for a dispatch and wrong for an
operator verb, because purging a queue the purge itself created is a green
answer to a question nobody asked.

**Queue is caravan's and no other buffer gets the word.** Junction's
`send-queue.ts`, the transactional outbox and `app.scheduler` all hold work in
order and none of them is a Queue — the same fence `FJS-D36` put around the
clock. A word that means *any buffer* means nothing.

**It does not name the other half.** Bounded work that finishes — a backfill, a
pay run, a deploy — is a different shape with different verbs, and its obvious
word is `Run`, which the cli has already spent on runnables. It stays in
`ARCHITECT.md` § *Not yet named* until a second instance asks for it.

*Lives in:* `ARCHITECT.md` § 2 · `packages/caravan/src/types.ts` ·
`packages/caravan/CLAUDE.md` · [`FJS-711`](ISSUES.md#fjs-711) `caravan-12` ·
`FJS-D06` · `FJS-D36`

### <a id="fjs-d06"></a>2026-08-16 · `FJS-D06` — the coherence-review vocabulary, ruled. Three hook tiers not five, `Provider` is a third party, and `Slice` waits for a second author.

The eight findings of `IDEAS/coherence-review.md` sat open for six
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

### <a id="fjs-d03"></a>2026-08-15 · `FJS-D03` — Context is a per-realm concept. It is plural, it is documented, and it is not unified.

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
runtime behaviors, so `packages/junction/tests/context-contract.test.ts` asserts
all four by running them. Verified by breaking it: three go red against the old
behavior. That is the enforcement that was actually available, and it is what
would have caught a documented contract drifting from its code.


### <a id="fjs-d19"></a>2026-08-15 · `FJS-D19` — Litestone's `Plugin` gets a `name`. The concept is NOT renamed.

Two questions were filed as one and they have opposite answers.

**The name: yes, and it was never cosmetic.** A Litestone plugin had no identity
at all, so nothing could introspect, order, report or name one in an error. It
defaults to the class name — right for every plugin anyone writes, and free —
and a stated `name = '…'` field wins, because a minifier rewrites
`constructor.name` and a bundled app would report `t`. `db.$plugins` lists what
is installed, in run order, on **every flavor of client**: what is installed
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

### <a id="fjs-d02"></a>2026-08-15 · `FJS-D02` — a custom service method is a METHOD. There is no fourth noun.

The realms name three things — Model, Service, Resource — and
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

### <a id="fjs-d29"></a>2026-08-13 · `FJS-D29` — the process a fleet server runs is an OUTPOST, and infrastructure gets place nouns while AI gets personified ones.

Basecamp's
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

### <a id="fjs-d41"></a>2026-08-09 · `FJS-D41` — A pagination control is `.pagination-link`, not `.page`.
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

### <a id="fjs-d40"></a>2026-08-08 · `FJS-D40` — A resource file is named for its noun — PascalCase, singular — one Resource per file.

`App.mesa`, not `apps.mesa`. Repo Invariant 19.

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

### <a id="fjs-d15"></a>2026-08-06 · `FJS-D15` — The email component kit is `@frontierjs/email-kit`.

Fixes `FJS-051`. Not `@frontierjs/mesa-email`. Every other
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

### <a id="fjs-d44"></a>2026-08-06 · `FJS-D44` — `Signal` and `Event` are two words for two things, both legal.
**Signal** is Mesa's reactive cell — the thing `createSignal`/`watchProxy` make and
`$:` tracks. **Event** is Junction's announcement — the thing `publish()` fans out
and a channel carries. `ARCHITECT.md` §2 previously listed *signal* as a banned
synonym for Event, which was written to stop "signal" meaning *notification* and
accidentally outlawed the word Mesa's own runtime and docs use for
its core primitive. The ban is narrowed rather than dropped: **do not call an
Event a signal.** Calling a reactive cell a Signal is correct and required.
They cannot be confused in practice because they live in different realms — a
Signal never crosses a Boundary, an Event only exists to.
*Lives in:* `ARCHITECT.md` §2; `packages/mesa/src/runtime.js`;
`packages/junction/src/transport/channels.ts`.

### <a id="fjs-d45"></a>2026-08-06 · `FJS-D45` — `Policy` keeps exactly one meaning, and it is not "business rule".
A **policy** is a row/field predicate (`@@allow`/`@@deny`) compiled into SQL WHERE.
A **Gate** is the ordinal per-operation level check. Both were already ruled. A
third proposed sense — "declarative business rule, as opposed to imperative
mechanism" — is **refused**: it is the word doing three jobs, and the two existing
senses cost an audit to separate. Where that distinction is wanted, the words are
already there: a **Declaration** is what the schema states, a **Hook** is what runs.
*Lives in:* `ARCHITECT.md` §2 clarifications.

### <a id="fjs-d46"></a>2026-08-06 · `FJS-D46` — `Projection` is adopted for a read model only.
**Status:** withdrawn — the seed language spells it `view`, and a vocabulary row
naming a keyword twice is what § 2 exists to forbid.

A **Projection** was to be a *stored or served* shape derived from the seed for
reading — a materialised view, a serialized subset, a report. What the compiler
derives at build time stays **derived**; what a component computes stays
**derived**. Adopted because the existing vocabulary had no noun for "a second
shape of the same truth, kept in sync", and FJS-005's fix
(`IDEAS/scoped-sql.md`) needed one.

**Withdrawn 2026-09-04, and the reason is not the one it looks like.** The noun
was read as having no referent — zero occurrences in any `src/` or app, alive
only in `ARCHITECT.md` § 2. That reading is wrong in the direction that matters:
litestone ships a **`view`** declaration, with `@@materialized` for the stored
kind and `@@refreshOn` for what refreshes it, parsed in `src/core/parser.js` and
documented in `docs/reference.snapshot.md`. It is this ruling's definition
exactly — stored or served, a second shape, independent existence. So
`Projection` was never an unbound noun; it was a **second name for a keyword that
had already shipped**, which is the one thing § 2's table exists to prevent.

**Binding it was the alternative and it buys nothing.** *A `view` is a
Projection* lets a reader predict nothing they could not predict from the
keyword, and leaves two words where the seed has one — `FJS-D45`'s answer to a
third sense of *policy*, one table row along.

**The premise expired the day it was written.** `FJS-005` closed on 2026-08-06
and closed **without building the design this noun was coined for** — raw SQL
went through `asSystem()` instead, and `IDEAS/scoped-sql.md` still opens *THE
HOLE IS CLOSED. THE DESIGN IS STILL UNBUILT.* A month passed with the noun in the
non-negotiable vocabulary and no artefact able to notice ([`FJS-771`](ISSUES.md#fjs-771)).

`PHILOSOPHY.md` § IV, doctrine against discovery: the doctrine said *new noun*
and the code shipped `view`. Hearing held, code wins.

*Lives in:* `ARCHITECT.md` § 2 (the row is removed) · `IDEAS/declared-semantics.md`
(keeps the argument that wanted it) · `packages/litestone/src/core/parser.js`
(`view`, `@@materialized`, `@@refreshOn`) · `FJS-005`

### <a id="fjs-d42"></a>2026-08-01 · `FJS-D42` — Model names are PascalCase and singular, always.
`model Lead` → accessor `db.lead`; `model PageView` → `db.pageView`. The accessor
rule derives the API from the model name, so mixed conventions produced three
spellings of one model across packages. Exception: `@@external` models mirror a
foreign physical table and keep its name verbatim.
*Lives in:* all examples/docs in `packages/litestone`; enforce in scaffolds and reviews.

### <a id="fjs-d43"></a>2026-08-01 · `FJS-D43` — Named gate syntax is canonical; digits are the compact form.
`@@gate(read: READER, write: USER, delete: OWNER)` in all docs and new schemas;
`@@gate("2.4.4.6")` remains valid shorthand. `write:` expands to
create+update+delete unless one is given explicitly; missing keys cascade
read→create→update→delete, read defaults to STRANGER.
*Lives in:* `packages/litestone/docs/access-control.md`, parser `parseGateArg()`.

## Access control

### <a id="fjs-d221"></a>2026-09-05 · `FJS-D221` — a row policy may name a column ONE relation away, written as a path. Two hops is a parse error.

`@@allow('read', order.userId == auth().id)` is `Expected RPAREN, got '.'`. A
policy compares columns on its own model against `auth()`, and `@from` crosses a
relation only to aggregate — so *the lines of my own orders* has nowhere to live
but a copy. `example` carries the same id on `Customer`, `Order` and
`OrderLine`, written in one transaction by `carts.checkout`, and that transaction
is the whole of what keeps three columns saying the same thing
([`FJS-499`](ISSUES.md#fjs-499)).

**This is Axiom 1 with the sign flipped.** The denormalised column is a second
origin for one fact. Nothing declares the two are the same fact, nothing fails
when they diverge, and the failure when they do is a row readable by the wrong
person — which is the quietest possible failure, because a policy that admits
too much looks exactly like a policy doing its job. The relation's key is known
at compile time, so the join is DERIVABLE and the copy is a restatement.

**§IV, the paved road against the workaround.** One developer leaving the road is
an edge case; the same workaround in the same place over and over is a
measurement of the road. Three copies in one application, and the shape is the
default case rather than an exotic one — an invoice line, a comment on a post, a
message in a thread. Either the road changes or the reason it does not is
written down. It changes.

**Dotted, not `exists()`.** `order.userId` reads as what it means and matches
`@from`, which already crosses a relation by naming it. `exists(order, …)` is
honest about the subquery and buys that honesty by making the common case look
like a subquery — and the uncommon case it would enable, *any child matches*, is
not being ruled here and should not be pre-paid for with syntax.

**One hop, and the second hop is a parse error rather than a slow query.** One
hop covers every case that motivated this. Transitive is N joins the author
cannot see, per policy, per query — and a policy that is slow is a policy an app
routes around, which is how the workaround comes back wearing a service method.
`a.b.c` is refused at parse time naming the rule, so the bound is discoverable
from the mistake rather than from this file.

**The compiler owns the join and an application may not hand-write it.** The
whole gain is one origin; a service where-clause that reproduces the correlation
is the second owner arriving by another door.

**`x-gate` answers `unknown` for a model carrying a crossed policy**, and that is
safe rather than a gap. Invariant 6 already rules a client-side gate an
affordance whose unknown answers are permissive and whose server enforces
regardless, so the screen may offer an action the boundary then refuses — the
same contract every policy already has, since a row policy has never been
answerable on the client. What must not happen is `canAtLevel` inventing a
confident answer from the child's own columns, which would be wrong precisely
when the parent is what decides.

**The cost that can be wrong in silence is the query plan.** A correlated
subquery per row is invisible in every behavioral test, which all pass against a
policy that scans. The artefact is the query tap plus an EXPLAIN assertion over
a table sized past the point SQLite is right to scan — the shape
`test/index-predicates.test.ts` already uses, and the reason it exists.

*Lives in:* `packages/litestone/src/core/parser.js` (the path form and the
two-hop refusal) · `packages/litestone/src/core/policy.js` (`check(rel, 'read')`
already compiles a target's policy as a correlated subquery) ·
`packages/litestone/src/core/schema-maps.js` (`subquerySql`, which already
correlates on every column of a composite key) ·
`packages/sierra/src/junction/resource.js` (`buildGate` / `canAtLevel`) ·
Invariant 6 · [`FJS-499`](ISSUES.md#fjs-499) is the implementation


### <a id="fjs-d205"></a>2026-09-04 · `FJS-D205` — a field's read protection is TWO axes AND'd. `@guarded` says who may see it, `@omit` says whether it is in the default payload, and neither swallows the other.

`applyFieldPolicyTo` decided both questions in one `if/else` ladder, first match
wins, in an order nothing stated: `@hashed`, `@encrypted`, `@guarded`, `@omit`,
field `@allow('read')`. So `both Int? @guarded @omit(all)` parsed with no
complaint and came back to `asSystem()` in a plain read — `@omit(all)` says it
must be asked for, and the branch that would have applied it was unreachable
(`FJS-827`). `@encrypted @omit` had the same defect one word along, and
`@encrypted` also swallowed a field `@allow('read')`. **`@guarded` + `@allow`
was the one combination already refused**, at parse time since before this, so
that half of the ladder was dead by construction rather than by accident.

The two questions are genuinely two:

- **visibility** — may this caller see the column at all. `@hashed` (nobody,
  `asSystem()` included), `@encrypted` and `@guarded` (system context only), a
  field `@allow('read', …)` (a predicate). **Strictest wins and nothing here
  widens**, so `@allow` may only narrow — an admin does not reach an
  `@encrypted` column by predicate.
- **inclusion** — is it in the default payload. `@omit` (out of lists),
  `@omit(all)` (out of everything). **Naming the column in `select` unlocks
  this axis and only this one.**

Strip if either says no. The ladder is two small blocks and the cross-product
stops being enumerated.

**This is a `PHILOSOPHY.md` § IV *doctrine vs. discovery* hearing decided
against the code.** The ladder could be read as smarter than the principle — a
guarded column is already hidden, so an `@omit` beside it is moot. Three
exhibits say accidental: `guarded === 'all'` and `guarded === 'select'` were two
branches with one body, so the ladder was written as though the argument
mattered and it never did; the function's own header described the modes as
independent axes; and nobody would state *`asSystem()` gets the omitted column
back* as intent.

**It does not implement `@guarded(select)`.** A lock a caller picks by asking
more specifically is not a lock, so select-unlock lives on `@omit` and only
there. The dead argument stays open as `FJS-827`, now narrowed to that.

**Blast radius, measured: zero.** No `.lite` in this repo pairs `@guarded` or
`@encrypted` with `@omit`, and `@guarded` + `@allow` does not parse.
`test/field-policy-compose.test.ts` is the artefact — every pair asserted beside
each of its halves alone, because a strip that refused everything and a strip
that composed are indistinguishable from the refused side. Four of its eight
rows fail against the ladder.

### <a id="fjs-d204"></a>2026-09-04 · `FJS-D204` — the browser gets the whole `$defs` table and none of the schema's PROSE. A doc comment is not an affordance.

`FJS-785` measured what an anonymous visitor downloads before signing in to
`example`: the entire `.lite` document as JSON, 39 models with their column
lists and their per-operation gate levels, and every `///` comment in the file
as a `description` — comments which in this repo quote policy expressions,
explain the cart bearer-token scheme and name an internal rotate URL.

Two different things were in that payload and they have opposite answers.

**The prose goes, at every depth.** A `///` comment addresses whoever edits the
schema. Nothing in a browser reads it — `field-rules.js` carries `description`
into a field rule and no control renders it — so it was shipping to no purpose
at all, and what it says is written for a reader who already has the source. It
is also the LARGE half rather than the cheap one, which is the opposite of how
the finding ranked it: of 117.6 KB / 29.7 KB gzipped, the prose is 64 KB and
**23 KB of the gzip**. On `example`'s minified entry chunk that is 262.2 KB /
79.5 KB down to 194.9 KB / 56.2 KB — 29% of everything the app ships, gone,
with no feature behind it.

**The table stays whole, and the projection is refused.** The obvious companion
fix is to ship only the models the UI reaches — the ones a `createResource` or a
route or a `src/resources/` file names, plus their relations. It fails five of
§ V's nine questions and the eighth decisively: a build-time scan is a second
and weaker statement of *which models this app uses*, the app's own runtime code
being the first, and where the scan is wrong the app renders **an empty form on
a green build** (`FJS-264`'s degradation shape). It cannot be made loud, because
the miss happens at a runtime `createResource` the build never saw. It would
make `createResource`'s own diagnostic lie — *Known models: …* would list the
projection rather than the schema. It would put two answers to *what models
exist* in one package, since `static-safety.js` installs the full table at build
time (Invariant 4). And § IV settles the escape it needs: a `schema: { include }`
key *"widens the shoulder and records nothing"*, and nobody has yet reported the
bundle. After the prose is gone it is arguing over 6.7 KB gzipped.

**What is left is shape, and shape is already ruled.** Invariant 6 blesses
`x-gate` on the client as an affordance the server enforces regardless, and
litestone's `audience: 'client'` is the one owner of which FIELDS may cross — it
is doing its job, and `@guarded`/`@secret` were correctly absent throughout. It
was never asked about a doc comment, because a comment is not a field.

**The strip is Sierra's, not litestone's, and that is not a second owner.** The
client audience describes what an API may answer an authenticated caller on
request. This bundle is a static file anyone can fetch before signing in, which
is strictly narrower — the same question `static-safety.js` already owns for a
prerendered page, and it is owned in the same package for the same reason.

**It stands with `FJS-553`/`FJS-554`, which want MORE.** Sortability and
filterability are structural, per-column and tiny, and a projection would have
fought them twice: a generated table reaches a related model that no
`createResource` names, which is the hop a scanner is worst at. Removing a key
nothing reads and adding two that a generator needs are the same direction.

**An app that wants a hint on a form declares one.** Repurposing a doc comment
is how the prose got there; a user-facing string is an attribute somebody wrote
on purpose, and the day one is wanted it arrives as a keyword of its own rather
than as whatever the schema author happened to type above the column.

**The build now prints what it costs** — model count and the emitted size, raw
and gzipped, on every build. A refusal that hides its own price is the shape
that gets quietly reversed, and this one took an audit to find.

*Lives in:* Invariant 6 · `packages/sierra/src/build/schema-plugin.js`
(`stripProse`, `emittedSize`) · `packages/sierra/tests/schema-prose.test.js` ·
[`FJS-785`](ISSUES.md#fjs-785) · [`FJS-553`](ISSUES.md#fjs-553) ·
[`FJS-554`](ISSUES.md#fjs-554) · [`FJS-264`](ISSUES.md#fjs-264)

### <a id="fjs-d197"></a>2026-09-04 · `FJS-D197` — the ladder is one kit. The scale, the comparison AND the grader, because the grader is the half that drifted.

The gate scale was a hand copy at four places across a boundary that forbids the
import. Litestone ENFORCES a `@@gate`, Junction grades the caller it hands over,
Sierra renders a screen from the same numbers in plain Node with no client
import at all, and Invariant 1 runs `Litestone ← Junction ← Sierra`, so two of
the three cannot ask the one that owns it. Each copy carried a comment saying
*change one, change both*.

**They drifted, and the measurement is the argument for what goes in the kit.**
Over the 216 combinations of the fields a session carries:

| pair | disagreed on |
| --- | --- |
| Litestone's `FrontierGateGetLevel` vs Junction's `sessionGateLevel` | 8 — all one branch, a signed-in caller with no `role` |
| Either of those vs `GatePlugin`'s own constructor fallback | 212 — it read nothing but *is there a user*, so it graded an `isSystemAdmin` caller USER(4) |

So the same `@@gate("4")` read was a 403 or a 200 depending on which resolver an
app had installed — and which one that is was not obvious, since a schema
declaring any `@@gate` auto-installs Litestone's rather than Junction's.

**A numbers-only kit would not have caught either.** `levelPasses` never drifted
and Sierra's `>=` differs from it only at 8 and 9, which no resolver can emit
today. The grader is where the divergence was, so `gradeStanding` is in the kit
and that is the whole of the answer to `FJS-D184`'s second question.

**`role` is read for PRESENCE and no role is CREATOR(3).** The ladder cannot
rank what is IN an app-defined column — `role: 'guest'` and `role: 'admin'` are
both a role — so what it can see is whether the app gave this caller one, and a
caller with none may submit and not manage. `@frontierjs/auth`'s `User` ships
`role String @default("user")`, so a stock app grades USER(4) and this branch is
reached by a session some other path built. Note that it is the one field read
for presence: `verifiedAt` and `activatedAt` separate `undefined` (not modeled)
from `null` (modeled, not reached), and getting that backwards makes every
caller of a simpler app a stranger.

**The bare `GatePlugin()` fallback is deleted rather than aligned.** A default
that reads one field is not a lenient grader, it is a second ladder with one
rung, and it was reachable by anyone constructing the plugin without a resolver.
The default is now the shipped grader.

**No warning when an app installs its own.** `FJS-D184` asked. `example`,
`basecamp` and Sierra's own example each install one, so a warning would fire on
every real app — and mapping an app's roles onto the scale is the supported
extension point, not a mistake. One definition removes the thing a warning would
have been watching for.

**What the tripwire teaches is why the kit's spec is exhaustive.** A test named
*agrees with junction sessionGateLevel* existed, in Litestone, and imported only
Litestone: it asserted its own function against a literal, over a fixture
carrying `role` — the one field whose ABSENCE is the disagreement. It passed
under both graders and could not have failed. The kit's spec walks the whole 216
and the whole 0–9 × 0–9 square instead, which costs nothing for a pure function
of two small domains and is the only shape that could have caught this.

`expectedVerdict` in `access.js` stays independent and says at its own
declaration why: it is the oracle an exhaustive test grades `levelPasses`
against, and an oracle that calls the thing it grades cannot fail.

*Lives in:* `packages/toolbelt/src/gate/gate.js` (`LEVELS`, `LEVEL_NAMES`,
`levelPasses`, `gradeStanding`) · `packages/litestone/src/plugins/gate.js` and
`src/core/parser.js` · `packages/junction/src/core/litestone.ts` ·
`packages/sierra/src/junction/field-rules.js`. Closes [`FJS-520`](ISSUES.md#fjs-520).

### <a id="fjs-d183"></a>2026-09-03 · `FJS-D183` — the envelope names the KEY. A rotation is resumable because every value says which key wrote it, and the old key stays readable rather than being dropped.

`v1.` encoded the FORMAT version — the one thing about a stored value that never
changes — and left out the one that does. `$rotateKey` runs **one transaction
per database**, so a crash between two commits leaves database A on the new key
and B on the old under a single global key setting, with nothing able to say
which value is under which, no old-key decrypt window, and no way to find the
rows still to do (`FJS-714`).

**`v2.<kid>.<payload>`**, where the kid is a domain-separated HMAC of the key
truncated to eight hex characters. It identifies a key without being one, which
is what makes it safe in a column, in a log line and in an error message. It is
not a collision-resistant identifier and is not used as one: an unknown kid
still tries every key on the ring, because **GCM's tag is the authority and a
kid is only the order**. What the kid buys is the right key first, and a
resumable rotation — *which rows are still on the old kid* is a question that
could not previously be asked.

**`previousEncryptionKeys` is read-only and the ring is what a READ asks.** The
current key stays the only thing a write uses. After a rotation the old key
**stays on the ring** rather than being dropped, which is the whole of what
makes a partial rotation survivable, and re-running the rotation finishes it: a
row already on the new kid decrypts, re-encrypts to the same kid, and costs a
write rather than a wrong answer.

**Two consequences the finding did not name, and measuring is what found both.**

A deterministic encoding is a **function of the key**, so an operand encoded
under the current one does not equal the same value stored under a previous one.
Making a half-rotated schema *supported* would therefore have created a new
silent failure: every equality filter over a not-yet-rotated row answering
nothing, with no error, in exactly the state this feature exists to make safe.
The operand is widened across the whole ring, at all four spellings of equality
(`equals` and a bare scalar become `in`; `not` becomes `notIn`).

And the payload is **byte-identical across envelope versions** — same key, same
derivation, same digest — so a value written before this change reads
`v1d.<p>` where the operand now encodes `v2d.<kid>.<p>`, and equality compares
the whole stored string. Every deterministic and every `@hashed` lookup **in
every existing app** would have stopped matching on the first query after the
upgrade, silently. **No suite in this package could see it, because every one
of them builds a fresh database** — `FJS-251`'s shape, one subsystem over — so
`legacyForm` emits the v1 twin beside each encoding and a simulated pre-upgrade
database is a written test.

**A stored value that cannot be decrypted is raised, not blanked** (`FJS-716`),
with one exception that the schema declares: `@secret(rotate: false)` is an
acknowledged loss `$rotateKey` makes the caller name, so raising there would
make the whole row unreadable to punish a column the app already gave up. That
exception is read off the declaration rather than configured, so there is no
knob. The ring also moved WHEN the loss lands: an orphaned column stays readable
while the process holds the old key and is lost at the next start, which the
refusal now says.

**And a caller may not send a value that merely looks encrypted** (`FJS-715`).
The mode must match the column's protection, the value must actually verify, and
a non-system caller is refused by name — a caller never legitimately holds
ciphertext, since a non-system read strips or decrypts.

*Lives in:* `packages/litestone/src/core/encryption.js` (`keyId`,
`parseEnvelope`, `makeKeyring`, `verifiesAs`, `legacyForm`) ·
`src/core/client.js` (the ring, the write guard, the widened operand,
`$rotateKey`) · `test/key-rotation.test.ts` · `FJS-714` · `FJS-715` ·
`FJS-716` · closes `F18` of the foundation audit

### <a id="fjs-d182"></a>2026-09-02 · `FJS-D182` — a bulk write refuses the transitions KEY, not the verb. `FJS-044`'s power tool survives for every other column.

`updateMany` matches rows with a WHERE and never reads them, so there is no
`from` state to grade — and the skip took the whole state machine with it, not
just the from-check. Measured, one level-4 caller holding no capability: a
`@gate(5)` move refused through `update()` and **allowed** through `updateMany`;
a `@system` move refused and **allowed**; a move the schema does not declare,
**allowed** (`FJS-671`).

**What the precedent actually said matters, and the audit had it backwards.**
`FJS-044` did not rule the skip acceptable. It fixed it one layer up: junction's
`bulkByRow` selects its targets and writes them one at a time through
`update()`, so a filtered `PATCH` over HTTP has enforced transitions since
2026-08-14 and still does. What was reachable is a hand-written service, job or
script calling `db.model.updateMany` with a payload a caller supplied — a
narrower path than *any API caller*, and a real one.

**Two things arrived after that fix and neither could have been weighed by it.**
The capability grid, which charges a transitions-field key to *the check where
the transition is* — a check this verb does not run. And
`access.snapshot.md`, which is the artefact a reviewer grades an access change
with: it stated *a move a caller may not make is refused even where `@@gate`
allows the update* and printed `application` and `5 ADMINISTRATOR` with no
per-verb qualification. **A committed artefact certifying enforcement one verb
does not apply is worse than the hole**, because it is what somebody reads
instead of the code.

**The ruling is that one KEY is refused rather than the tool removed.**
`BulkTransitionError`, **400** — not 403, and the difference is the whole
distinction: no level answers it and no grant answers it, because the verb is
wrong rather than the caller. `upsertMany`'s `update:` half is the same
ungraded write and refuses with it; its insert half is a create, which has no
from-state, and does not. Every other column on the model stays bulk-writable
in the same call, which is `FJS-044`'s reasoning kept rather than overturned:
`updateMany` is still a power tool, for the columns a power tool can be trusted
with.

**The rejected alternatives.** *Enforce per row off `RETURNING`* — reading every
row back is no longer a bulk write, so it answers the hole by removing the
feature under a name that says it kept it. *Document the exemption* — the
snapshot states it and `_checkUpdate` demands the `Model.update` capability —
leaves the escalation reachable and makes the artefact honest about a hole
instead of closing it, which is the shape this repo files as a defect rather
than shipping.

**`asSystem()` still writes it, and now says so.** A system client means no
rules and a bulk backfill of a status column is exactly what it is for. But
`update()` announces its own bypass through `emitTransitionEvent`, which a bulk
write never reaches — so without a warning of its own the system path would have
been the one silent bypass of the two.

*Lives in:* `packages/litestone/src/core/errors.js` (`BulkTransitionError`) ·
`src/core/client.js` (`_bulkTransitionField`, `updateMany`, `upsertMany`) ·
`src/access.js` (the per-verb sentence) · `test/bulk-transitions.test.ts` ·
`FJS-671` · closes `F16` of the foundation audit

### <a id="fjs-d181"></a>2026-09-02 · `FJS-D181` — a claim is DECLARED, and the declaration is a client option rather than a `.lite` keyword. The eight names this package itself reads are the framework's and no app spells them.

Every identifier on the ROW side of a policy is refused by name at startup —
`@@allow('read', ownerIdd == 1)` names the model, the expression and the columns
it could have meant. The identifier on the AUTH side of the same comparison was
resolved against nothing, ever, and the cost is not a wrong answer but two
opposite ones: `NOT (NULL = 1)` excludes every caller and `null === true`
excludes none, so one misspelling is a lockout on read and an open door on
create, and the side that refused reads exactly like a policy doing its job
(`FJS-666`).

**What a claim can be has four sources and there is no fifth.**

**The eight the framework fixes.** `id`, because `auth()` bare IS the id, and
`capabilities`, because the grid reads it (`FJS-D151`) — plus the ones
`FrontierGateGetLevel` grades a caller by. `FRAMEWORK_CLAIMS` in
`src/core/policy.js` is the list; naming them again here would make a third copy
of a set that already has two. **A standing is not a
column** — `example`'s ladder tops out at `isAdmin` and its `User` has no such
field, because auth puts it on the session — so deriving the set from the model
alone would refuse the most common predicate an app writes.

**The `@@auth` model's own columns**, which is what `sessionFields` carries.

**The `tenancy { claim }`**, the one claim the schema itself declares.

**And `claims: [...]` at `createClient`**, for a value resolved PER REQUEST: a
cart token, an impersonation. It is on no row and in no schema, so nothing can
derive it, and it is the reason this is a client option and not a `.lite`
keyword. The alternative — a `claims { }` block beside `tenancy { }` — would put
the list in a second file, and **junction already declares it**: a `principal:`
resolver carries a `describe()` and `principal.snapshot.md` § Claims is
generated from it. One place has the names; a keyword would make two, and the
one that goes stale is the one nothing executes.

**It grades only when there is a set.** A schema declaring no `@@auth` and an
app passing no `claims` have said nothing to compare against. Inventing a floor
there would refuse `auth().isStaff` on every app in the world, so the check is
silent — and that silence is **announced once per distinct set of names**, which
is the difference between a stated degradation and a check that quietly does not
run. `claims: []` is a statement (the framework's eight and nothing else) where
absent is silence, so the empty array is deliberately not falsy.

**The rejected alternative was inference.** A claim's only appearance is inside
the policy that names it, so a set derived from usage contains the typo — the
one shape that cannot work, and the reason `@@auth` had to become something an
app declares. Both apps here adopted it, which is what makes the check live
where the bug was.

*Lives in:* `packages/litestone/src/core/policy.js` (`buildClaimSet`,
`checkExpr`, `authClaimsUsed`) · `src/core/client.js` (the option and the
notice) · `test/auth-claims.test.ts` · `FJS-666` · `FJS-667` · `FJS-668`

### <a id="fjs-d150"></a>2026-08-26 · `FJS-D150` — a move can say the APPLICATION makes it, with `@system`, and the escape is the column's own. `@gate(8)` keeps meaning *asSystem() and nothing else*.

`FJS-506` ruled what `@gate(8)` means on a move — `asSystem()` and nothing else,
`getLevel` clamped to 7 so SYSADMIN is refused by name — and drew a filter from
it: *every move not at 8 is one a person can make*, the only mechanical way to
derive a capability set from a state machine. Adopting it in basecamp found the
counterexample immediately, and it is not rare.

**A move can be the engine's decision and a person's request at the same time.**
`Server.reportRunning` and its three siblings are reached by somebody pressing
*Sync from provider*: basecamp asks the provider, and the provider's answer picks
the move. The decision is the engine's; the request is a person's, and the write
is on their scoped client. At `@gate(8)` every one of them refuses. The only way
past was `asSystem()`, which drops the gate, the row policies **and the audit
actor** to make one move — the trade `FJS-384` refused once already.

**The word already existed one level down.** `@system` on a COLUMN means the
application writes it and its caller does not, and `system: ['col']` on the write
is the application saying it is the one writing — keeping every other rule
(`FJS-D22`). A move is a write to exactly one column, so the same statement and
the same hatch apply unchanged:

```
@@transitions(status,
  drain:         online                    -> draining @gate(5),
  checkIn:       [pending, unreachable]     -> online   @system,
  reportStopped: [pending, online]          -> stopped  @system @gate(5))
```
```js
await db.server.transition(id, 'reportStopped', { system: true })
```

**Two attributes, two questions, and they compose.** `@gate(N)` is *how senior
must a caller be*; `@system` is *whose decision is this*. `@system @gate(5)` is
the person-requested engine move — the engine decides, an administrator asks —
and it is the shape the counterexample needed. `@system` with `@gate(8)` or
`@gate(9)` is refused at parse: those are sentinels meaning *no caller reaches
this*, which is the opposite of what `@system` says, and a move declaring both
has two answers to one question.

**The hatch is the column's, not a second one.** `{ system: true }` on
`transition()` becomes `system: [field]` on the update underneath, so writing the
column directly — `update({ data: { status } })` — is refused and permitted by
exactly the same rule. Two spellings of one move (`fli check`'s
`transition-methods` already treats them as one), so a rule enforced on only the
named one is not enforced at all.

**It is a third refusal and screens must tell it from the second.**
`TransitionSystemError`, 403, not retryable, beside `TransitionGateError`'s 403.
Separate class because the remedies differ in kind: a gate refusal is answered by
being more senior, and this one cannot be answered by any caller at any level. A
screen that renders them alike tells somebody to go and find an administrator who
also cannot do it. `transitions(row)` reports `refusedBy: 'system' | 'gate' |
'policy' | null` (`FJS-495` added the last two), and `system` is asked FIRST
because it is the cheapest — no level to resolve, no policy to evaluate.

**On the client it is the one verdict that is not a guess.** `x-transitions`
carries `system` beside `gate`, and sierra's `transitionsAt` reads it. Everything
else there is permissive-when-unknown, because a gate is an affordance and a
policy is invisible from a browser — but a browser is never the application, so
`@system` is decidable there with certainty. A screen renders no button rather
than a disabled one.

**What it recovered in basecamp**: `Server.checkIn` was declared `@gate(8)` and
**the machine never ran**. The heartbeat writes `status` as one column of one
update — splitting it out would write and announce the row twice for a single
check-in — so it wrote the value by hand against a `CHECK_IN_FROM` set kept in
the service, under a comment admitting the two had to agree. That is the
duplication `@@transitions` exists to delete, kept only because the declaration
could not be satisfied. The set is gone; the from-state is asked of the schema.

*Lives in:* `packages/litestone/src/core/parser.js` (`parseTransitionsArg`),
`src/core/client.js` (`checkTransitions`, `transition`, `transitions`,
`TransitionSystemError`), `src/jsonschema.js`;
`packages/sierra/src/junction/field-rules.js` (`transitionsAt`); adopted in
`packages/basecamp/db/schema.lite` (`Server`) and
`api/src/services/servers/servers.service.ts`. Reference:
`packages/litestone/docs/schema.md` § `@@transitions`.

### <a id="fjs-d151"></a>2026-08-26 · `FJS-D151` — the caller's set is `auth().capabilities`.

Named because nothing named it. `FJS-D139` settled what a capability IS and
`FJS-D147` settled how a column holds one, and neither said what the claim on the
principal is called — the record carries `auth().perms` twelve times, every one of
them from the probe that predates the vocabulary those two rulings fixed.

It is not a cosmetic gap. The claim is what enforcement reads, what every
application's principal resolver writes, and what a role expansion produces; a
second spelling appearing later is a rename across app code rather than a schema
edit. `perms` is also an abbreviation of a word this design deliberately stopped
using — a *permission* named a thing in a list, and `FJS-D139` replaced that with a
reference to something the seed declares.

So: **`auth().capabilities`**, a flat list, resolved onto the principal at the same
seam a per-request standing is (`FJS-D113`) and per tenant (`FJS-D149`). Measured
cheap before being ruled: basecamp's standing already comes off
`ctx.locals[MEMBERSHIP]`, resolved once per request, so a union across several role
assignments is a join at that seam rather than a per-write cost.

### <a id="fjs-d141"></a>2026-08-25 · `FJS-D141` — a null tenant column means the row belongs to NO tenant, and belonging to nobody is readable through `asSystem()` alone. A row meant to be shared says so with `@@tenant(none)`, which is a declaration rather than an absent value.

`FJS-432` asked what basecamp's `AuditEvent.workspaceId String?` means, and the
schema and the framework had different answers written down. The model declares
`@@tenant(none)` with a header arguing that scoping it "would make exactly the
rows with no workspace invisible rather than global" — so *null is global* — and
`FJS-D05`'s desugar says the opposite in one line: **on a read a row holding no
tenant belongs to nobody and stays invisible.**

**The framework's answer stands, and it is the one measured.** A schema
declaring `tenancy { strategy row  column workspaceId }` over a nullable column,
three rows and two tenants:

```
tenant A sees: [ "a-row" ]        // the null row is not in it
system sees:   3
```

**Null is not a way of saying *everyone*.** The argument is not about SQL: it is
that *global* and *the stamp did not land* are the same absent value, so a
column where null means global cannot tell a shared row from a leak. Basecamp is
the demonstration — 19 null `AuditEvent` rows, of which 6 were hub actions that
genuinely belong to no workspace and **12 were `jobs.startRun` / `jobs.finishRun`
losing their stamp**, on a `Job` whose own `workspaceId` is required and
present. Under *null means global* those twelve are a feature. Under this
ruling they are a defect, which is what they are.

**Sharing is declared on the MODEL, never inferred from a row.** `@@tenant(none)`
says every row of this model spans tenants and is checked at parse; a nullable
claim column says one row has no owner and is checked by nothing. A table
holding both kinds — some rows a tenant's, some rows everyone's — is two models
wearing one name, and the second one is a catalogue: basecamp's `Blueprint`
carries no column at all for exactly this reason and says so at its declaration.

**The delegated spelling answers the other way, deliberately, and that is now
stated rather than discovered.** `@@tenant(via: rel)` over an optional relation
compiles to `check(rel)`, which `FJS-382` ruled `FK IS NULL OR EXISTS (…)` — so
a child with no parent is visible to **every** tenant:

```
tenant A sees: [ "a-note", "orphan-note" ]
```

Two spellings, opposite answers about the same absent value. Both are
defensible on their own terms — a column is the row's own claim, where a null
relation is a row that has not been filed yet — and `verifyTenantIsolation`
already reports the delegated case as `unparented` rather than grading it, which
is the honest position for something nobody had settled. **Not reversed here.**
Reversing it is a behavior change with two tests pinning the current answer and
nothing waiting on it; filed as `FJS-528` so the next person meets the
disagreement in the register instead of in a query.

**What it costs basecamp**: `AuditEvent` drops `@@tenant(none)` and takes the
declared tenancy, so the trail is scoped at the Data boundary rather than by one
service's `where` — visible in `db/access.snapshot.md`, where a hook is not. The
six hub rows stay readable by the hub, which already reads through `asSystem()`.
The stamp is fixed **first**: sealing the meaning in while twelve rows are
mis-stamped would hide them from the workspace that owns them, permanently and
with a green suite.

*Lives in:* `packages/litestone/docs/multi-tenancy.md` § What it desugars into;
`packages/litestone/src/core/parser.js` (`expandTenancy`); tests in
`packages/litestone/test/tenancy.test.ts` and `test/tenancy-delegation.test.ts`;
applied in `packages/basecamp/db/schema.lite` (`AuditEvent`) and
`packages/basecamp/api/src/core/hooks.ts` (`basecampAuditLog`).

### <a id="fjs-d148"></a>2026-08-25 · `FJS-D148` — a derived reference set needs two things around it: a way to be ASKED, and a way to be MOVED. `$capabilitiesFor` is the first, a data migration is the second.

**Asking. `db.$capabilitiesFor(principal)` on every flavor of client**, the shape
`$checkWhere`, `$checkOrderBy` and `$protectedFields` already have — a question asked
of the client rather than reimplemented per caller. A CLI (`litestone access --for
<user>`) is a caller of it, not a second implementation, because a role editor and a
support screen both need the answer live and a command cannot be called from a screen.

**It is two questions and only one of them is answerable this way**, which is the
trap worth naming. *What can Ada do in workspace X* is a live query over her
assignments. *What could Ada do in March* **cannot be recomputed** — the roles have
changed since — so any implementation that answers the first and looks like it
answers the second is wrong in the silent direction. The second is only answerable by
recording the effective set **at the moment of the decision**, into the audit trail.
That belongs to `IDEAS/compliance-from-the-seed.md` rather than here: it is a fact
about what the trail must carry, not about what a capability is.

**No snapshot section.** `access.snapshot.md` grades the DECLARED surface and this
depends on rows, which is exactly why it has no committed home. Only the join shape
is static, and the join shape is not the question anybody asks.

**Moving. A rename emits a data migration**, because `FJS-D139` made the capability a
reference and therefore made renaming its referent a rename of the capability. The
old string sits in every `Role.capabilities` array in every tenant's database, so the
rewrite is a data change. What D139 bought is that the blast radius is **computable**
rather than guessed, so the generator has something to generate from.

**Amended 2026-08-26 on measuring it: it is computable from two SCHEMAS and not from
two databases, so it is not `diffSchemas`/`autoMigrate`.** That sentence was written
expecting the rewrite to fall out of the migration engine, and for a renamed COLUMN it
would — but a renamed MOVE changes the capability set and emits **byte-identical DDL**,
and the engine diffs a replayed shadow database against a pristine one, so it reports
*no migration needed* while every grant row holding the old name goes quiet. Moves are
where most capabilities come from. `capabilityDrift(before, after)` therefore rides the
`--from <ref>` comparison, which reads two `.lite` files, and `litestone access --from`
prints the rewrite. **It pairs only where the pairing is forced** — a model whose whole
prefix moved with its target set intact, or a single loss against a single gain on one
model — because a lost name and a gained name are a rename in the author's head and a
coincidence in the data; anything else is reported unpaired with no SQL, since a wrong
rewrite hands one role another's authority and looks exactly like it worked.

Two alternatives were weighed and both refused. **An alias** — `@@renamed("Server.reboot")`
on the move, old string keeps resolving — needs no migration and accumulates in the
schema forever, and two names resolving to one capability weakens the *a typo cannot
exist* property D139 was chosen for. **Refuse-the-rename-while-rows-hold-it** is a
correct fail-closed stopgap and is not shipped: it cannot reach a tenant fleet you do
not own, and the generator lands with this ruling, so it would be a stopgap with
nothing to stop.

### <a id="fjs-d149"></a>2026-08-25 · `FJS-D149` — a non-CRUD action earns a capability by being a MOVE, and a capability is always per tenant.

Two questions about what is in the set and whose it is.

**A method that changes state is a transition, and that is where its capability
lives.** `orders.pay` calling `db.order.update()` is covered by `Order.update` and
cannot be told apart from correcting a typo in the note — which is the complaint the
grid exists to answer. The answer is not a new binding site: it is
`@@transitions(status, pay: pending -> paid)`, which names the move in the seed and
therefore gives `Order.pay` a referent under `FJS-D139`. This is already the repo's
practice and `example` states it at the declaration — *the four moves take an id and
nothing else, and a move's rules are in `@@transitions` where every other rule about
this row lives.*

**`methods: [{ method: 'pay', capability: 'Order.pay' }]` is refused**, and it is
refused because it is the most natural-looking answer: it mints a capability name in
a service file, and `FJS-D139` rules that a capability is a reference to something
**the seed** declares. A service names which rule applies; it never carries one.

**`@@actions(pay, refund)` is the named escape** for an action that genuinely is not
a move — no state column, nothing to transition. It is the `input:` shape one level
over: the seed owns what the thing is, the service names which one applies. Most
candidates for it turn out to write a row, which makes them transitions after all,
so it exists rather than being reached for.

**And a capability is per tenant. No claim, empty set.** Cross-tenant standing is the
**gate's** job — `isSystemAdmin` grading SYSADMIN(7) above any membership is what
basecamp already does — and because `FJS-D146` ANDs the two, a global capability was
never needed for the case that motivates one. A second global set would be a second
seam to resolve, to audit and to render, buying a tier the ladder already has.

The division that falls out: **the ladder carries standing that crosses tenants, the
grid carries authority within one.** Confirm rather than assume is still owed — a
probe that the claim seam resolves per request per tenant and caches nothing across
them.

### <a id="fjs-d146"></a>2026-08-25 · `FJS-D146` — a model that opts into capabilities still applies its `@@gate`. Both, ANDed, and the gate is the floor.

The three answers were AND, OR, and exclusive-per-model, and the argument against
AND was Invariant 4: a model graded on two axes has two owners of one refusal.

**AND wins because the two axes answer different questions and only one of them can
be asked at a bootstrap.** Sorted by what each layer can *see*, the division is not a
duplication:

| Layer | Sees | Therefore |
| --- | --- | --- |
| `@@gate` | the session. Reads nothing | the only layer usable before anything is read |
| capability | a flat list on the principal. Reads nothing | may refuse safely — verb-scoped, leaks nothing |
| `@@allow` | the row. Costs the query | must filter; refusing would leak |

OR makes the gate a bypass — hold the capability and the ladder stops applying, which
turns *anonymous* into a caller with a grant. Exclusive-per-model makes a model that
adopts capabilities unreachable from the standing tier, and `FJS-519` is what that
costs: the table whose rows decide access has to keep the ladder, because its writers
go through `asSystem()` and a capability there is enforced by nothing.

**The cost is real and has to be written down: opting in usually means flattening the
gate.** `@@gate("2.4.4.5")` with `@@capabilities` means a caller needs level 4 AND
`Invoice.create`, so a billing clerk at READER(2) holding the capability is refused by
the ladder — which is the case the grid exists for. A model that opts in generally
wants its gate flat at the read floor (`@@gate("2")`) and the grid doing the rest.
That is not the gate becoming decorative: it is the gate saying *you must be a
member at all*, which is the one thing a capability cannot say, because a stranger
holds no list.

**Which makes a static check possible and it should exist**: a model carrying
`@@capabilities` whose write levels sit above its read level is declaring a grid and
then gating it by ladder, and the capability is unreachable for exactly the callers it
was written for. A `fli check` warning, in the family that reads the seed — not an
error, because a deliberately high floor under a grid is a legitimate belt-and-braces.

### <a id="fjs-d147"></a>2026-08-25 · `FJS-D147` — the grant column is a synthesised `Capability[]` type, the column tier is `@capability`, and none of this is a package.

Two spellings and a packaging question, settled together because they are one
question about where this lives.

**The column that holds grants is typed, not attributed.** `capabilities
Capability[]` — `Capability` is a type litestone synthesises from the schema's own
surface, the way `File` is a built-in carrying behavior. `FJS-D139` already rules
that the set is derived, so the type IS that set: validation, the escalation guard and
the role editor's picker all read one source.

The alternative considered was `String[] @capability`, and it was rejected on a
collision found while writing it out. `@capability` is also wanted on an ordinary
column to say *writing this column is its own capability* (`hostname String
@capability`), and the two meanings are not distinguishable by type — a `String[]`
column may legitimately want the column tier. Two roles need two words, and typing
the grant column is better than inventing a second attribute: the type states what
the column holds, which is a fact about the column rather than a rule about it.

So: **`Capability[]` for the column that holds grants, `@capability` for a column
whose write is one.**

**And it is seed syntax in litestone, not a package.** `IDEAS/package-map.md`
reserved `warden` as a tier-1 package; the reservation is retired. Three things
argued against it and none for it: row tenancy and value sets both shipped as a seed
declaration plus a battery with no package of their own; `FJS-D113` refused a
*declaration* for membership because the resolver varies per application, which
applies unchanged to role → capability expansion; and `DECISIONS.md` § Outpost names
`warden` among the words rejected under the rule that infrastructure takes place
nouns and AI takes personified nouns. A capability is enforced at the Data boundary,
so it belongs where every other Data-boundary rule is declared.

### <a id="fjs-d140"></a>2026-08-25 · `FJS-D140` — `@@capabilities` covers writes and named moves. `read` is opt-in, because a missing read capability is the one refusal nobody can see.
**Status:** amended-by [`FJS-D146`](#fjs-d146) — the closing deferral only. What `@@capabilities` covers is unchanged; how it composes with `@@gate` is settled, both ANDed and the gate the floor.

A model that opts into capabilities has said nothing yet about *which of its
operations the declaration reaches*, and the three answers are not equivalent.
Everything — create, update, delete and moves — or writes alone, or writes and
moves with `read` available on request.

**The failure modes are asymmetric and that is the whole argument.** A capability
refusal on a write throws and names itself: `FJS-D139` licenses that, since a
capability is never row-scoped and so refusing one discloses nothing a caller
could not read off the schema. A *missing* read capability composes with the rule
above it — `packages/litestone/docs/access-control.md` § *Combining them*, rule
one, **a refusal must never confirm a row exists** — so the read layer filters and
the answer is an empty list with a 200, on a screen that looks built and is blank.
The default therefore covers the operations that fail **loudly**, and the silent
one is a statement somebody makes on purpose.

**The measurement agrees and is the reason this is not a coin toss.** Across
basecamp's 41 models and `example`'s, **one of twenty basecamp services restricts
reads** beyond what tenancy and the gate floor already do. Reads in these
applications are governed by *which tenant* and *are you signed in*; almost never
by *which position do you hold*. Covering every read by default is a default that
is wrong ~95% of the time, and wrong in the invisible direction.

The rejected alternatives, for the record. **Everything** costs each model a read
capability nobody wanted, and the first symptom is the empty screen this whole
idea exists to remove. **Writes only** cannot express `Invoice.read` at all, which
is a real capability in every ERP the design was audited against — and unlike the
gate, there is no second mechanism to fall back to.

**The spelling follows existing vocabulary rather than inventing one.** `all` is
already the widening token in this language — `@omit(all)`,
`@allow('read'|'write'|'all', …)`, `@@allow('read'|'create'|…|'all', …)` — so:

```lite
@@capabilities        // create, update, delete, and every named move
@@capabilities(all)   // the same, plus read
```

A model that does not opt read in has its reads governed exactly as before, by
`@@gate` and by row policies. Nothing changes for read on any model that says
nothing. **The token is the one part of this that is cheap to revisit** — it is
schema syntax rather than data stored in a customer's rows, which is what made
`FJS-D139` urgent and makes this recoverable.

**What this does not settle**: whether a model that opts in still applies its
`@@gate`, and how the two compose — deferred, and `IDEAS/permission-sets.md`
§ *Open questions* carries it. Nor does it change the one model that opts into
none of this: the table whose rows decide access keeps its full ladder, because
its writers go through `asSystem()` and a capability declared there would be
enforced by nothing (`FJS-519`).

### <a id="fjs-d139"></a>2026-08-25 · `FJS-D139` — a capability is a REFERENCE to something the seed already declares. It is never a name in a list, so there is no `enum Capability`.

The fork was *is the vocabulary written or derived*, and it was ruled first
because it is the only decision in this neighbourhood that cannot be taken back:
a capability is stored verbatim in every customer's `Role.permissions` array, so
changing its shape after an application ships is a data migration across every
tenant of every deployment. Everything else here — which operations opt in,
whether the gate composes, the spelling of `allIn` — is a per-model edit.

**A capability names one of four things, and each is already declared once.**

| Written | Is | Declared by |
| --- | --- | --- |
| `Server.reboot` | a named move | `@@transitions` |
| `Invoice.delete` | an operation on a model | the model |
| `Server.hostname` | a column, on write | the field |
| `NetworkAttachment.create` | an operation on a join model | the model |

So the legal set is **derived from the model's own surface** and
`@@capabilities` is a switch — *grade this model by capability* — rather than a
list the model carries. A list would be a second owner of facts the seed already
states, which Invariant 4 refuses.

**Four things follow mechanically and none of them has to be policed.**

- **A typo cannot exist.** `'Sever.reboot'` in a role row refers to nothing and
  is caught, where an enum member is legal data that silently grants nothing
  forever.
- **The one-action rule is automatic.** `manage` and `operate` are not things the
  schema declares, so a bundle cannot be referred to. Under a written enum the
  rule is a convention somebody has to enforce, and the failure — a grant whose
  meaning widens when the model gains an operation — is invisible to the person
  who approved it.
- **A rename is computable.** Renaming a move or a column IS renaming the
  capability, so the blast radius is known rather than guessed, and the rename
  tool can carry it.
- **Coverage is fact, not judgement.** *What does this capability reach* is
  derivable, which is the matrix that had no home.

**The set stays CLOSED, which is the property this protects.** § *Directions
considered and refused* rejected constructed permission strings
(`invoices_read:region:west`) precisely because they make the set unbounded and
take the DDL check, the generated multiselect, the labels and the snapshot with
them. Reference is the stronger form of the same refusal: bounded, and bounded by
something that cannot drift from what it describes. The generated artefacts read
a derived set instead of a written one and are otherwise unchanged.

**The cost is real and is accepted.** There is no cross-model capability name: an
ERP granting one `billing_read` over three tables says `Invoice.read`,
`Payment.read`, `Ledger.read`. **Bundling lives in the `Role` row, which is layer
2 and is data** — the customer owns it, renames it, and nothing in the schema
drifts underneath it. The version rejected is a bundle in layer 1, where the
framework owns the name and its meaning moves when a model gains an operation.

Ruled against a measurement rather than a preference: all 83 of basecamp's
guarded service methods classify onto those four forms with **no residue**, so
nothing was left needing a name of its own. The complaint that survives is
coarseness — `Environment.write` covering `setVariable` — which is an argument
for the column and move tiers, not for a written vocabulary.

**What this does not settle**, all recoverable and all still open: which
operations `@@capabilities` covers (writes and moves by default, `read` on
request, is recommended and unruled), whether a model that opts in still applies
its `@@gate`, the `allIn` operator, and whether any of this is a package. Nor
does it settle `FJS-519` — `asSystem()` is all-or-nothing, so a capability
declared on the model whose rows decide access is enforced by nothing, and that
is a hole rather than a shape.

`IDEAS/permission-sets.md` is the record.

### <a id="fjs-d131"></a>2026-08-23 · `FJS-D131` — the access diff answers *what did this branch do to access*, which is a wider question than *who may now do more*. What it cannot grade it reports.

The axis was defined as the second question and implemented as it, and both
failures that followed are the gap between the two.

**A model the baseline never had was invisible.** Every per-model rule needs a
counterpart, so a new model fell out of both lists and a branch that added nine
gated tables to `example` printed *no change to who may do what* (`FJS-444`).
That is TRUE by the narrow question — nobody could do anything with a table that
did not exist — and useless to the person who ran the command. The sibling
command had already chosen: `release --from` grades a new model as an expand and
says so.

**The answer is a bucket, not a grade.** `new` carries what the model declares —
its `@@gate`, which operations carry a row policy, how many protected fields, and
`declares neither @@gate nor @@allow — every caller reaches every row` leading
where that is the case. Ranked below `narrows`, so `--strict` means exactly what
it meant: a branch whose only findings are new models passes, and one that also
narrows still reads as narrowing. Nothing that used to fail now passes, which is
the property that makes this safe to add to a gate other people already run.

**An inversion is one change and was read as two.** `@@allow(X)` replaced by
`@@deny(!X)` over the same operations admits the same rows; the walk saw an allow
removed and a deny added and took the worst half, so basecamp adopting declared
tenancy — the safest refactor available — graded WIDENS (`FJS-380`). It is
`undecidable` now, which is the answer this module already gives for a predicate
whose text moved and for the same reason: the two admit the same set only when
they are complements, and deciding that is predicate algebra. **Equal operation
sets only** — a partial overlap is a mixed change, and grading its bare half as
undecidable would hide a widening inside a refactor.

**One finding on this axis, two on the deploy one.** Both halves of an inversion
are real to a deploy — an allow removed is an expand, a deny added is a contract
— and the two axes may describe one change in different words and different
counts. A finding carries an `accessDetail` where the access sentence is not the
deploy sentence; a reviewer reading the same change twice under two verdicts is
how a report stops being read.

**A baseline is history and is graded by its own era, not today's.** Every
validation rule the parser learns is retroactive, so the day `@@unique` over a
nullable column became an error, every ref before it stopped being a baseline and
`--strict` — which fails on no baseline by design — would have failed every
branch (`FJS-469`). A validation failure on a baseline is a named note and the
comparison runs; a SYNTAX failure still refuses. That line is the real one:
validation rejects a schema the parser understood, and there is nothing to
compare when it did not.

### <a id="fjs-d129"></a>2026-08-23 · `FJS-D129` — a FIELD predicate is compiled into SQL, on both sides. It is never evaluated in JS against the payload, and never merely stripped from the answer.

`@guarded` is a set-membership test decided once per model, which is what let
`FJS-393` be closed by a walk over the caller's arguments. A field
`@allow('read'|'write', …)` is a **predicate**, and both halves of it were being
answered in the wrong place:

**Read (`FJS-442`)** — the column was stripped from the answer and left fully
filterable and sortable. Measured: `salary Int? @allow('read', auth().isAdmin)`
recovered exactly as `91000` in seventeen requests by `where: { salary: { gt:
mid } }`, and `orderBy` leaks the ordering of every row in one.

**Write (`FJS-433`)** — the predicate was evaluated with `evalJs(expr, ctx,
transformed, …)`, where `transformed` is the PAYLOAD. So
`@allow('write', auth().id == ownerId)` on an update is wrong in both
directions: a payload that omits `ownerId` grades against `undefined` and drops
the column from a write the owner was entitled to make, and a payload that
STATES `ownerId: me` grades against the caller's own assertion and lets them
write the column on somebody else's row. The second is fail-open.

**The ruling: the predicate is SQL.** It is compiled with the same
`compileSql` that `@@allow` row policies use, and applied where the ROW is —
which is the database — rather than in JS against a value the caller supplied.

- **On read**, a predicate whose field the caller's own arguments name is
  AND-ed into the query's **top-level** WHERE, outside the caller's expression.
  Outside is load-bearing: `(<caller's where>) AND (<pred>)` cannot be
  complemented by a caller's own `NOT`, where a per-clause conjunction can —
  `NOT ((pred) AND (salary > X))` is TRUE for every row the caller may not read,
  which is the same oracle wearing a minus sign. The result set narrows to the
  rows whose column the caller may read, which is the honest answer to *filter
  by a column you can only see on some rows*.
- **On write**, the payload value becomes
  `SET col = CASE WHEN <pred> THEN ? ELSE col END`. The predicate sees the
  STORED row, because in an UPDATE that is what a column reference is — so a
  caller cannot assert their way past it, and a bulk update grades every row
  separately, which no JS evaluation of one payload can do.
- **On create there is no stored row and the payload IS the row**, so JS
  evaluation against it stays, and it is correct there for the same reason
  `checkCreatePolicy` grades the incoming data.

**Two things are deliberately not done.** A field reached through a RELATION
(`where: { author: { is: { salary: … } } }`) is refused by name rather than
compiled, because the predicate belongs to the other model's row scope and a
top-level AND is the wrong scope for it — the same answer `@guarded` gives, and
the same reasoning. And nothing is refused on the same-model path: refusing
every filter on a predicated column would also refuse the one a caller may
legitimately run over their own rows, which is the case the feature exists for.

**The cost of *outside* is bluntness, and it is stated rather than discovered.**
A predicated column named inside an `OR` narrows the whole read, so a branch
that does not mention the column is suppressed along with the one that does:
`{ OR: [{ salary: { gt: X } }, { name: 'bob' }] }` answers nothing for a caller
who may not read `salary`, where bob is a legitimate answer to half of it. It
fails in the safe direction — fewer rows, never more, and never a row the
caller could not otherwise have distinguished — and the way out is two reads.
Precision there is exactly what masking would have bought.

The alternative considered and rejected was masking the column in place
(`CASE WHEN <pred> THEN col ELSE NULL END` substituted at the column
reference). It is the more precise semantic — NULL propagates correctly through
the caller's own `NOT` — and `fromExprMap` already proves an expression can
stand where a column does. It was rejected on cost: a masked expression carries
PARAMS, a single clause repeats the column reference an unbounded number of
times (`between`, `in`, `contains`), and every operator branch in `buildWhere`
would have to materialise the expression and push its parameters in textual
order. The top-level AND buys the same safety for one parameter push.

### <a id="fjs-d113"></a>2026-08-21 · `FJS-D113` — a tenant claim and a per-request standing are the SAME thing: claims on the principal, resolved by one seam, before the Data boundary scopes the client.

`FJS-D05` shipped row tenancy and left one question: **where does the claim come
from?** It reads the claim off the principal, and its own refusal names the
assumption — *put the column on the session*. That is one tenant per sign-in,
which is a real shape and is not the shape of most B2B software, where a person
belongs to several accounts, switches between them, and holds **a different
authority in each**. So the framework's own dogfooding app cannot use the
framework's own tenancy feature: basecamp declares
`@@allow('all', workspaceId == auth().workspaceId)` on fifteen models by hand and
writes ~260 lines around it.

**The reframe is the ruling.** `applyStanding` looks like two features —
resolve a tenant, resolve a role. It is one: `workspaceId` and `memberRole` are
both **claims put on the principal for this request**, read from one membership
query, one by the tenancy predicate and one by the gate. There is no tenancy
feature missing and no gate feature missing. What is missing is a seam that lets
a claim be resolved **per request** rather than fixed at sign-in.

That is why this costs **no new schema syntax**. `tenantClaimGuard` already
reads the claim's name off `$tenancy`; row tenancy already compiles the predicate
and the `@default(auth().<claim>)` stamp. Let the claim arrive by a second route
and the shipped feature starts working for the membership shape unchanged.

**Resolution is API-realm, and the framework had already said so twice.**
`strategy database` asks `registry.tenantFor({host, headers, principal})`;
`strategy row` reads a claim auth put on the session. Neither puts the source in
the seed, and `ARCHITECT.md` §3.1 says why — the seed holds what is true about
data over its whole life, and *this request's tenant is in the
`X-Workspace-Id` header* is transport convention, the same class as `$` params
(Invariant 10). **A `tenancy { … from header(…) }` keyword is refused** on that
ground.

**The seam is one option on `createApp`.**

```ts
createApp({
  db,
  principal: async (ctx, user) => ({ workspaceId, memberRole }),
})
```

Junction merges what it returns onto a **fresh** principal, assigns
`ctx.auth.user`, and re-scopes `ctx.locals.db` through
`$setAuth(toDataPrincipal(…))`. Not two options (`tenant:` + `standing:`) —
they are one concept and would force two membership reads; not a plugin —
plugin order is the exact thing that has to be right, and a plugin cannot
guarantee it composes inside `withLitestoneDb`. **Hook tier** (`FJS-D06`): it may
mutate what follows, and — as that tier allows — it may halt. `membershipClaim`
does, on a client with no such accessor. What it must not do is *refuse the
caller*: grading a caller is the guards' job and they already exist, and a
resolver that threw for a stranger would be a Guard wearing a Hook's name.

**Three constraints the seam owns, so no app rediscovers them.** They are in
basecamp's comments one at a time, each learned by being wrong: it must compose
INSIDE `withLitestoneDb`, which scopes the client from `ctx.auth.user` before any
hook knows which tenant is addressed; the standing must go on the **principal**,
because `getTable()` re-derives its own scoped copy and a standing living only on
`ctx.locals.db` is dropped the moment a service touches a model; and it must
produce a **fresh object**, because a WebSocket session is resolved once at
upgrade and handed to every frame, and the internal-call path freezes it
(`FJS-D30` rests on that).

**The claim IS the proof, and that is the line the whole ruling turns on.**
Basecamp today puts `workspaceId` on the principal even with no membership row,
and survives it because it does not use declared tenancy — the gate grades
VISITOR and a hook writes a sentence. Under declared tenancy the same code
scopes a stranger INTO the tenant and every read answers 200. **A resolver may
emit the tenant claim only once membership is established.**

**So the membership read ships as a battery rather than as documentation.**
Declaring the membership model in the seed was considered and refused:
`@@tenant(via: rel)` already means *scoped through this parent* (`FJS-282`), so a
second `via` is one word with two meanings inside one feature; it is real
language work — parser, three snapshots, docs; and it hard-codes that membership
is one model with one subject column and one standing column, which is false for
membership through a team, for a role that is a join, and for more than one role.
None of the value needed the seed:

```ts
principal: membershipClaim({
  tenantFrom: (ctx) => ctx.headers['x-workspace-id'],
  model: 'workspaceMember', subject: 'userId',
  tenant: 'workspaceId',    standing: 'role',
})
```

The helper cannot emit a claim it did not verify, which is the whole safety of
the declared version, at no language cost — and an app whose membership does not
fit writes the plain function and composes it. Principle 9 as stated: the paved
road is the road, and the escape is not a worse one. As a battery it passes
`FJS-D14`'s severability test — one owner, one seam, and the core only knows it
received a resolver.

**It does not run for background work, by name.** There is no request, so a
header-shaped resolver has nothing to read. `app.runAs(userId, fn)` rebuilds a
principal through `IAuth.sessionFor` and carries no tenant claim; a job needing
one states it. The alternative — a resolver running against a null `ctx` — makes
every resolver handle a missing request and lets a wrong default silently scope
a job to one tenant.

> **Amended 2026-08-22, by building it.** This paragraph predicted that a job
> reading scoped rows would hit `tenantClaimGuard` and fail loudly. It does not.
> Measured on basecamp: **all four job files went to `asSystem()` instead**,
> which drops the gate, the row policies and the audit actor together to do work
> that wanted one of them relaxed. A refusal an author can step around with one
> call is not a loud failure, it is a signpost to the bypass. The ruling above
> stands — the reasoning for it is untouched — but the consequence was not
> weighed, and it is open as `FJS-384`.

**What it unblocks:** ~260 lines of basecamp deleted and a class of tenancy leak
with them; `FJS-095`, whose `{ validate: false }` survives only because
`workspaceId` is stamped by the CLIENT; and the shape of basecamp's `core/`,
which is what was being decided when this was found. Build filed as `FJS-374`.

> **Amended 2026-08-22.** `FJS-095` was not unblocked. The declaration does
> stamp the column at the Data boundary, so the client's stamp is now
> bookkeeping — but the column is still `required` on create in the generated
> JSON Schema, so browser-side validation still refuses a create without it and
> the resource still cannot drop the hook. `@system` is out of create-mode
> `required` for exactly this reason and a tenancy-defaulted column is the same
> case; filed as `FJS-387`.

---

### <a id="fjs-d05"></a>2026-08-16 · `FJS-D05` — tenancy is DECLARED in the seed, one block, two strategies; row tenancy compiles to `@@deny` and never to `@@allow`.

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

### <a id="fjs-d22"></a>2026-08-15 · `FJS-D22` — a column says *the system writes this* with `@system`, and the application fills it by naming the column on the write.

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

### <a id="fjs-d47"></a>2026-08-14 · `FJS-D47` — The identity ladder: `@@gate("8")` is for credential material, not for `User`. A model is bounded by three declarations, and a level is only the first.

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

### <a id="fjs-d48"></a>2026-08-10 · `FJS-D48` — Basecamp's gate ladder: a level is a fact about a caller IN A WORKSPACE, so it is resolved per request and carried on the principal.

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

### <a id="fjs-d49"></a>2026-08-10 · `FJS-D49` — A tier above every tenant is a SEPARATE service, and the bit that grants it is a column named for the standing it grants.

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

### <a id="fjs-d50"></a>2026-08-10 · `FJS-D50` — A status column that nothing reads is not a state, and suspension needs a door on each side.

`User.status` had been a free `String` since the schema was written, and
@frontierjs/auth — which owns the model — never looks at it. So "suspended" was
a word the app could store and nothing anywhere would honor: a Suspend button
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

### <a id="fjs-d51"></a>2026-08-10 · `FJS-D51` — A machine account is created from an admin screen. A human is not.

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

### <a id="fjs-d52"></a>2026-08-06 · `FJS-D52` — Raw SQL is available through `asSystem()` only, on any schema that declares access rules.

Fixes `FJS-005`.

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

### <a id="fjs-d53"></a>2026-08-01 · `FJS-D53` — Gates enforce by default when declared; undeclared imposes nothing.
Any model with `@@gate` is enforced from the first request via the shipped
`FrontierGateGetLevel` resolver (null user → STRANGER) even with no GatePlugin
installed. A user-supplied `GatePlugin({ getLevel })` replaces the resolver
entirely. Models without `@@gate` are completely open. `asSystem()` bypasses
(except LOCKED). Rationale: a declared gate that silently does nothing is a
fail-open security default — verified live before the fix.
*Lives in:* `packages/litestone/src/core/client.js` (default plugin injection);
tests in `test/elegance-fixes.test.ts`.

## Query & write semantics (Litestone)

### <a id="fjs-d189"></a>2026-09-03 · `FJS-D189` — a polymorphic relation is refused. The closed set is `@@arc`, the open set stays two plain columns, and the reason is that a relation's target is an input to the access-control compiler.

`IDEAS/polymorphic-relations.md` is the argument, measured against the tree
rather than estimated. The request arrives as one question and is two, and
conflating them is how a project buys the expensive answer and still does not get
what it wanted.

**A closed set of models you own, sharing an identity** — *a Content is a Post or
a Video* — is solvable, and a real foreign key is available at the end of it.
**An open set, pointing at anything** — *this tag, audit row or notification is
about any row in the app* — is not: no relational database gives it referential
integrity, with or without an ORM's help, and no ORM in this ecosystem changes
that. Litestone has three instances of the second and none of the first, and all
three are two plain columns and a naming convention, which is the honest shape.

**The count is the cheap half of the refusal.** 158 call sites thread
`relationMap`, 69 read `.targetModel` as a single value, and nine modules hold
the single-target assumption. **The expensive half is `policy.js`**: a
`check(rel, 'read')` compiles the TARGET's own policy into a correlated subquery
against the target's own table. One relation, one table, one WHERE. A
polymorphic target is N compiled branches inside a `CASE` on the discriminator,
each carrying that target's `@@gate` and its `@@allow` set — and then the
question with no good answer, which is a caller who reads `Order` at 4 and
`Product` at 5 listing the attachments on a tag. Filtered by policy is a 200 with
fewer rows, and a wrong policy is an empty screen rather than an error, which is
what Invariant 6 is arranged around. Everything downstream inherits it: no
foreign key for `ddl.js` to emit, a union `typegen` cannot answer so
`controlFor` answers `null` and the column is absent from every generated form,
an `x-gate` that cannot answer on the client because the gate is per target and
the target is per row, and an `announceDataWrites` that cannot say which service
announced the write. **That is not a feature with a large diff — it is a change
to the meaning of the access core**, and this framework's one non-negotiable is
that access is declared in the schema and enforced at the Data boundary.

**The neighbors do not settle it against us.** Prisma does not support it and
the request has been open since 2020; its own documentation answers with three
workarounds and one of them is `@@arc`. ZenStack's `@@delegate` is the strongest
thing in this ecosystem and it answers the FIRST problem only — every
participant must `extends` the base, which is a closed set by construction, so
expressing *tag any row of any model* through it means a schema-wide refactor
that adds a join to every read of three models in exchange for a tag. The open
set stays open under delegate exactly as it does here.

**What ships instead is `@@arc([a, b, …])`** — several optional foreign keys of
which exactly one is set, which was writable in `.lite` before the attribute
existed, since `ddl.js` emits a `@@check` expression verbatim and SQLite spells a
boolean as 0 or 1. **The whole argument for it is that these are ordinary
relations**: a real foreign key, a real `onDelete`, a real `include`, all 69
`.targetModel` reads still single-valued, and one target per branch for the
policy compiler. Nothing in the access core moves. What the attribute adds over
the hand-written CHECK is a parse-time refusal — every column named must exist,
be nullable and carry a `@relation` — and a constraint that is derived rather
than typed. It is a **contract** for `release:check`, like any row invariant, and
it stops scaling around six columns, **which is the signal that the target set is
OPEN and no relation can serve it**.

**Refused *for now*, and the condition is named rather than left to taste.**
Reopen this when an open target set has to carry a real foreign key, a real
cascade and a policy-compiled `include` at once — the case `@@arc` cannot reach
and two columns do not pretend to. A larger `@@arc`, a second discriminator
convention or an ORM-side sweep of dangling rows are each this ruling being
worked around rather than a reason to revisit it. Until then a polymorphic pair
is graded rather than forbidden: `fli check`'s `polymorphic-subject` warns where
the discriminator is a bare `String`, because an `enum` there emits a table CHECK
and reaches a picker, and that is the one column of the pair that can still be
told something.

*Lives in:* `packages/litestone/src/core/parser.js` (`@@arc`) ·
`packages/litestone/src/core/ddl.js` · `packages/litestone/src/release.js` ·
`packages/cli/core/checks.js` (`polymorphic-subject`) ·
`IDEAS/polymorphic-relations.md` is the argument · `example`: `verify:collect` is
the only `@@arc` in either app and the only place a provider's answer drives a
state machine.

### <a id="fjs-d175"></a>2026-09-02 · `FJS-D175` — a broadcast is graded PER RECIPIENT at publish, by the Data boundary, in cohorts; joining a channel is a subscription and never a permission.

`FJS-631`. A channel is a named set of connections and joining one was an
ungraded **grant**: every row published there reached every member, whatever the
schema said. `@@allow` compiles into a SELECT's WHERE and **a broadcast is not a
SELECT**, so a row reaching a caller through a query was filtered by
construction and one reaching them through a frame was filtered by nothing.

**Measured on `example` rather than reasoned about.** A socket opened at
`ws://localhost:8110/ws` with no token received a whole `Order` row — reference,
status, subtotal, tax, total, `customerId`, `trackingCode` — one publish after
an admin's `PATCH`, while the same anonymous caller was answered **401** on
`GET /api/orders`.

**Prior art picked the design and then changed the implementation.** Two
families exist. Rails ActionCable, Phoenix and Laravel Echo authorize at JOIN,
with the audience encoded in the channel name; Supabase Realtime and Feathers
grade at PUBLISH. Join-time is cheaper and was rejected because the publisher
must then decide per row which channel it goes to — re-deriving in application
code what `@@allow` already states declaratively, which is the duplication the
framework exists to remove. Supabase does what is ruled here, and its
documentation supplies the number: one change to a table with 100 subscribed
users is 100 authorization checks, throughput scaling with subscribers rather
than with the write rate, and a recommendation to switch to plain broadcast past
~3,000 concurrent subscribers on the same change. That ceiling is stated rather
than discovered.

**The cost that multiplies is the ENCODING, not the verdict**, which is Phoenix's
warning about `handle_out` — intercepting means "the broadcast will be encoded N
times instead of a single shared encoding". Measured here it is exactly so:
`JSON.stringify` of one frame is 288 ns against 684 ns for a scoped context, but
the frame is the term paid per recipient. **So the unit is a COHORT and not a
connection**, which is Hasura's answer — subscribers sharing session variables
multiplex, and only differing authorization contexts force separate work. The
key is the principal's VALUE — a canonical serialization of the session,
memoised on the object `verifySession` answered — so two principals that
serialize identically are one cohort and two that do not can never collide the
way a hashed key would. Measured over 100 connections: **14.9 µs** where the
model needs no grading, **49.8 µs** for one cohort, **445.6 µs** for 100
distinct principals — a **9×** collapse where cohorts exist.

**Amended 2026-09-04 (`FJS-764`).** This ruling said *object identity*, on the
reasoning that `Connection.user` is the session built once at upgrade. It is
built once per SOCKET: `_wsOpen` calls `verifySession` per connection and
`@frontierjs/auth` answers a fresh object each time, so no two sockets ever
shared one and the cohort was a per-connection loop wearing the word cohort. The
correction does not change what a cohort MEANS — it is still one verdict and one
encoding per distinct authorization context — only how one is recognised, and
the collapse the numbers above describe is what an application gets now rather
than what it got then.

**The rule stays at the Data boundary.** `$readAs(accessor, row, principal)` is
litestone's fifth `$`-sibling and takes its subject as an ARGUMENT for
`$capabilitiesFor`'s reason: the asker holds one client and is answering about
somebody else. It asks the gate, then the row policy, then shapes the row with
that principal's field policies — the order every other layer here reads in,
and the gate is the whole answer for a stranger. Junction owns the fan-out and
the cohorts and **nothing else**; a second implementation of any of those three
is a second answer to who may read.

**Field shaping is safe to do in JS on a row already read**, which is what makes
this affordable: `applyFieldPolicyTo` STRIPS `@encrypted`, `@guarded` and
`@hashed` for any non-system context, and a socket recipient is never system, so
the decrypt branch cannot run. What it gives up is stated — the row is not
re-read, so a `@from` or `@computed` value is the writer's rather than one
derived under the recipient's own policies. Hasura re-runs the query per cohort
and can, having a connection per subscription; a query per recipient per write
is the cost that would make this unaffordable.

**A model that can only ever say yes is skipped entirely.** `$readGrading`
answers `open` for a model whose read gate is 0 with no read policy and no field
policy — a catalogue, which is also the busiest channel an app has. Read off the
SCHEMA, so a policy added later turns that channel from open to graded with
nothing to remember.

**Undecidable refuses; inapplicable does not.** `policyVerdict` throws on a
policy it cannot decide and at a boundary that must refuse — but a call with no
Data boundary on its context (a raw route, a test harness) is ungraded rather
than refused, because grading was never applicable there. Conflating the two is
how a fail-closed check becomes fail-open at the first odd shape. A LIST payload
is likewise not graded: a bulk write announces a COUNT (`FJS-D34`), which names
no row and leaks none.

**The principal has to be translated and that is the defect this nearly
shipped with.** A `SessionContext` puts the id at `userId` and litestone's
`auth()` reads `.id`, so handing the session straight over compares every policy
against `undefined`. It does not merely refuse: measured, `userId == auth().id`
was FALSE for the buyer's own order and TRUE for a guest order whose `userId` is
null, so the first working version refused the anonymous socket correctly AND
delivered the one row the recipient may not read while withholding the one they
own. `toDataPrincipal` is the owner, and it was caught only because the drive
asserts both directions of every refusal.

### <a id="fjs-d174"></a>2026-09-02 · `FJS-D174` — a 64-bit column is declared `Int @big` and its value crosses as a STRING of digits; global `safeIntegers` was refused on measurement, and no `CHECK` is emitted because `STRICT` already refuses everything one would.

`FJS-643`. SQLite's `INTEGER` is 64-bit and litestone set `safeIntegers`
nowhere, so `bun:sqlite` answered a JS `number` on every path. A value past 2^53
was read back as a **different number, of a value the database was holding
correctly** — measured both ways: a raw-SQL write of `9007199254740993` stores
exactly (confirmed with `CAST AS TEXT`) and the ORM read back `…992`. Nothing
could see it, because the write and the read were each self-consistent.

`FJS-583` bounded `@scale`/`@money` at 2^53 and deliberately left plain `Int`
unbounded — "it makes no exactness promise, and bounding every integer column in
every app to buy back one is the wrong trade". That is a ruling about the WRITE
side and does not reach this one. It arrives by two ordinary routes: a snowflake
id, which Discord and Twitter/X passed years ago, and `litestone import`, which
maps a foreign `BIGINT` straight onto `Int`.

**Four things ruled, and three of them were settled by measurement rather than
by argument.**

**Global `safeIntegers` is refused.** It was the issue's own second candidate
and it fails twice. It costs **+68 %** on every read for every app — 1884 →
3171 µs over a 5,000-row scan — and, decisively, **`JSON.stringify` throws on a
`BigInt`**. That is every HTTP response, every WebSocket frame and every
`before`/`after` snapshot in an audit trail, so the version of this that changes
the read type of every `Int` breaks the stack at once.

**The value crosses as a string of digits, not as a `BigInt`.** Same reason, one
scope smaller, and it is the mainstream answer rather than a workaround:
node-postgres returns `int8` as a string by default and mysql2 has
`bigNumberStrings` for it. The type does not depend on the magnitude — a `@big`
column holding `42` reads back `'42'` — or a caller would have to branch on the
size of the value. A JS number is still accepted going IN below 2^53, so
ordinary code writing small values does not quote them. What it costs is stated:
arithmetic says `BigInt(v)` first, which is honest about a value that does not
fit a number.

**The column keeps `INTEGER` storage, which is what makes it worth doing.**
Holding digits in a `TEXT` column was the standing advice (`wide-int.js` said
"Store it as String") and it loses everything SQLite does with a number.
Measured, all of it survives: a text parameter takes the column's INTEGER
affinity, so `ORDER BY` puts `100` before `9007…` where text puts it after, a
range filter compares numerically, `EXPLAIN QUERY PLAN` answers
`SEARCH … USING COVERING INDEX (v=?)`, and `AUTOINCREMENT` continues correctly
past 2^53.

**No `CHECK` is emitted, and that is the opposite of `@scale`.** The first cut
emitted `CHECK (typeof(col) = 'integer')` by analogy — `@scale`'s CHECK exists
because four writers never reach the boundary. Measuring it killed it:
litestone emits `STRICT` on every table, and STRICT already refuses all three
ways a wide value stops being exact — past int64 (which a loose table demotes to
REAL `9.22e+18`), a non-numeric string, and a fraction. So the CHECK's message
could never appear, and a constraint that cannot fire is worse than none because
it reads as the thing doing the work. **The distinction is the bound**:
`@scale`'s is NARROWER than the column's own, so only a CHECK can hold it, while
`@big`'s IS the column's own. `@@noStrict` is the one shape that turned STRICT
off and is therefore the one shape that earns the constraint, which is where it
is emitted.

**An attribute, not a `BigInt` scalar.** `FJS-D142`'s reasoning applies
unchanged: the storage is a SQLite `INTEGER` either way, so a new scalar emits an
identical column and duplicates the DDL, JSON Schema, validate, client-type and
import branches to do it.

**Two smaller things fell out of building it.** `safeIntegers` is all-or-nothing
per STATEMENT, so a wide model's statements answer BigInts for `id`, a count and
a Boolean's 0/1 as well — and asking at the statement while narrowing in the row
read is an enumeration: `count()` on a wide model answered `0n`, because a
statement also serves counts and aggregates that reach a caller through neither
`read` nor `readAll`. The statement narrows what it returns, so there is no list
to keep in step. And for a key the row read does not recognize — `_max__col`, a
window's row number — the fallback is the VALUE: one that fits becomes a number,
one that does not becomes digits, because a wrong number is the defect and an
unexpected string is not.

**`litestone import` now carries a wide column instead of narrowing it**, which
moves `bigint` from `changed` to `noted` in `src/import/tiers.js`. Keys and
foreign keys stay a plain `Int` on the existing structural exemption — without
it a Rails import turns every id in the app into a string.

### <a id="fjs-d173"></a>2026-09-02 · `FJS-D173` — an announcement travels as far as the DATABASE declares, and `crossProcess` records it rather than sending it; the reach is one machine, and that is stated rather than approximated.

`FJS-642`. The live layer was in-process callbacks, so a second process
announced nothing to the first — and `docs/concurrency.md` recommended running
one. Not a gap in a mechanism: SQLite has no central server, so there is nothing
to LISTEN to. `sqlite3_update_hook`, the pre-update hook and the sessions API
are all in-process by construction, which is why every real system solving this
records instead — Rails 8 ships Solid Cable as its Redis-free default and it is
a messages table polled at 100 ms.

**Four things ruled, and each one removes the reason for the next.**

**The reach is one machine, said out loud.** Two processes share a FILE. A
second machine shares nothing and hears nothing, and no file-based signal can
change that — so the alternative was a declared bus (Redis, NATS), which
contradicts the whole premise of a package whose deployment story is a file.
The supported shape is what `docs/concurrency.md` already recommends: a worker
or a second replica beside the API.

**It is DECLARED, per database.** `database main { announce crossProcess }`,
default `inProcess`, which is what every existing schema already means. The
mechanism costs a recorded row per announced write — **+14 µs on a 25 µs
single-row insert, and nothing on a bulk one**, because `changed` already
carries a count rather than a row (`FJS-D34`). An app that runs one process must
pay none of that and carry no table, and an app that runs a worker is the one
that knows it does. Refused on a `jsonl` or `logger` driver by name: those are
files, so there is no table to record into and no transaction to record with.

**The row carries the ID, never the row itself.** Writing the row would put the
plaintext of every `@encrypted` and `@guarded` column into a table beside the
ciphertext — undoing encryption at rest to save a read. The receiving process
re-reads through its own client, which also makes the row the shape ITS reads
produce: plugin read hooks run, a `File` reference resolves, the field policies
apply (`FJS-541` is what a differently-shaped read costs). The consequence is
accepted rather than hidden: **a re-read answers the row as it is now**, so a
create delivered after a later update carries the later values, which for a live
store is the wanted answer. A removal carries the id and no row, because there
is nothing left to read.

**A foreign event arrives on the SAME seam as a local one.** `$tapEvents`, with
`foreign: true` on it — so Junction's `announceDataWrites` and everything above
it needed no change and cannot tell them apart. That is the whole design; a
second delivery path is how the two ends up disagreeing about what an
announcement is.

**What it does not promise, stated:** at-most-once across a crash. The row is
recorded after the write's own transaction commits — `FJS-D170` holds
announcements until COMMIT precisely because an announcement is a claim that a
row is there — so a process dying in the microseconds between them loses that
one announcement. Making it exactly-once means moving twelve write paths'
announce inside their transaction, a different change with its own risk, and
`ctx.afterCommit` already makes and states the same trade one realm over.

**The wake is a file watch with a slow poll behind it.** Measured: `fs.watch` on
the database directory woke on 5 of 5 foreign commits at a **median 0.7 ms**,
against 50 ms average for the 100 ms poll Rails uses — and it costs nothing when
idle. The poll stays as the backstop for what a watch cannot see (an inotify
limit, a filesystem that does not report), gated on `PRAGMA data_version`, which
is 2.5 µs prepared and does not move for this connection's own commits. It is
FROZEN inside a read transaction, so nothing in the watcher opens one.

*Lives in:* `packages/litestone/src/core/cross-process.js`, the declaration in
`src/core/parser.js`, the seam in `src/core/client.js`; `test/cross-process.test.ts`.

### <a id="fjs-d172"></a>2026-09-02 · `FJS-D172` — `maxOpen` is how many tenants to keep WARM, not a ceiling on open connections; a pool never closes what it lent out, and a LEASE is what makes the close deterministic.

Four rulings from one defect (`FJS-640`), and the order matters because each one
removes the reason for the next.

**`maxOpen` is a target.** A hard cap can only be honored by closing something,
and the only thing available to close is a client a request is holding. The
measurement settles it rather than the argument: bun's `close()` is
`sqlite3_close_v2`, so it defers destruction until the last prepared statement is
finalized, and `wrapDb` holds up to 500 — a close with one live statement freed
**0 file descriptors**. `maxOpen` had never bounded a connection in any process
that ran one query per tenant. It was not a cap being relaxed; it was a cap
discovering it had never existed.

**Eviction never closes a lent client.** Closing one does not kill it — it leaves
a MIXED client that answers a cached query off a closed, checkpointed handle and
throws on a fresh one, so a request fails only if it takes a branch it has not
taken before. Every mature pool reaches the same answer independently: HikariCP,
Go's `database/sql` and pgbouncer all evict idle entries only and retire a busy
one **when it is returned**. `sqlite3_close_v2` is the same rule one layer down.

**The lease lives in the request scope and is not a public verb.** The cost of a
soft target alone is that the release is untimed — the handles come back on a
collection that file-descriptor pressure does not trigger, which is the habit
Java deprecated `finalize()` over, .NET puts behind `Dispose`, and the
`FinalizationRegistry` proposal itself warns against. junction's `withTenantDb`
already has the answer: a request IS the unit of work, so it pins on entry and
releases in a `finally`. Nothing an app writes changes, and nothing an app can
forget. A client from a bare `tenants.get()` was never leased, so it is dropped
rather than closed and the finaliser remains the backstop for it — the honest
split, because the pool genuinely does not know who holds that one.

**A fan-out is a scan and gets a ring.** `tenants.query` walks every tenant, so
through a plain LRU an admin dashboard evicts the tenants under live traffic.
Cold entries are the eviction victim before any hot one, in a ring sized to the
fan-out's concurrency and capped at half the pool — Postgres's seqscan ring
buffer and MySQL's midpoint insertion, which exist for exactly this. The cap is
load-bearing and was found by a test: a ring wider than the pool can never fill,
so it never starts recycling and every cold insert evicts a hot entry, which is
the scan resistance being off in silence for the small pools that need it most.

**What follows for anything else that hands out a handle**: a close is not a
close until the things holding the connection open are released, and a pool that
cannot say who is holding one cannot close it. `$close()` therefore finalises the
statement cache and every path afterwards throws `ClientClosedError` — a
half-working client is worse than a refused one, and it is what made this defect
read as random for as long as it existed.

### <a id="fjs-d176"></a>2026-09-02 · `FJS-D176` — `$merge` is the sixth atomic operator, it wears a `$`, and a patch is graded PARTIAL only where the target is guaranteed to be there.

`{ settings: { $merge: { commute: { source } } } }` → `json_patch(coalesce(col,
'{}'), ?)`, on `update` and `updateMany`. Refused on `create`, `createMany`,
`upsert` and `upsertMany` for `FJS-D54`'s reason — there is no stored value to
merge into, and upsert's two paths could not agree about one.

**Why it is not `merge`.** `FJS-D54` ruled that the COLUMN decides an operator
is an operator, which works because a numeric column cannot hold an object. A
`Json` column can, so a document's own key may be spelled `merge` and nothing
could tell the two apart. `extractWriteOps` skips `Json` columns for exactly
that reason today, and the cost of the skip is measurable: `{ doc: { increment:
1 } }` stores `{"increment":1}` as the document. The `$` is what removes the
ambiguity, and it is the only single-`$` name in a write payload — Invariant
10's `$`-prefixed KEY is a transport directive and this is not one, so the two
share a character and nothing else.

**The grading rule, and the obvious version of it is unsound.** The first design
said: check the patch's present keys against `T`, refuse a `null` on a required
key. Measured against real `json_patch` and litestone's own validator over 68
(stored × patch) pairs, **2 counterexamples**, one mechanism — RFC 7396
REPLACES rather than merges when the target at a path is absent or null:

```
{"a":null}     + {"a":{"x":1}}  =  {"a":{"x":1}}        ← replaced
{"a":{"x":1}}  + {"a":{"y":2}}  =  {"a":{"x":1,"y":2}}   ← merged
```

So a patch aimed at an optional field is a create however partial it looks, and
that type's required keys are not optional after all. Nothing about the patch
can show it — a missing required key and a partial patch are the same thing.

The ruling is the repair, and it needs no read:

> **Grade a patch as PARTIAL where the target is guaranteed to be present, and
> as a CREATE where it may be absent.** A required field is present in every
> valid parent, by induction from the column's own type. An optional one may be
> null. The same applies to the column: `Json @type(T)` is partial, `Json?
> @type(T)` is a create.

Verified over 90 pairs at three levels of nesting: **0 unsound**, 3 conservative
refusals, every one a partial patch into an optional nested object that happened
to be present. The operator cannot know that without the read it exists to
avoid, so it refuses and the message says why rather than answering a bare *is
required* — a refusal that looks like the validator being wrong is worse than no
refusal.

**An undescribed `Json` column is not graded.** It declares no shape, so there
is no invariant a merge can break. Two earlier positions were considered and
both are retired: *typed only* (the read side refuses an undescribed path, so
symmetry) and *untyped only* (a validator cannot see a value computed inside
SQLite). The first is wrong because the read refuses for a reason that does not
apply here — it cannot COMPILE a comparison without a declared type, and a merge
needs no type knowledge. The second is wrong because the grading above is sound
without seeing the result. The undescribed case is also where the feature has
users: `@type(` is bound to zero fields in this repo, while `advise` reports 24
undescribed `Json` columns on basecamp alone.

**What it buys over the alternatives.** Read-modify-write is two statements and
loses a concurrent change; `@version` turns that into a retry rather than
removing it. `asSystem().sql json_set(…)` is already atomic and race-free, and
it enforces no gate, no row policy and no `@version` — and **announces nothing**,
so a merged row reaches no open tab. `$merge` is an ordinary write: the gate,
the row policies, the field write predicate (`FJS-661`), `@version`, the audit
actor and `@@log`'s before/after snapshots all apply, and it broadcasts the
merged row.

Refused by name beyond the operations above: a column that is not `Json`, an
`@encrypted`/`@secret` column (the stored text is ciphertext, so a patch of it
is neither), a patch that is not an object, and `$merge` mixed with any other
key. `validateTypedJson` grew a `mode` defaulting to `full`, so every existing
caller is unchanged. Full argument and the measurements:
`IDEAS/json-document-writes.md`.

### <a id="fjs-d171"></a>2026-09-01 · `FJS-D171` — *somebody moved this under me* is earned by a declared PRECONDITION, never inferred from who won a footrace.

Serializing writes (`FJS-D170`) made the in-process transition race impossible,
and the loser of two concurrent named moves now gets the answer the sequential
case always gave: `calculated -> cancelled` is not a declared move, so asking for
it is a `TransitionViolationError` however the row got there.

**What was lost was not a contract, it was an artefact.** The old
`TransitionConflictError` with `retryable: true` appeared only because both
callers evaluated against `draft` before either committed — so the SAME end state
answered two different classes depending on which request won by a microsecond,
and the retry that answer advised failed identically. Measured both ways before
the change.

**The prior art is unanimous and it decides this.** Every system that separates
*you lost a race* from *you asked for something illegal* does it from a
precondition the caller declared, never from timing: HTTP answers `412` because
the client sent `If-Match`; Hibernate and EF Core raise because a version column
mismatched; Postgres and MySQL raise `40001` because the ENGINE detected a
serialization conflict. Stripe — the closest analogue, an operation against a
state machine with no precondition — answers a permanent domain code
(`charge_already_captured`) and is right to. TanStack Query, notably, classifies
nothing at all: it retries queries and by default does NOT retry mutations, and
its answer to a 409 is roll back the optimistic update and `invalidateQueries`.

`transition(id, 'cancel')` states nothing about what the caller read, so the
boundary genuinely cannot tell the two apart. **`@version` is litestone's
`If-Match`** and is what a screen wanting *someone else moved this* declares — it
already answers `VersionConflictError` (409, retryable) carrying both revisions.

The engine-detected race survives where it is real: **across processes**, where
one client's JS lock reaches nothing and the UPDATE's `AND status = <from>`
compare-and-swap is the only authority. Nothing in sierra changes.

`FJS-611` · `packages/litestone/test/transition-race.test.ts`.

### <a id="fjs-d170"></a>2026-09-01 · `FJS-D170` — an announcement means COMMITTED. Held on the transaction, flushed on commit, dropped on rollback.

An event used to be announced at statement time, so a write inside a transaction
that rolled back still reached `$tapEvents` → junction's `announceDataWrites` →
every open tab, and nothing ever retracted it: a screen showed a row the database
does not have, until something unrelated refreshed it. Measured.

Held on the transaction manager now and flushed after `COMMIT`. The buffer takes
a mark at `begin`, so a SAVEPOINT rollback drops exactly the announcements queued
since that savepoint and keeps the ones from before it — the events go with the
rows they describe. Buffered at `fireEvent`, which is the one funnel every
announcement in the package already passes through, so no call site is asked to
remember and a new one cannot forget.

**The cost, stated:** an announcement made inside `$transaction` arrives later
than it used to — after the commit rather than on the statement. That is the
correct meaning and it is the one junction's live layer already assumes; a test
asserting an event immediately after a write inside a transaction is asserting
the artefact.

Sibling of junction's `ctx.afterCommit`, which grew for exactly this reason one
realm up (`FJS-D35`'s neighbourhood) — the Data boundary had no equivalent tier
and now the tier is the transaction itself.

**The cross-process row is not buffered and does not need to be.**
`recordCrossProcess` runs at the top of `fireEvent`, ahead of the queue, because
it writes through the same connection — so it is inside the transaction and a
rollback takes it with the rows it describes, which is the meaning the buffer
exists to give the in-process path.

`FJS-638` · `packages/litestone/src/core/client.js` (`makeTxManager`, `fireEvent`,
`recordCrossProcess`).

### <a id="fjs-d169"></a>2026-09-01 · `FJS-D169` — an unknown `where` key is refused on a READ too. `FJS-D57`'s write half stands; its read half rested on a premise that is not true.

**What `FJS-D57` said and why it was reasonable.** A typo'd filter on a write is
a mis-scoped destructive operation and must reject; on a read it is "merely
empty", so the kind answer is a `did you mean` on stderr and the query runs.
Everything about that is right except the word *empty*.

**What was measured.** A read carrying an unknown key does not run a broader
query, it runs a **different** one. SQLite resolves a double-quoted identifier it
cannot bind as a STRING LITERAL rather than raising, so `{ ownerIdd: 1 }`
compiles to `'ownerIdd' = 1` — two constants — and answers **no rows**. The
caller sees an empty list where the filter never applied, which is
indistinguishable from an empty table. That is the same failure this very
function already refuses to report by warning one reason further down: a
`@computed` key throws precisely because *the alternative is not fewer rows, it
is the wrong rows*. One `describe` block in `litestone.test.ts` held both the
argument and its exception, and the exception asserted `[]` as the expected
answer.

**And the key reached the SQL.** Warning does not drop it, so it is interpolated
into the clause — which makes a crafted key an injection: `id" = 2) OR ("id`
closes the quote, unbalances the parentheses the row policy is ANDed inside, and
hands a scoped caller every row in the table. That is **Invariant 8**, which is
binding, and an invariant outranks a ruling.

**So the read half is reversed and the kindness is kept**: the did-you-mean hint
moves from a log into the error, where the person who made the typo is actually
standing. `$checkWhere` is untouched and is what a boundary that can answer 400
still asks — a refusal and a MESSAGE are two jobs, and only one of them belongs
in the engine. `FJS-D58` (unknown `data` keys are stripped) is a different
question with a different answer — mass assignment — and is unaffected.

**The general form, which is the part worth keeping**: *a rule that fails open
is not softened by a warning, because the warning goes somewhere nobody is.* It
is doubly true for the audience this framework is increasingly written for — a
warning on stderr is not a return value and not an exception, so an agent
writing the app never sees it at all (`IDEAS/provable-enforcement.md` §4).

`FJS-634` · `packages/litestone/src/core/client.js` (`checkWhereKeys`) ·
`src/core/query.js` (`quoteIdent`, the one owner of putting a name in a pattern).

### <a id="fjs-d168"></a>2026-09-01 · `FJS-D168` — a cross-row invariant stays in application code, and the reason is that its moment is the LAST CHILD WRITE. The seal is the one case where something else says *now*.

**The question `FJS-D162` left open and `FJS-D167` was expected to close.** *The
lines sum to `subtotal`* reads a child table, which no `@@check` can see and no
policy can aggregate. `@seals` supplied a moment for free, so what was left
looked like a spelling: `@@check` over an aggregate of a `@sealed` relation,
evaluated in the transition that seals. Filed as `FJS-627` and deliberately not
built alongside the seal, because a red test between a new guard and a new check
is undecidable between them.

**Measured, that shape reaches one of the three known demands.**

| Document | The invariant | State machine | `@seals` | Reached |
| --- | --- | --- | --- | --- |
| `Invoice` | `Σ lines.amount = subtotal` | yes | yes | ✓ |
| `JournalEntry` | `Σ lines.amount = 0`, `count ≥ 2` | **none — no status column** | no | ✗ |
| `Payslip` | `Σ lines where counts = net` | on the PARENT, `PayRun` | no | ✗ |

`basecamp` declares no cross-row invariant at all, so those three are the whole
demand. Two of them do not MOVE: they are written whole inside one transaction
and are frozen from birth by `@immutable` plus `@@gate("5.8.9.9")` /
`@@gate("5.5.8.8")`. `@seals` hands a moment to the one document that happens to
have a state machine, and the two it misses are the two that would gain most from
a declaration — both are written only through `asSystem()`, which is exactly the
writer a JS assertion does not reach and a table constraint does.

**But it is not a *moment* problem, it is a LAST-WRITE problem.** A declared check
reads the child table, so it can only fire once rows exist. All three
hand-written ones read the caller's own array and refuse before the first INSERT
— `postJournal` sums its `lines` argument, `assertPayslipAddsUp` takes a draft
object, `issueInvoice` reduces `args.lines`. Run the declaration against the real
write order instead and it fires on statement one:

| statement | rows in `payslip_line` | the declared check |
| --- | --- | --- |
| `payslip.create({ net: 45000 })` | 0 | `sum = 0`, `net = 45000` → **refuse** |
| `payslipLine.createMany([…])` | 7 | would pass — never reached |

`postJournal` survives that only because it happens to write its lines in a
single `createMany`, for a durability reason it states in a comment — a loop of
`journalLine.create` is a legal way to write the same thing and refuses on line 1
of 4. **A constraint that passes or fails depending on whether the caller batched
is not a constraint.**

**The invoice escapes because `issue` says *don't look yet*.**
`invoice.create({ subtotal: 2400 })` has no lines under it and is not a
checkpoint, because the seal is a later statement the check can hang on. Journal
and payslip can have no equivalent, and the reason is the foreign key: the child
carries the parent's id, so the parent is written first and the last statement is
always a child insert. After every child insert the invariant is legitimately
false until the final one, and nothing in SQL knows which one is final. **Only
the caller knows, and the caller knowing is what a declaration was supposed to
remove.**

**So it is not built, and the two escapes are each worse than the assertion they
would replace.** Bolt a status column onto `JournalEntry` so it can carry a seal
— which is the language shaping the domain, the mistake `FJS-D167` named about
`@immutable` freezing at create. Or defer the check to a commit hook in JS —
which holds against no migration, no seed and no `asSystem().sql`, so every
reason to prefer a `@@check` over an `if` is gone and what is left is a longer
way to write the assertion that is already there.

**`@from` is the neighbouring spelling and it is deliberately the wrong one
here.** `Invoice.subtotal @from(InvoiceLine, sum: amount)` makes the invariant
true by construction with nothing left to check. It also re-derives on every
read, and a document STORES (`FJS-D162`) — `Payslip` copies every figure
precisely so that a later correction cannot reprint history. A live aggregate
takes `@from`; a document takes a frozen column and an assertion beside it.

**What the schema owes a document is the MOMENT and the FREEZE, and it now has
both.** The residual is three assertions in the three functions that are each the
only writer of their own document — `issueInvoice`, `postJournal`,
`assertPayslipAddsUp` — and it is stated rather than hidden, here and in
`packages/litestone/docs/schema.md` § *What a `@@check` cannot say*.

**Reopen on evidence, not on taste**: a fourth demand whose document has a
declarable moment, or a second writer of one of these three that is not the
function above it.

### <a id="fjs-d167"></a>2026-08-31 · `FJS-D167` — a document seals on a MOVE. `@seals` names the moment and `@sealed` names the children, and the sealed set is computed from the machine rather than restated.

**The problem `FJS-D162` left open.** That ruling settled what a document IS —
columns written once, the cross-row invariant checked when it is issued — and
said the check happens "when the invoice moves to `issued`" without saying what a
schema WRITES to mean that. Two halves had no spelling: WHEN a row stops being
editable, and WHICH of its children go with it. `@immutable` freezes at CREATE,
which is a different moment and the wrong one — `IDEAS/billing.md` phase 1 had
already removed `draft` from the invoice for exactly that reason, so the language
was shaping the domain rather than describing it.

**Measured first.** Every writable column on `example`'s `InvoiceLine` is already
`@immutable`, so a line could not be EDITED before any of this. The gap was two
operations and only two: `invoiceLine.create` and `invoiceLine.delete` — the pair
`@immutable` cannot reach, the second of which `FJS-D162` says outright it says
nothing about.

**The ruling: it goes on the MOVE.** `issue: draft -> issued @seals`, in the slot
that already carries `@gate` and `@system`, with `lines InvoiceLine[] @sealed` on
the relation. Three spellings were weighed. On the CHILD (`@@sealedWith(invoice)`)
reads well from the side that pays and cannot say *when*, so it needs a second
declaration anyway. On the PARENT as a predicate (`@@sealed(status != draft)`)
mirrors `@@softDelete(cascade)` + `@keep`, which is real precedent, and duplicates
knowledge `@@transitions` already holds — two sources of truth about one column,
which can disagree. On the move duplicates nothing.

**The sealed set is COMPUTED and this is the load-bearing half.** It is everything
reachable from a `@seals` move's target, so `paid` and `void` seal without being
named and a move appended to the tail of the machine seals by arriving. A one-hop
reading passes every behavioral test and leaves a document editable in two of its
three terminal states. A machine that comes back OUT of a sealed state is refused
at parse — a document that unseals is not a document — and a second `@seals` on a
move FROM an already-sealed state is refused separately, because that one seals
nothing and the reader believes it does.

**`@sealed` is explicit and may never be inferred.** Every child relation on a
sealing model looks sealable and they are not: a payment against an issued invoice
is exactly the row that must keep arriving.

**`@immutable` changes meaning on a sealing model, and that is the price.** It
means *frozen at the seal* there — scoped by the declaration, so a model with no
`@seals` move is untouched. Two consequences follow. The refusal moves out of the
payload into the WHERE, because the answer is now in the ROW; and it stops being
`readOnly` in the update schema, since no schema can answer it — the field carries
`x-litestone-kind: 'immutable-until-seal'` with the state column and the sealed
set instead, and a form resolves it off the record it is editing.

**`asSystem()` does not lift it.** This is where it parts company with
`@@transitions`, which `asSystem()` bypasses entirely: a gate is about who is
asking, a seal is about what the row IS. It sits with `@immutable`, `@check`,
`@@check` and `@@arc` (`FJS-519`).

**A bulk write filters rather than throwing**, as it already does for a row policy
and as `updateMany` already does for a transition. The direction it fails in is
the safe one — the rows are not written — and inventing a per-row diagnosis for a
method whose answer is a count is a different feature.

**Deleting the document itself is out of scope and deliberately so**, for the
reason `FJS-D162` gives about DELETE: whether an issued invoice may be removed is
a question about who may remove it, which `@@gate` already answers. `@sealed`
governs the children a document is MADE of; adding a row-level delete refusal
here would be a second rule about the same question, decided in a different
place.

**What this does NOT do.** The cross-row check at the seal — *the lines sum to the
total* — is not built. `@seals` hands it its moment for free and that is the point
of the shape, but it is its own feature and its own ruling; building both at once
makes a red test undecidable between them. Filed as `FJS-627`, and ruled
there: it is not built ([`FJS-D168`](#fjs-d168)) — two of the three known
demands have no declarable moment. The client-side
affordance is `FJS-628`: the seal reaches sierra's field rules and no form reads
it yet, which is a box that looks writable and 409s.

**Where it lives.** `packages/litestone/src/core/seal.js` is the one owner of
*which states are sealed* — three readers ask it and a second walk is how they end
up disagreeing about `void`. The guards are in `client.js` beside
`applyTransitionWhereClause`, composed the same way. `docs/modeling.md` § `@seals`,
`access.snapshot.md` (a **Seals** column and the relation list), and the release
surface, where gaining either half is a **contract**.

### <a id="fjs-d164"></a>2026-08-30 · `FJS-D164` — effective-dated reference data is a ROW WITH A WINDOW, and the thing that consumes it names the version rather than the parent.

**The problem.** A price that changed in March must not reprice a subscription
sold in February, and there are three ways to arrange that. Copy the price onto
the subscription at the moment of sale, the way `Order` copies its nine
columns. Keep the price on the plan and a *changed on* date beside it. Or make
the price a row with a lifetime and have the subscription point at THAT row.

**The ruling.** The third. `Plan` is what is on offer; `PlanVersion` is what it
cost over a window (`effectiveFrom`, nullable `effectiveTo`); `Subscription`
names a `PlanVersion` and never a `Plan`.

**Why not the copy**, which is what this app already does everywhere else: a
copy is right when the thing copied is a fact about one moment — what was
charged, what the tax rate was, what the item cost — and it is wrong here
because a subscription is charged AGAIN next month and has to charge the same
amount. The copy would have to be re-read on every renewal to know whether it
is still the right one, which is the version table with the history thrown away.

**What it costs, and each cost has a spelling.** The open window is the state a
price is in for almost all of its life, so `effectiveTo` is nullable rather than
dated far in the future — a row saying 2099 reads as a decision somebody made.
*At most one open window per plan* was then not expressible — two NULLs never
compare equal and `@@unique` took no predicate — which is
[`FJS-603`](ISSUES.md#fjs-603), **closed 2026-08-31**:
`@@unique([planId], where: effectiveTo == null)`. It is a table constraint now
rather than a rule in a service, so a seed, a migration and `asSystem()` are each
held to it. The service that closes a window and opens the next in a single
transaction is still what makes the second write legal, and it still REFUSES a
plan holding two rather than picking one — for a database written before the
constraint existed. A price is `@immutable`, so raising one is never a PATCH.

**What it buys is a screen that can say it.** *Repricing moves nobody* is an
assertion a drive can make — the new window has no subscribers and an older one
still does — where under a copy it is a property of code nobody can see.
`Plan.currentPrice` is `@from(PlanVersion, max: price, where: "effectiveTo IS
NULL")`, so *what does this cost today* stays one query and no join a screen
writes. The cost of THAT is the hazard in root `CLAUDE.md` § UI: a derived
column moves when a child row is written and nothing announces the parent.

Built in `example` (`db/schema.lite`, `plans.reprice`), proven by `verify` and
`verify:site`. The general question — whether the language should know about
validity windows rather than an app arranging them — is candidate A's temporal
gap and is not ruled here.

### <a id="fjs-d166"></a>2026-08-30 · `FJS-D166` — payroll goes into `example/` rather than a fourth app, and the argument is the shared LEDGER. Two apps would be two implementations of the one invariant this domain exists to prove.

**The problem.** `example/` is a Shopify-shaped thing and payroll is not shopping,
so a second proving ground looked like the tidier answer. Taken 2026-08-29 in
`IDEAS/proving-grounds.md` § *Where A lives*, to be recorded here once the first
model landed; it landed in phase 1 and this is nine phases overdue.

**The ruling.** One app. `example/` was never really a shop — it is a BUSINESS,
and it had been drifting that way since it grew a fleet of tenants, a payment
provider it signs to, an inventory ledger, and a receipt copied at the moment of
sale. A business that sells things also employs people, and the two halves meet
at a general ledger: an order posts a journal, a pay run posts a journal, and
`Σ lines = 0` is the cross-row invariant both need. **In two apps that is two
implementations**, and the second one is the one that drifts.

**What it bought, measured rather than predicted.** `api/src/ledger.ts` has two
callers and one balance rule; `allocate` has two callers from opposite ends —
billing splits a period across seats, payroll splits a year across periods — and
`verify:proration` and `verify:payrun` assert the same function from both. Six
models earned their place by carrying a wall; the budget was eight models and
three enums and it was not exceeded.

**What it cost, and the estimates were low.** The schema went 23 → 31 models
as predicted. The drives did not: the estimate was *at least three of its own*
and the answer is **five**, 250 assertions, because the console and the batch
each turned out to need one nothing else could give. And the shared database
grew a hazard nothing anticipated — a drive that leaves a paid pay run behind
makes every later drive's arrears computation wrong, since a correction is a
function of every paid period rather than of what changed. That is what
`web/test/payroll-sweep.mjs` exists for, and it is the price of one app rather
than two, paid once.

**The counter-argument that did not survive.** *A newcomer can hold `example/` in
their head* was the real objection, and the answer is that holding it is a
function of how the domain is DIVIDED rather than of how many models there are:
payroll is five files under `api/src/` with one job each, and a reader who never
opens them is unaffected by their existence.

### <a id="fjs-d165"></a>2026-08-30 · `FJS-D165` — a recurring schedule's DEADLINE is a comparison against a document's own date, never a counter on the row. The queue owns *try again*; the deadline is not the queue's to own.

**The problem.** Dunning is *keep trying, and give up on day 21*. Both halves
look like retry, and a queue already does retry — so the obvious arrangement is
a `failedAttempts` column that the job increments and compares against a
maximum.

**The ruling.** No counter. *How long has this been unpaid* is `now − dueAt` on
the oldest unpaid invoice — two columns that are already frozen on a document
([`FJS-D162`](#fjs-d162)) — and the states in between are declared moves on the
subscription, not arithmetic.

**Why.** A counter is a second answer to a question the rows already answer, and
the two disagree the first time anything runs twice: a cron that fires in two
replicas, an operator re-running a half-finished sweep, a retry after a crash.
Under the comparison, running the job twice at one instant is the same answer
by construction, and `verify:billing` asserts exactly that. A counter also has
to be RESET, which means every path that settles an invoice — a webhook, a
member of staff, a bank transfer somebody reconciled — has to know the
subscription had lapsed. Under the comparison none of them does: the ledger
comes clean and the next dunning pass recovers it.

**What the queue keeps.** A transport failure — the provider unreachable, a
timeout — throws, and caravan's ladder is exactly right for it. What must not
be given to the ladder is a DOMAIN answer: a decline is returned as a value, so
it exits the ladder successfully, which is why the deadline cannot live there.
That split is also what makes the gap in [`FJS-610`](ISSUES.md#fjs-610)
visible as a gap rather than as a bug.

**The clock is a parameter, not a mock.** `dunSubscriptions({ at, subscriptionId })`
takes the instant to grade at and the row to grade, and both are an operator's
parameters before they are a drive's — *re-run dunning for this customer, I have
just taken their payment by hand* is a real request. The cron passes neither and
gets now and everybody, which is what keeps it one code path rather than a
`force` flag proving nothing about the other.

Built in `example` (`api/src/jobs/dun-subscriptions.job.ts`), proven by
`verify:billing`.

### <a id="fjs-d162"></a>2026-08-30 · `FJS-D162` — a DOCUMENT is a row whose columns are written once and whose invariant is checked at the moment it is issued. Two features, one shape, and neither needs a rule that can see the old row.

An invoice is the case: once issued it does not change, a correction is a credit
note rather than an edit, and its lines must sum to what was charged. Both were
filed as language gaps in `IDEAS/billing.md` § Phase 1 and both were narrower
than that. **Nothing in the seed can compare the stored row to the incoming
one** — `@@check` and a `post-update` policy each see the row as it would be, an
`update` policy sees it as it is — and the answer is to need neither.

**`@immutable` is a COLUMN and it refuses the KEY, not the value.** An update
payload naming an `@immutable` column is refused by name, exactly as `@system`
is refused by name; there is no comparison, so there is nothing to fetch and
nothing to race. It is the column tier rather than the row tier because a
document still has to MOVE — an invoice goes `issued → paid`, and a row-level
freeze then has to carve out the one column `@@transitions` governs, which is a
rule with an exception where this is a rule. `number`, `issuedAt`, `total` and
`currency` are `@immutable`; `status` is not, and `@@transitions` already says
what may happen to it.

**It is the CONSTRAINT tier, so `asSystem()` cannot drop it.** This is the half
that decides whether the feature is worth having: the renewal job, the payment
settler and every migration run as system, so a rule the system may drop is a
rule absent from every caller that actually writes invoices. It therefore sits
with `@check`, `@@check` and `@@arc` on the short list of things `asSystem()`
does not bypass (`FJS-519`), and against the gate, the row policies and
`@guarded`, which it does. A raw `UPDATE` still bypasses, as it does for a
`@check`; making it survive that means a trigger, which is available — FTS emits
five per model and only `@updatedAt`'s was retired, for a clock reason of its
own — and is not taken now, because a trigger is also what stops anyone ever
repairing a bad row.

**The cross-row invariant is checked at the TRANSITION, and the freeze is what
makes once enough.** *Lines sum to the total* reads a child table, which no
`@@check` can do and no policy can aggregate. Checking it continuously means
enforcing on four write paths — a line inserted, updated, deleted, and the header
updated — which in SQLite is triggers on two tables. Checking it **when the
invoice moves to `issued`** costs one evaluation, and the columns are frozen
immediately after, so there is no drift to catch. A draft that does not add up is
legal, which is what a draft is.

**The lines freeze with the parent.** A line whose invoice is frozen is frozen,
and a line inserted against an issued invoice is refused. Without that the sum
drifts after the one moment it was checked and the paragraph above is worth
nothing. The cost is stated: a write to a line must read its parent's state, so
the child's rule is not local the way `@immutable` on a column is.

**What is NOT ruled here, and each is cheaper to answer against real code.**
What spells *check this at this transition* — an argument on `@@check`, an
argument on `@@transitions`, or a third attribute. Whether `@immutable` refuses
a DELETE, and how it reads against `@@softDelete`, whose stamp is a write to the
row. Which error class and status a refusal carries. And whether the parent read
the cascade needs is one query or a correlated condition on the child's own
write. `IDEAS/billing.md` § Phase 1 is where they are reached.

### <a id="fjs-d154"></a>2026-08-30 · `FJS-D154` — allocation is a pure function over minor units. There is no Money value object, the remainder goes to the largest fractional part, and nothing in the seed hands an allocator out.

`FJS-D142` made storage exact and stopped there deliberately: it does not decide
round-half-up against banker's, and it does not decide which line of a split bill
gets the leftover penny. Billing is what makes the second one urgent — proration
is a third of a monthly price split across lines that must sum to what was
charged, which is allocation and nothing else — so it is ruled before the first
model rather than after the first drive.

> `allocate(amount, ratios) → number[]` and `roundMinor(value, { mode })`, in
> `@frontierjs/toolbelt/units`, beside `formatMoney`, `toMinor` and `fromMinor`.
> Integers in, integers out, and the parts sum to `amount` exactly.

**Two functions rather than one, and building it is what separated them.** A
rounding mode belongs to a MULTIPLICATION — a rate applied to a base, where
there is a real disagreement about ties — and a remainder belongs to a SPLIT,
where the only requirement is that the parts add up. Putting the mode on
`allocate` would have offered a knob that changes nothing: the distribution
floors every share and hands out whole units, so no tie is ever rounded.

**No wrapper, against every prior art.** Fowler's `allocate`, Rails' `Money` and
`py-moneyed` all keep allocation on a value object, and the wrapper is what makes
the arithmetic total — you cannot add a Money to a bare number by accident. The
cost is what settles it here. `@money` stores an integer and litestone answers
one, so a wrapper is wrapped on every read and unwrapped on every write, at every
boundary an app already has: JSON on the wire, a form control, an `@@check` the
database evaluates, a `SUM` litestone compiles. `FJS-D142` ruled that the schema
must not imply a value object exists; a kit that ships one makes the schema's own
integer the odd spelling out. What the wrapper buys is bought here by everything
in scope already being minor units of one column's currency.

**The leftover goes to the largest fractional part.** A split rarely divides
evenly, and the unit has to land somewhere or the parts do not sum to the whole —
which is the one thing this function exists to guarantee. Largest-remainder is
Fowler's answer, it is fair by size rather than by position, and it is
deterministic given the ratios, so two runs and two machines agree. Ties break by
position, because a rule that leaves them open is a rule that produces two
receipts for one basket.

**Half away from zero, and the mode is a per-call option on `roundMinor`.** The
default is what `example/api/src/domain/shop/pricing.ts` did in its own `roundCents`, which
is now an alias of this, and what a person checking the sum on paper expects — `Math.round` alone breaks ties towards
positive infinity, so a negative would round the other way from its positive
twin. It is overridable rather than fixed because banker's rounding is required
of tax in several jurisdictions, and an app that needs both needs them in one
process: a module-wide constant would make the second one unreachable. Per call
and never global, so a reader of one line can see which rule produced it.

**Nothing in the seed reaches it, and there is no scale to pass either.** This
row was filed as *a pure function over `(amount, ratios, scale)`* and the third
argument did not survive being written: the smallest thing a split can hand out
is one of whatever `amount` is counted in, and a caller holding an integer has
already decided that. A `scale` parameter would have been inert, which is worse
than absent. Litestone could still hand out a column's declared scale, and a
step past that a pre-bound allocator; both stay declined, because a rounding
policy is not a fact about a table and an allocator returned by the Data
boundary is a policy the Data boundary appears to own. What an app names twice
is the currency — once in the schema, once where it formats — and that was
already true of `formatMoney`.

**What this does not rule.** Where an application puts the call is the
application's — `example` has no proration and therefore no caller for
`allocate` yet, and `pricing.ts` uses the rounding half alone.
More than nine places is `FJS-575`, and it is a feature about the JS boundary
rather than about allocation: reaching Stripe's twelve places means BigInt at the
wire, which `type: 'integer'`, the form controls and `pricing.ts` all assume away.

### <a id="fjs-d155"></a>2026-08-29 · `FJS-D155` — how long to wait for the write lock is a fact about the PROCESS, so `busyTimeout` is a `createClient` option and an env var, and there is no `database { }` spelling (`FJS-569`).

**The question.** `busy_timeout` was a literal 5000 in litestone with no way for
an app to change it. Three homes were candidates: `createClient({ busyTimeout })`,
`database { busyTimeout }` in the seed, and an environment variable.

**The ruling is option → env → default, and the seed is refused.** The seed is
the one owner of what the data IS. How long this process is willing to sit
blocked waiting for a different process is not that — it is a property of who is
asking. The same `schema.lite` is opened by an API answering a person, which
cannot afford five seconds, and by a queue draining a batch in its own process,
which can afford thirty and would rather wait than retry into the same
contention. A declaration is one answer to a question whose right answer differs
by caller, which is the same reason a relative `database { path }` resolves
against the working directory rather than the schema: **code is written against
the process.**

The env var (`LITESTONE_BUSY_TIMEOUT`) is not a convenience — it is the only
channel for the callers that construct no client and are the ones that most want
a different number: the CLI, a migration run against a live database, a worker
started by a supervisor that can set an environment and cannot pass an option.

**Per-database is part of the ruling, not a later refinement.** `{ default,
<db> }`, because the database this came from wants the opposite answer to main:
an audit `logger` index write is fire-and-forget and its failure is swallowed by
design, so spending the loop's next five seconds to place a row nobody awaits is
strictly worse than dropping it. `{ audit: 250 }` is an app saying so. A key
naming a database the schema does not declare is refused by name at
`createClient`, because a dropped key is a database silently keeping the default.

**What this does NOT do is make contention safe, and the number cannot.**
`bun:sqlite` is synchronous, so the wait is a bound on how long ONE call blocks
this process's event loop — a bigger number is a longer stall, and in-process it
is a deadlock that a bigger number makes worse (measured: two connections on one
file, the waiter blocks the loop, the holder's release timer never gets a turn,
the wait expires in full and only then does the holder commit). The in-process
answer is structural and stays structural: `$transaction`'s FIFO lock, one client
per file per process, and a worker thread or a second process for work that is
genuinely long. `packages/litestone/docs/concurrency.md`.

Lives in `packages/litestone/src/core/pragmas.js` — one owner for the resolution
and the pragma, read by every site that opens a connection. `@frontierjs/caravan`
and Junction's SQLite cache take their own option for the connections they own.

### <a id="fjs-d152"></a>2026-08-26 · `FJS-D152` — litestone's clock has ONE owner and it is the client. The `@updatedAt` trigger is retired, and `@updatedAt` stops covering a raw `UPDATE`.

`createClient({ now })` reached `now()` in a row policy and `@@softDelete`'s
stamp. `@default(now())` was a column DEFAULT, `@updatedAt` an AFTER UPDATE
trigger, the retention cutoff a bare `Date.now()` — three clocks in the database
and one in JavaScript, and the option was named as though it owned all four. So
a suite frozen at 2020 got a row stamped today, and **the one thing a frozen
clock is for — a row aging past a window — could not be staged at all.**

The conservative option was to bind the value in JS only when a clock is
injected, leaving the trigger as the floor. **Measured, and it is the worse of
the two.** The trigger's guard is `WHEN NEW.x IS OLD.x`, which reads as *fire
whenever the value being written equals the one stored* — and under a frozen
clock that is every write after the create. `update`, `updateMany` and `upsert`
each came back stamped 2020 with the database holding today. That is `FJS-396`'s
shape (RETURNING is evaluated before an AFTER trigger, and junction hands that
row to the HTTP response *and* the `svc updated` broadcast), so naming the column
in the SET clause had only ever closed it **while the two values differed**. The
conservative variant is *more* exposed, not less: it only ever runs with a clock
injected, which is exactly the case where they are equal.

So the trigger goes. Everything litestone writes reads the client's clock —
`@default(now())` and `@updatedAt` on create through the generated-default map,
`@updatedAt` on update through `stampSets`, plus the retention cutoff on both the
SQLite and jsonl passes. `FJS-396` closes at the root rather than being narrowed
a second time.

**The price is a floor that is no longer symmetric, and it is the ruling.** The
column DEFAULT stays, so a raw `INSERT` still stamps; a raw `UPDATE` does not.
`@updatedAt` is a client stamp now, and a hand-written statement, a JS migration
or a `db.asSystem().sql` owns its own. That is the correct trade because the
alternative is a stamp that cannot be tested: a mechanism inside SQLite is one no
suite can move, and a framework whose timestamps are unreachable from a test is a
framework whose time-dependent behavior is asserted nowhere.

Two things are stated rather than left implicit. **Upgrading is one generated
statement** — pristine stops carrying the trigger, `droppedTriggers` in
`migrate.js` already walks for it, `DROP TRIGGER IF EXISTS` with no table
rebuild. And **one clock is still not achievable**: a raw statement reads
SQLite's, and a `@derived` expression using `now()` is compiled once at startup
into a subquery with no parameter to bind. Both are named in the docs rather than
presented as covered.

`FJS-531`.

### <a id="fjs-d142"></a>2026-08-25 · `FJS-D142` — exact numbers are `Int @scale(n)`, money is `@money(currency)` on top of it, and the minor-unit table is the platform's rather than ours.

`.lite` has eight scalar types and nothing between `Int` and `Float`, so every
app models an exact quantity as a float and hopes. The 188-model OpenMRP fixture
holds **95 decimal columns and zero currency columns**, which is what settles the
order: `@scale(n)` is the feature and `@money` is a step on top of it, because
building money first gives something that cannot express 88 of the 95.

**`Int`, not a `Decimal` scalar, and the prior art is unusually direct about it.**
SQLite has no column widths, so the `p` of `decimal(p, s)` emits an identical
column and only the scale is load-bearing. And the sibling that HAS the type does
not have it working: Prisma ships `Decimal`, and on SQLite its own maintainers
record that there is no reliable way to store one — values are written and read
back different (`prisma#20635`). `Int @scale(n)` is not the poor relation here;
on this database it is the only spelling that is exact.

**The scale of money is declared by the currency and the table is already in the
runtime.** Measured: `Intl.NumberFormat(…).resolvedOptions()` answers 2 for USD,
**0 for JPY**, 3 for KWD, 0 for CLP, 3 for BHD — ISO 4217's minor units, shipped
with ICU and updated with it. So `@money(JPY)` derives scale 0 with **no table in
this repo to maintain**, which is the objection that kept `@money` from being its
own attribute rather than an alias. Stripe publishes its zero-decimal list as
prose and every client library hardcodes a copy that goes stale; there is nothing
to copy here.

**The aggregate argument is retired, and the replacement is narrower and true.**
`IDEAS/declared-semantics.md` justified the feature by exact summation. SQLite's
`sum()` over `REAL` is Kahan–Babuška compensated — measured on 3.51.2, `SUM(REAL)`
matched `SUM(scaled INTEGER)` exactly at 5,000 rows of 2-dp and 20,000 rows of
6-dp, and `sum(1e100, 1, -1e100)` answers `1` where naive accumulation answers
`0`. What survives measurement is **multiplication** (`0.1 * 3` is
`0.30000000000000004` in SQLite and `= 0.3` answers 0), **threshold comparison**,
and **the JS boundary**. That is not a weaker case: it is exactly the shape of
the fixture's 88 non-money decimals, which are quantities multiplied by rates and
then compared to each other to raise a purchase order.

**What comes back in JS is the integer.** Every prior art returns an exact thing —
Rails a `Money`, Prisma a `Decimal`, Django a `Decimal`, Stripe an integer — and
**none of them returns a float**. An earlier draft here proposed reading back
`1.5`, which would put the drift back at the boundary the column exists to move it
off, and would make `price Int @money(GBP)` a column the Data boundary happily
adds to a float, contradicting the opening promise of the feature. `formatMoney`
(`@frontierjs/toolbelt/units`) is the read path and already turns on the same
currency-declares-scale fact (`FJS-440`).

**Rounding and allocation are NOT declared, and saying so is part of the ruling.**
`@scale` makes storage exact and refuses a float at the boundary. It does not
decide half-up against banker's, and it does not decide which line of a split bill
gets the leftover penny — Fowler's `allocate` is a value-object concern and every
prior art keeps it there. `example`'s `api/src/pricing.ts` keeps its own rounding;
what changes is that the stored column can no longer disagree with it. A Money
value object is a separate question with a separate home (toolbelt, beside
`formatMoney`), and one file must not promise both.

**Storing a Money as JSON TEXT stays retired** (`packages/litestone/docs/roadmap.md`):
`opaqueSortKind` classifies a `Json` column as opaque, so `$checkOrderBy` throws
on it, and a price nobody can sort, group or sum is not a price column.

**BUILT 2026-08-26.** `Int @scale(n)` and `Int @money(CUR | field: col | )`,
refused at parse for a non-`Int` type, an array, both attributes together, more
than nine places, a `field:` naming nothing or naming a non-`String`, and — the
one that matters most — **a currency this runtime does not know**. That last
refusal is only possible because `Intl.supportedValuesOf('currency')` exists:
`Intl.NumberFormat` does NOT throw on an unknown code, it answers two decimal
places, so `@money(UDS)` would have taken a plausible scale and been wrong by a
hundred wherever the real currency has none. Both facts come from ICU and
neither is a table this repo ships.

The value of the feature turned out to be concentrated in **one refusal at the
write**: a fraction is now `must be a whole number of minor units of USD — 12.99
is 1299`, where it used to be SQLite's `cannot store REAL value in INTEGER
column line.total` — true, about a physical column, and no use to the person who
just typed the price. Storage, DDL and the JSON type are all unchanged;
`x-scale` and `x-money` travel beside `type: 'integer'`, and the `field:` form
deliberately resolves no scale, because it is not knowable from the schema.

**One open item closed itself.** *The column's own name* — `cents Int @money`
reading back `12.99` — was to be refused at parse. Under the ruling the stored
value IS the integer, so `cents` reading back `1299` is honest and there is no
mixed spelling left to refuse. The rule was an artefact of the float-returning
draft.

Open and deliberately not settled here: **per-row currency**, where `example`'s
`Payment` already holds `amount` beside `currency` as two columns nothing pairs —
prior art is unanimous that this is two columns and one declaration
(django-money's `MoneyField` creates exactly that pair), so the shape is
`@money(field: currency)` rather than a composite type; **the column's own name**,
where `cents Int @money` reading back major units is how a price gains two zeroes,
and money-rails' `_cents` suffix convention is the evidence that the naming rule
has to be enforced rather than documented; and **changing `n`**, which is the one
migration here that rewrites stored bytes.

### <a id="fjs-d143"></a>2026-08-25 · `FJS-D143` — the seed declares what KIND of time a column holds, as an attribute. `DateTime` keeps its name, and a zoned comparison is a window the framework binds and never a predicate SQLite evaluates.

Three independent designs — java.time, Noda Time and TC39's Temporal, which
reached **Stage 4 in March 2026** and is ES2026 — converged on the same
distinctions: an instant, a plain date, a plain time, and a wall clock bound to an
IANA zone. That convergence is the vocabulary; this repo adopts the distinctions
and does not re-derive them.

**`DateTime` keeps its name, ruled 2026-08-25.** The alternative argued for was
`Instant`, on the strongest prior-art lesson available: Postgres's `timestamptz`
sounds like *a timestamp with a timezone* and stores an instant with no zone at
all, and being named for something other than what it stores is the most expensive
naming mistake in the field. `DateTime` has the same flaw — it reads as a wall
clock and holds an instant. **The name stays anyway**, because it is what every
reader of a Prisma-shaped schema already types, and because the flaw only becomes
a trap under a particular follow-on.

**So the kind is declared by ATTRIBUTE and not by a family of types, and that is a
consequence rather than a second decision.** `Date`, `Time` and `DateTime` as
siblings would read as *wall clock, wall clock, and the two composed* while the
third is an instant — `timestamptz` rebuilt inside `.lite`. Keeping the name
therefore rules out the type route: what a column holds is said beside the type,
not by it. Revisit is a real option and it belongs with a second app, not with
this ruling.

**Whose zone resolves it — all three answers now have homes, and none of them is
new machinery.** The row's is a sibling column. The viewer's is a claim on the
principal, the seam `sessionFields` and `toDataPrincipal()` already are. The
tenant's is `$.config`, ruled the same day (`FJS-D126`), where a timezone is one of
the named examples. The design's job is to say which, per column; the plumbing for
each already exists.

**A zoned comparison can never be a SQL predicate. Measured.**
`datetime('now','America/New_York')` in SQLite answers **NULL** — not an error, a
NULL, which a policy compares against and matches nothing, returning an empty
screen with a 200. `'localtime'` is the *process's* zone and never the caller's;
a fixed offset works and is not a zone, because it cannot survive a rule change.
So *rows from today in the viewer's zone* is expressible only as a window the
framework computes and binds: measured on three rows, "today" is 2, 2 or 1 of them
depending on the zone the window came from.

**That is not a new principle here, which is what makes it cheap.** `now()` in a
policy is already the framework's clock — resolved once per evaluation, injectable
through `createClient({ now })`, reaching the WHERE, the create-policy evaluator
and `@@softDelete`'s stamp — and SQLite's own clock is already refused inside a
`$raw` predicate because its format disagrees with litestone's (`FJS-226`). A
zoned window is `now()` with a zone argument, and it inherits the ruling that
brought it.

**The implementation is `Intl` and roughly twenty lines, and this must not become
a date library.** Measured: wall clock plus IANA zone resolves to **0, 1 or 2
instants** using `Intl.DateTimeFormat.formatToParts` alone — `2026-03-08T02:30` in
`America/New_York` is 0 (the hour does not exist), `2026-11-01T01:30` is 2 (the
hour happens twice), everything else is 1. That is Temporal's own
`disambiguation` vocabulary, available today. Bun does not expose `Temporal` yet
(JSC is still implementing it; Node 26 ships it unflagged), so the storage
encoding should be **Temporal's own string forms**, which round-trip when it
arrives: an instant is what `DateTime` already stores, and a zoned value is
`2026-11-01T01:30:00-04:00[America/New_York]` — wall clock, resolved offset and
zone, where the offset is what separates the two 1:30 AMs. `File` is the in-tree
precedent for a declared type carrying a compound TEXT encoding.

**A zoned column sorts by wall clock, and `$checkOrderBy` must say so.** Measured
across zones: lexical order of that stored form puts London 09:00 (08:00Z) before
Kolkata 09:00 (03:30Z), which is wall-clock order and not the timeline. It is a
third answer beside *no such field* and *opaque* — sortable, but not by the thing
the caller probably means — and it is the `@computed` shape: state the limit
rather than return a plausible wrong order.

**Refuse the general RRULE, confirmed by the field rather than by taste.** RFC
5545 is a 200-page specification whose implementations disagree in practice —
negative `BYSETPOS`, `BYSETPOS` under sub-daily frequencies, vendors stricter in
some places and looser in others. Temporal spent nine years on time and **left
recurrence out**. Whatever subset earns a name here, the whole grammar does not.

An IANA name is the only spelling a zone may take. `Intl.supportedValuesOf('timeZone')`
answers 445 of them in this runtime, so an unknown zone is a **parse error** rather
than a runtime NULL — and `systemd.time`'s own documentation gives the reason to
refuse the alternative: with a local abbreviation it is possible to specify
daylight saving in winter.

### <a id="fjs-d130"></a>2026-08-23 · `FJS-D130` — a `@@unique` naming a nullable column is refused, and `nullsDistinct: true` is how a schema says it meant it. Composite only.

Two NULLs never compare equal, so a UNIQUE index admits `(1, NULL, NULL)`
twice. Measured on a real client: two identical creates both succeeded and the
model held two rows, while the same pair with values was refused by SQLite. The
constraint works exactly where it was never in doubt and fails exactly where a
caller relies on it, and nothing at any layer says so — the DDL emits the index,
the write succeeds, and the second row shares the shelf (`FJS-437`).

**Refused at parse, beside the `@encrypted` one**, which is the neighbouring
cause and the same shape: a constraint that is declared, built, and can never
fire. A partial index is not the answer, for `FJS-204`'s reason — it makes the
constraint false for any read that includes the NULL rows — and neither is an
expression index over a sentinel, which is unsound the first time a real row
holds the sentinel.

**COMPOSITE only, and the asymmetry is the ruling rather than an exemption.**
On one optional column `@unique` has a single reading — unique when present —
and every SQL developer already holds it; two of this repo's own columns are
that shape (`ProductVariant.barcode`, `Cart.handoffCode`) and both are correct.
On a tuple the reading is the tuple. The shape that surfaced this was
`@@unique([product, color, size])`, where the no-color/no-size variant is
precisely the row a shop lists twice.

**The opt-in is SQL's own word for what SQLite does.** Postgres 15 spells the
choice `UNIQUE NULLS DISTINCT | NULLS NOT DISTINCT`, and SQLite is permanently
the first; `@@unique([a, b], nullsDistinct: true)` therefore states the
behavior the schema is getting rather than naming an escape hatch. It changes
no emitted SQL — it is a statement, not a knob — which is what makes it safe to
require: the index a schema had before the declaration is the index it has
after.

Both in-tree cases were legitimate and both now declare it: basecamp's
`User @@unique([accountId, username])` wants one username per account and no
constraint between people who have neither, and litestone's own
`DailyStat @@unique([date, accountId])` leaves the all-accounts row
unconstrained. Neither had said so, and neither reader could have known.

### <a id="fjs-d120"></a>2026-08-22 · `FJS-D120` — a value set is a NAME for a scoped list, and `@values` is a second declaration about a column, not a replacement for `@relation`.

An app fills a picker from four places and only two had a home in the seed: a
fixed list is an `enum`, a list of rows is a `@relation`. A list the ACCOUNT
edits and a list the USER edits had no declaration at all, so each became a
hand-written service, a hand-written control and a hand-written validation rule,
once per list.

They are one noun with four provenances. A system that treats them as four ends
up with four mechanisms that disagree at the edges.

**Two of the four need no new syntax, and that is the first result of taking the
question seriously.** An `enum` plus `@label` on its members is already a
complete literal set, and it is `required` by construction — a CHECK constraint
on the column. There is no such thing as an extensible enum: *the list this app
ships plus the ones this workspace added* is a table, not an enum. And an
account-editable list in a row-tenant app is already scoped, because
`tenancy { strategy row }` desugars into a `@@deny` and a stamp — *this
workspace's tags* is just *all rows of `Tag`*.

So what was missing is a **name for a scoped list** and a **strength**:

```
valueset TaskTag  { source Tag }                    // tenancy scopes it
valueset Assignee { source TeamMember scope active } // @@scope does
```

`scope` names an existing `@@scope(name, expr)` rather than inventing a second
scoping language, and `where` is the literal escape hatch beside it.

**`@relation` is untouched and `@values` sits beside it, because they are two
facts about one column.** Storage is a foreign key with referential integrity;
resolution is *where do the offered values come from and what is legal*. That is
the same split `resource.options()` already proved by treating an enum and a
relation identically at the seam while they stay entirely different in the
database. Folding them into one declaration would have blurred the distinction
ServiceNow's scar is about — never reference a choice row, because rows get
deleted and replaced and the ids stop meaning anything.

**Strength goes on the BINDING, never on the set.** FHIR has the reason and it
is not stylistic: one list is legitimately enforced on one field and merely
offered on another — a `Country` set is required on a shipping address and
suggested on *where did you hear about us*. A strength on the set cannot say
that without a second set holding the same values.

| | an unknown value | it joins the set |
| --- | --- | --- |
| `required` *(the default)* | refused, 400, field-level | — |
| `open` | accepted | yes, a row is created |
| `suggested` | accepted | no |

**Unstated means `required`** — fail-closed, the same posture as `@@gate`. The
other default accepts typos in silence, and `Gooogle` in a grouping report is
found six months later or never.

**The weak strengths are the point, not a concession.** Without them an author
whose list is genuinely open drops the declaration and writes a plain `String` —
and then gets nothing: no picker, no labels, no options endpoint, no validation,
no `@@label`. The list still exists in their head and nothing in the system
knows about it. A weak binding beats no binding, because **the list still travels
even where it is not enforced**.

`open` rather than FHIR's `extensible`: theirs means *use a suitable code from
the set if one exists*, a semantic-coverage rule for humans. Borrowing the word
for a create-a-row mechanic would mislead everyone who knows the original.

**Who may extend an `open` set is answered by not answering it.** The create
goes through the caller's own scoped client, so the target model's `@@gate` and
`@@allow` decide — the rules already written. No permission concept, no hook
tier, no option. A viewer who may not create a `Tag` gets the picker and a
refusal on a new value, which is the honest answer and needs no code.

Two axes are deliberately NOT in this: a per-caller ORDER (`FJS-D121`) and
DEPENDENT sets (`FJS-D122`). Both are wanted; neither is folded in here, because
fusing membership with order is the failure this shape exists to avoid — a
*suggested* binding and a *suggested* order are different sentences, and a system
with one word for both cannot say *anyone may be assigned, but show me the three
I actually use*.

*Lives in:* `IDEAS/value-sets.md` · not built — `FJS-412`.

### <a id="fjs-d39"></a>2026-08-18 · `FJS-D39` — There is no `@@history` block, and the seed will not grow one.

(From the argument that produced `FJS-341` and `FJS-342`.)

The proposal was a fourth axiom — *one history* beside one origin, one name, one
owner — realized as a model-level declaration:

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

### <a id="fjs-d54"></a>2026-08-17 · `FJS-D54` — Litestone has atomic update operators, and the COLUMN decides one is an operator at all (`FJS-D27`).

`increment` `decrement` `multiply`
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

### <a id="fjs-d55"></a>2026-08-16 · `FJS-D55` — A write announcement has two shapes, and the write says which (`FJS-307`).

`scope: 'row'` — one row changed, `result` is it, or `null` where
`select: false` skipped the RETURNING. `scope: 'collection'` — `count` rows
matching `where` changed, from a statement that never built them. The
discriminator is STATED, never read off `result`, because `result: null` is not
one fact: a `select: false` write is row-scoped and has no row, and treating that
as *no rows* is exactly what dropped it a layer up. Every write method announces;
seven did not, and a write matching no rows announces nothing.

### <a id="fjs-d56"></a>2026-08-16 · `FJS-D56` — `announce` is per CALL, with a client-level floor (`FJS-D34`).
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

### <a id="fjs-d65"></a>2026-08-15 · `FJS-D65` — A soft-deleted row KEEPS its `@unique` values.

The slot is not
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

### <a id="fjs-d64"></a>2026-08-14 · `FJS-D64` — A commit scope is a declared wrapper, not a new hook phase.
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

### <a id="fjs-d62"></a>2026-08-13 · `FJS-D62` — Clock-relative derived fields: `@derived(expr)`, evaluated at query time.
Supersedes the ruling written earlier the same day, which said no such tier
should exist — **and that one was never committed**, so it can be named here and
nowhere else: it was written and replaced inside a single session, and the tree
has only ever held this one. `FJS-D196` is why that is written down rather than
left as *the ruling written earlier*, which is a citation no reader can follow. That ruling's reason does not hold: SQLite refuses a
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

### <a id="fjs-d63"></a>2026-08-13 · `FJS-D63` — Amended the same day: three tiers, not two. `@@scope` is reinstated.

The paragraph above collapsed two different things into the
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

### <a id="fjs-d57"></a>2026-08-01 · `FJS-D57` — Unknown `where` fields: ~~WARN on reads~~, ERROR on writes.
~~Reads log once per model+field (did-you-mean hint) and still execute~~; writes
(update/delete/restore/upsert families) reject — a typo'd filter on a write is a
mis-scoped destructive operation. `AND/OR/NOT` are descended into; relation
sub-filters are not (their keys belong to the related model).

**Read half reversed 2026-09-01 by [`FJS-D169`](#fjs-d169)** — a warned read did
not "still execute", it executed a different query and answered no rows, and the
key reached the SQL pattern (Invariant 8). Reads reject too, hint in the error.
The write half and the descent rules are unchanged.

### <a id="fjs-d58"></a>2026-08-01 · `FJS-D58` — Unknown `data` keys are silently stripped.
Mass-assignment protection: pass a request body straight in without
whitelisting. This deliberately REPLACED an earlier reject-with-did-you-mean
behavior — do not restore the rejection. Safety net: a typo on a *required*
field still fails loudly via the required-field pre-flight.

### <a id="fjs-d59"></a>2026-08-01 · `FJS-D59` — `take`/`skip` are rejected with a pointer to `limit`/`offset`.
Prisma muscle-memory must fail loudly and helpfully, never be silently ignored.

### <a id="fjs-d60"></a>2026-08-01 · `FJS-D60` — Missing required fields on create are a ValidationError.
`name is required`, same shape as every other field rule — never a raw SQLite
`NOT NULL constraint failed`. Exempt: optional fields, arrays (implicit `[]`
DDL default), `@default`/`@updatedAt`/`@sequence`/generated/computed/`@from`,
`Int @id` (autoincrement). Applies to create/createMany/upsert-insert only —
updates stay partial.

### <a id="fjs-d61"></a>2026-08-01 · `FJS-D61` — ~~`@@strict` model flag: PARKED.~~ Withdrawn 2026-09-03.
~~(Would escalate read-warnings to errors per-model.) Revisit after the warnings
have been observed in practice; the warn infrastructure makes it nearly free.~~
**Withdrawn 2026-09-03**: [`FJS-D169`](#fjs-d169) removed the read warnings
this flag existed to escalate, so there is nothing left for it to do.
*All four above live in:* `packages/litestone/src/core/client.js`
(`withArgValidation`, `checkWhereKeys`, `writeData`); tests in
`test/elegance-fixes.test.ts` and the rewritten block in `test/litestone.test.ts`
("write payload — unknown fields are silently stripped").

## Migrations (Litestone)

### <a id="fjs-d186"></a>2026-09-03 · `FJS-D186` — an enumeration gets a catch-all underneath it. A difference the differ cannot NAME is announced, never migrated and never blocking.

`diffSchemas` compares a list of dimensions somebody wrote down: columns,
indexes, foreign keys, STRICT, CHECKs, table uniques, triggers, views. Six
issues of this package's history are one dimension arriving in the DDL emitter
and not in that list, and every one of them reads the same way — *schema is in
sync*, over a database that is not the declared one. `FJS-717` is the seventh
prevented and `FJS-718` is the seventh, found by the thing that prevents it.

**The catch-all is the whole of the fix and the enumeration stays.** Comparing
`sqlite_master` whole could not replace the dimension list: the list is what
knows a column add is an `ALTER` and a CHECK change is a rebuild, and a text
comparison knows only that two statements differ. So the two are layered — the
enumeration says what to DO, and once it has finished saying it the statements
are compared whole and the leftovers are named.

**A residue is not part of `hasChanges`, and that is not a softening.** There is
nothing in this file that could write a migration for a dimension it cannot see,
so counting it as a change would generate an empty migration, apply nothing,
and find the same difference on the next boot — for ever. What the tripwire
produces is the one thing an enumeration cannot produce for itself: the
statement that something is left over.

**It does not block, because the commonest cause is not a defect.** `litestone
introspect` is the adoption door, and a real database has a `COLLATE NOCASE` on
its email column, a `WITHOUT ROWID` table or a hand-written index — things this
language cannot say, so no enumeration will ever grow to cover them. Refusing to
boot over one would refuse every adopted database. The refusal that would be
right for a litestone-created database is wrong for an adopted one and nothing
here can tell them apart, so it announces and names both readings.

**It is recorded beside the DDL hash rather than withholding it.** The hash is
what makes *call this on every startup* free, and it is also the guard two
replicas race on, so a state that suppresses it buys an announcement at the
price of a double migration. Recorded, the fast path re-announces for one
SELECT — which is what a difference nothing can migrate needs, since saying it
once and going quiet is how it stops being known. `acceptResidue: true` is the
caller stating it, modeled on the `acceptDataLoss` beside it, and it clears the
record rather than filtering the output.

**The false-positive rate decided the normalization and was measured first.**
`ALTER TABLE ADD COLUMN` appends the column text to the stored statement in the
spacing the ALTER used, so a table that migrated perfectly differs from the
pristine one by a space: 162 of 694 objects across the corpus schemas, every one
of them spacing. Whitespace around punctuation comes out on both sides, which
takes it to 0 of 694 — and 0 on a fresh build of all nine corpus schemas, and 0
on both real databases in this repo. What that cannot tell apart is two
statements differing only by whitespace inside a string literal; the alternative
is a SQL parser standing behind a tripwire whose whole value is not needing one.

**The statements are stored raw and normalized only where two disagree.**
Normalizing in `introspect` cost 18 ms of a 75 ms introspection on the 188-model
fixture and every object it touched then compared equal anyway. Compared raw
first, it is 1 ms — inside the noise — so the tripwire is not a thing anybody
has a reason to turn off.

### <a id="fjs-d180"></a>2026-09-02 · `FJS-D180` — the audit index's write transaction is the trail file's LOCK, and WAL is what makes taking it affordable. The order is the ruling: the unlink goes, and it goes before WAL does.

A `driver logger` database is schema-global — every tenant's client and every
process appends to one `.jsonl` and one companion index — and
`docs/concurrency.md` recommends running a second process. Three things were
wrong with that, each destroying a trail rather than inconveniencing it, and
they share one fix (`FJS-665`).

**A byte offset cannot be computed before the append and cannot be recovered
after it.** `statSync(f).size` then `appendFileSync` is two syscalls; a second
process appending between them makes the recorded offset name the OTHER
writer's line. Measured, two processes, no artificial delay: **1,999 of 8,000 —
one in four**. An indexed read then answers the wrong record with no error, and
for an audit trail wrong-with-confidence is the worst failure there is.

**So the pair is serialized, and the lock is `BEGIN IMMEDIATE` on the index
database rather than a lockfile.** Not preference: a lockfile has no answer for a
writer that dies holding it. Stale detection by pid or mtime is the standard
footgun — it either blocks the trail for ever or breaks the lock while the holder
is alive — and the operating system already drops a dead process's file locks,
which is a guarantee SQLite inherits and a lockfile cannot. The index row naming
the offset is written under the same transaction, so the offset and the row
commit together or not at all.

**WAL is the second half of that decision, because a lock is only affordable if
it is cheap.** Measured, 8 processes × 400 appends:

| | rollback journal | WAL |
| --- | --- | --- |
| processes killed by the DDL | **2 of 8** | 0 |
| rows dropped to `SQLITE_BUSY` | **12** | 0 |
| worst single insert | **5,007 ms** | 79 ms |
| mean insert | 9.6–65.2 ms | **0.03–0.27 ms** |

A rollback journal makes readers and writers exclude each other on the one file
every process touches, so a single open reader blocks a writer for the whole
`busy_timeout` and then fails it (5,006 ms → `SQLITE_BUSY`). `core/pragmas.js`
already says what that costs: the driver is synchronous, so the wait is the event
loop.

**WAL was tried before and taken back out, and that instinct was right for a
better reason than the one recorded.** The note said WAL would owe two more
unlinks wherever the index is deleted. Measured, it is worse than a maintenance
worry: after compaction unlinked the index, a live process's next write answers
`SQLITE_READONLY_DBMOVED` under a rollback journal — a loud crash, which is
`FJS-540` — and answers **`ok` under WAL**, silently writing into an inode with
no directory entry. **WAL turns a crash into a lie.**

**Which is why the ORDER is the ruling and not an implementation detail.**
Compaction stops unlinking the index FIRST — it rebuilds it, which costs one pass
over a file already in memory — and only then is WAL safe, because nothing
separates the database from its `-wal`. A future change that reintroduces the
unlink reintroduces the silent write, so the two are one decision.

**The read is inside the lock, not just the write.** Locking the write-back alone
leaves the window where it was and makes it WIDER, because compaction then waits
for the lock while the writer keeps appending: measured at a 297-row gap where
the unlocked original lost 4,637. So an append waits for a compaction, for as
long as the compaction takes. That is the correct trade rather than a reluctant
one — the alternative to a blocked append is a destroyed audit row, and under WAL
the hold blocks writers only.

**The upgrade may fail without failing the open.** `journal_mode = WAL` is
persistent, so opening an index an older build wrote IS the migration — and it
needs a moment with no other connection, which a rolling deploy is exactly when
there is not one. Measured against a live reader: 5,008 ms and then an exception,
at boot, on the audit path. It is attempted with a 50 ms wait of its own and its
failure is swallowed; a later start completes it. Until then the index is correct
and merely has the old contention profile, **because correctness here is the lock
and not the journal mode**.

**What was NOT adopted, and why it is worth knowing.** The canonical design for
this shape — an append-only file with a byte-offset index — is Bitcask's, and it
takes no lock at all: one writer owns the active file, closed files are immutable,
and compaction writes NEW files. That is the better answer at a storage engine's
write rates and it is a different feature, with segment ids in every index row and
a merge policy. For a trail whose lock is held across two syscalls, one file and
one lock is the proportionate answer; the Bitcask shape is what to reach for if
the append rate ever makes the lock the bottleneck.


### <a id="fjs-d123"></a>2026-08-23 · `FJS-D123` — `migrate create` diffs against the migration HISTORY, not the live database; `db push` is prototyping only (`FJS-345`, `FJS-388`).

**The development workflow wrote tables and the deploy workflow applied files,
and nothing joined them.** Every generator told a developer to run `fli
db:push`, which diffs the schema against the live database and writes tables
directly, no file. The container entrypoint is `bun run db:migrate && bun run
start`, and that applies migration FILES. A model added through push was in the
developer's database and in no file, so the image was missing it.

A table-granular guard was added to `migrate apply` on 2026-08-22 and it was not
enough. **Measured 2026-08-23, three things:**

1. **The guard is table-granular, so occurrence two onward is still silent.** It
   compares declared tables to `sqlite_master`. A new *model* is caught; a new
   *column* is not — history at `User{id,email}`, a pushed `name` column, and
   `migrate apply` answers `✓ 1 migration applied`, exit **0**, over a `user`
   table that has no `name`. Health passes; the first write naming it is a 500.
   A column add is the common change after week one.
2. **The advice the guard prints is a closed loop.** It says *write one:
   `litestone migrate create`*. That command, run in the project, answers
   `schema is already in sync — no migration needed` and writes nothing —
   because `create()` diffs the schema against the **live database**, which a
   pushed database already matches. Deploy says write a migration; the migration
   writer says none is needed. There is no way out from inside the tool.
3. **There is no baseline**, so nothing can say *this database already reflects
   these files*.

**The root is that one comparison was doing two jobs.** Prisma's shadow database
is the settled shape and it runs TWO diffs: a fresh database with the migration
history replayed into it, then *schema ↔ shadow* — what migration to write — and
*shadow ↔ live* — has someone changed the database by hand. Litestone had only
*schema ↔ live*, which answers neither question well. The shadow costs nothing
here: `create()` already opens a `:memory:` database and calls `buildPristine`,
so the shadow is the same move seeded from the files instead of the schema.

**ZenStack v3 is the sharper precedent.** They rewrote Prisma's ORM on Kysely
and did **not** rewrite its migration engine — `zen migrate *` generates a Prisma
schema and shells out to the Prisma CLI. A team willing to reimplement the ORM
judged the migration engine not worth reimplementing. Litestone cannot take that
route, being SQLite-only with its own DDL emitter, but the design is prior art
rather than open territory, so it is copied rather than invented.

**Ruled:**

1. **`migrate create` diffs the schema against the shadow**, and a separate
   check compares shadow against live. Two questions, two comparisons.
2. **The deploy guard is schema-granular**, over `diffSchemas` — the same
   function `create` and `dry-run` use — not a table-name set. A missing column
   is the case that shipped.
3. **`migrate baseline` exists**: record files as applied without running them.
   This is the migration path for every app that already has a correct database
   and no history, and without it (1) is shippable only to new apps.
4. **`db push` still writes no migration file, and the ruling's reasoning
   changes.** The conclusion stands and matches Prisma and ZenStack, both of
   which document push as development-only. But its recorded justification — *the
   loud failure now arrives in the container* — is false, per finding 1. The
   sound one: push is safe **because `migrate create` can always reconstruct the
   delta from history afterwards, whenever it is asked**. A ruling standing on a
   false premise is the one that gets relitigated, so the premise is replaced
   rather than the conclusion.
5. **`migrate dev` exists** — create, apply, and drift-check in the one verb a
   developer runs constantly. Prisma's `migrate deploy` needs no schema guard
   because `migrate dev` guarantees history matches schema before anything is
   committed; litestone had no such command, which is what the guard in (2) is
   compensating for. **With it, `db push` is prototyping only** — the thing you
   reach for before a project has a deploy, not a workflow a deployed app lives
   in.
6. **One function, several callers.** Once (1) lands, *will this deploy have the
   right schema* is a pure function of the repo — replay `db/migrations/` into
   memory, diff against `db/schema.lite` — needing no database, container or
   network. So it is asked before the build (`fli deploy:doctor`, `fli check`,
   CI) **and** at container start. The boot refusal stays: it is the only thing
   covering a hand-written Dockerfile or a deploy that never touches `fli`, and
   basecamp is exactly that (`FJS-417`). Every caller calls the same function,
   the way `fli check` and CI's `structure` phase share `core/checks.js` — two
   implementations of one rule is how a framework breaks a rule it publishes.

**What a dev database costs.** After a push the developer's database is ahead of
the history, so a freshly created migration may not re-apply to it — `CREATE
TABLE IF NOT EXISTS` is idempotent and `ALTER TABLE ADD COLUMN` is not
(measured). Prisma's answer is to reset the development database, on the ground
that one is disposable; `migrate baseline` is the other way out. Both are
available and neither is silent.


### <a id="fjs-d66"></a>2026-08-17 · `FJS-D66` — A rebuild that would destroy an app-created schema object is BLOCKED, not warned about (`FJS-183`).

`rebuildSQL` drops the table, which
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

### <a id="fjs-d09"></a>2026-08-16 · `FJS-D09` — migrations, second tier: there is no `down`, a rebuild asserts its own row count, and a migration is named after the last file in its directory.

**§1 — there is no `down`. The way back is a copy taken before the run, and
`--backup` is where it comes from.**

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

**§2 — a rebuild asserts its own row count before it drops the original.**

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

**§3 — a migration is named after the last file in its directory, not after
the clock.**

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

### <a id="fjs-d67"></a>2026-08-01 · `FJS-D67` — The executor owns the transaction.
`apply()`/`autoMigrate()` strip in-file `BEGIN/COMMIT` + FK pragmas and provide
the real thing: one transaction per migration, ROLLBACK on failure,
`recordMigration` committed atomically inside it, FK pragma restored in a
finally. Generated files keep the in-file pair for hand-running in a sqlite
shell only.

### <a id="fjs-d68"></a>2026-08-01 · `FJS-D68` — Rebuilds copy only the old∩new column intersection.
Added columns are never named in the copy-SELECT (SQLite's double-quoted-string
fallback turns unknown identifiers into literals — this silently corrupted or
destroyed data). A rebuild that adds a NOT NULL column with no default is
generated BLOCKED (commented out, with fix options); `autoMigrate` reports
`state: 'blocked'` and does not write its hash, so it resurfaces every startup.
*Both live in:* `packages/litestone/src/core/migrate.js` + `migrations.js`;
tests in `test/migrations-fixes.test.ts`.

## API design (Junction)

### <a id="fjs-d219"></a>2026-09-05 · `FJS-D219` — a battery takes a credential by REFERENCE, and the shape is structural so the rule can reach a package that may not import Conduit

Conduit's rule is that a `TargetDescriptor` carries `auth: { type, ref }` and a
resolver turns the ref into material at send time, so credentials stay out of the
registry, out of `resolve()`/`list()`, out of hooks and off the management
routes. Junction's mail battery takes the secret itself as a constructor
argument. One framework, two habits, about the most sensitive value an
integration holds ([`FJS-659`](ISSUES.md#fjs-659)).

**The cause is placement, not disagreement.** Nobody chose two conventions. The
convention lives in `@frontierjs/conduit`, junction may not depend on it — that
is what keeps Conduit optional and `IMail` a contract with a working default —
and a rule in a package the other party cannot import is a rule that gets
re-invented. The second convention is what *keeping Conduit optional* cost when
the rule was written as Conduit's rather than as the framework's.

**So the interface is satisfied structurally, and is declared by neither party as
a shared type.** A battery accepts anything shaped `{ get(ref: string):
Promise<string | null> }`. Conduit's `CredentialResolver` already is that, so an
app holding a Conduit passes its resolver straight in; an app without one passes
`{ get: k => process.env[k] }`. This is how dependency direction is already wired
here — peer-deps, dynamic imports and duck-typing rather than declared imports —
and it costs no new dependency in either direction and no package move.

**It does not move to `@frontierjs/toolbelt`, and the reason is the charter.**
Toolbelt is pure functions with zero dependencies ([`FJS-D26`](#fjs-d26)), and
`createEnvResolver` reads `process.env`. A type alone does not earn a kit, and a
kit that reads ambient state is not the substrate package any more.

**The raw option stays and is not blessed.** Removing it breaks every app that
has one, and the ref-shaped option is worth nothing if adopting it is a
migration. What makes this decidable rather than aspirational is that a literal
secret in a battery constructor is a shape `fli check` can see — that rule is the
artefact, because without it an app keeps the raw key forever and nothing says
so.

**§IV, batteries vs smallness.** A battery may be large and must be severable:
one owner, one seam, removable without surgery on the core. A resolver argument
is a seam and grows no tendril — `IMail` keeps working with no resolver at all.

*Lives in:* `packages/junction/src/mail/index.ts` (`createResendMailer`) ·
`packages/conduit/src/credentials.ts` (the resolvers that already satisfy it) ·
[`FJS-659`](ISSUES.md#fjs-659) is the implementation ·
[`FJS-D215`](#fjs-d215) is the same argument about a vendor rather than a secret

### <a id="fjs-d220"></a>2026-09-05 · `FJS-D220` — the outbound webhook signature stays FrontierJS's own. A subscriber verifies with the published kit, and is told so.

[`FJS-D185`](ISSUES.md#fjs-d185) raised the fork: the plugin signs with
`@frontierjs/toolbelt/signature`, the FJS-to-FJS scheme, while a subscriber is
the one counterparty that is **not** FrontierJS — so Standard Webhooks
(`webhook-id` / `webhook-timestamp` / `webhook-signature`) is the interoperable
alternative and was the recommendation on the way into this ruling. **Measuring
the two reversed it.**

**Swapping would be a security downgrade.** The canonical string here is
`METHOD\npath\nquery\ntimestamp\nnonce\nbodyHash`; Standard Webhooks signs
`msg_id.timestamp.payload`. Ours binds the method, the path and the canonicalised
query, so a captured signature cannot be replayed against a different endpoint on
the same host, and the query is signed because a subscriber URL carrying a
parameter would otherwise verify unchanged against any other value of it
([`FJS-678`](ISSUES.md#fjs-678)). Theirs binds none of those three. Adopting the
ecosystem's shape here means signing strictly less.

**The problem the fork was raised to solve is real and is not the scheme.** A
bespoke scheme is a liability when every receiver must hand-roll a verifier,
because hand-rolled verifiers are where timing-unsafe compares and missing
timestamp windows live. But `@frontierjs/toolbelt` is published, zero-dependency
and exports `verifyRequest` from `./signature` — a Node subscriber verifies in
one call and writes no crypto. What is missing is that **nothing tells a
subscriber this exists**, which is a documentation defect wearing a protocol
defect's clothes.

**§IV, familiarity vs precision, read the way it is written.** Steal proven
shapes from the ecosystem; reject their words when they half-fit. The words fit
here — this *is* a webhook signature — but the shape underneath does not, and the
adjudication is about words rather than about accepting a weaker mechanism to
match a library. Where muscle memory collides with a deliberate difference, the
answer is to fail it loudly and helpfully, which is the residue below.

**What is owed, and it is not code in this package:** the delivery
documentation names the header set and the canonical string, points a Node
subscriber at `@frontierjs/toolbelt/signature`, and carries a verifier in one
non-Node language, because *install our package* is not an answer to a
subscriber who is not on Node. Until that exists the scheme is defensible and
undiscoverable, which is the state that produced this question.

*Lives in:* `packages/junction/src/plugins/webhooks/index.ts` (`signRequest`,
prefix `X-Webhook`) · `packages/toolbelt/src/signature/signature.js`
(`canonicalRequest`, `verifyRequest`) · closes the signature half of
[`FJS-D185`](ISSUES.md#fjs-d185)

### <a id="fjs-d218"></a>2026-09-05 · `FJS-D218` — a custom method is addressed by header and by nothing else. OpenAPI not being able to say it is a fact about OpenAPI.

Left open by [`FJS-902`](ISSUES.md#fjs-902) and answered here rather than left as
prose inside a closed row.

**The question.** A custom method is invoked as `POST /{service}/{id}` with
`X-Service-Method`. The OpenAPI generator used to document a path per method,
`/{service}/{id}/{method}`, which was measured answering **404** — no such route
is registered. Fixing the document raised the other direction: should the wire
serve that path too, so each custom method could be its own operation with its
own body and its own responses?

**No. One address, and the header is it.**

*One owner for how a call is addressed.* Two spellings for one invocation is two
places for a gate, an `Idempotency-Key`, the `_customMethods` allow-list and the
announcement to be applied, and the failure mode of the second is not a 404 — it
is a call that works and skips something. `bridge.ts` reads the header once and
sets `ctx.method`; a path form would be a second reader of the same question.

*Nothing is derived by adding it.* The path carries exactly what the header
carries. It buys a nicer generated document and no capability.

**What it costs, stated rather than hidden.** OpenAPI dispatches on path and
verb, so it cannot express *a different operation depending on a header value* —
which means every custom method on a service collapses into ONE documented
operation whose header enum is the allow-list and whose body is a `oneOf`. That
is worse documentation than a path per method would be, and it is the honest
shape: the alternative reads better and is a lie a generated client calls. **The
limitation belongs to the format, not to the design**, and it is written here so
the next person who notices the collapsed operation finds an answer instead of
re-deriving the question.

**Not a refusal of REST-shaped actions in general.** An app that wants
`POST /orders/{id}/refund` writes a raw route and calls the service from it —
`app.post` applies `apiPrefix` and the route is the app's to name. What this
rules out is JUNCTION registering a second address for every custom method on
every service.

### <a id="fjs-d210"></a>2026-09-05 · `FJS-D210` — route matching is CASE-SENSITIVE, and a case-only miss is named rather than merely refused

**Four things answer *which route is this*, and one of them disagreed.**
`matchPattern` compared static segments lowercased. `isActive`, the prefetch
cache key, `page.path` and the filename a static build writes to disk are all
case-sensitive. So `/ADMIN/` rendered the admin page in the SPA, reported itself
as **not** active in the nav that linked to it, cached under a key of its own,
and 404'd on the static host — the same URL behaving four ways, and dev
disagreeing with production.

**Ruled in favor of the other three**, which is also what RFC 3986 says about a
path and what a filesystem says about a file. The lowercasing was the added
complexity, not the removal of it: the rule is now *paths are case-sensitive*
rather than *paths are case-sensitive except when matching*.

**The refusal alone was not enough.** § IV's standing answer where a deliberate
difference meets ecosystem muscle memory is to fail it *loudly and helpfully —
name the equivalent*, and a bare 404 for a path that plainly exists is the
failure that answer exists to prevent. So `caseInsensitiveNearMiss` walks the
tree only when nothing matched exactly and answers the path that would have,
and the router says *did you mean `/admin/`? Route matching is case-sensitive.*
It is reported at **both** entrances, and the second is the one that mattered:
an app with a catch-all route has a truthy match, so nothing warned at all and
the reader simply got a Not Found page for a route that exists.

The hint is a separate function from the matcher on purpose — a matcher that
knew about near misses would be a second, looser matching rule living inside the
strict one, which is the shape this ruling exists to remove.

*Lives in:* `packages/sierra/src/router/match.js` (`matchPattern`,
`caseInsensitiveNearMiss`), `src/router/index.js` (`_nearMiss`), asserted in
`tests/match-semantics.test.js` with controls both ways — the exact spelling
still matches, and a path that is simply absent has no near miss, because a hint
that answered for anything would turn every 404 into a wrong suggestion.
Recorded against [`FJS-820`](ISSUES.md#fjs-820), which carried it as a deliberate
non-fix awaiting this ruling. Sibling of [`FJS-D125`](#fjs-d125): same question
one component along — what a URL MEANS, decided once for every reader of it.

### <a id="fjs-d207"></a>2026-09-05 · `FJS-D207` — `PUT` to an id that does not exist is 404. It does not create the row.

REST's convention is that `PUT` is idempotent-create: absent the resource, make
it. `adapter-12` of `FJS-708` filed the absence as a gap. Measured first — a
`PUT` to a missing id is 404 for a caller-supplied `String @id` exactly as for a
server-assigned `Int @id`, so the behaviour is uniform and deliberate rather
than an oversight on one path.

**The safe half is derivable and that is what makes the decline worth writing
down.** `isServerAssignedId` already separates the two kinds of key, so the
narrow version — *create on `PUT` only where the caller owns the id* — could be
built without ever letting a caller choose a primary key the server assigns.
It is declined anyway.

**What it would buy is a second spelling.** `POST` carrying a caller-supplied id
already creates a row at a chosen key, and it is tested on both sides of the
boundary (`caller-supplied-id.test.ts`, litestone and junction). Nothing an app
here wants is unreachable.

**What it would cost is a silent wrong answer.** `PUT /docs/abcd` where `abc`
was meant stops being a 404 and becomes a junk row, and the response to a
created row and to an intended update are indistinguishable. That is precisely
the class `FJS-889` (a payload key that named no column) and `FJS-891` (a
statement the tap never reported) were spent removing from this seam; adding it
back for a convention would be the umbrella closing on itself.

**It is `FJS-D179` one question along.** That ruling already declined REST's
reading of the verb — `update` MERGES rather than replacing, and the
documentation follows the write. Familiarity against precision was resolved in
that direction once; *create on missing* is the same trade on the same verb.

The way to create a row at a key you choose is `POST` with the id in the body.


### <a id="fjs-d202"></a>2026-09-04 · `FJS-D202` — a job whose actor is gone FAILS. It does not run as the system.

A job records the principal that dispatched it. When that row is gone the job
burns the whole retry ladder on a permanent condition and dies with an error
about a principal rather than about the work, having run its handler zero times
(`caravan-14`). A staff member leaving, a reseeded fixture, a deleted tenant —
and the receipt is still owed.

`onMissingActor` is declared beside `maxAttempts`, and **the default is
`'fail'`**.

**`'system'` was the other candidate and it is an escalation wearing a
convenience.** A departed staff member's queued work would complete at level 8,
above every gate the person themselves passed. That the work is owed does not
make the application the one who owes it.

`'fail'` means fail FAST and terminal — no ladder, since no number of retries
brings a deleted row back — with the error naming the job, the actor id, and
that the condition is permanent.

`'system'` stays available, declared per job, so an app that genuinely means
*this goes out regardless* says so in the file where the work is defined, which
is where a reader looking for surprising behavior looks.

Cites `FJS-D193`: a delivery needs a nameable principal, and a deleted one is
not nameable. Same question with a queue in place of a webhook.

*Lives in:* `FJS-D193` · [`FJS-711`](ISSUES.md#fjs-711) `caravan-14` ·
`packages/caravan/src/types.ts`

### <a id="fjs-d201"></a>2026-09-04 · `FJS-D201` — one fault vocabulary, in `@frontierjs/toolbelt`, read by every package that decides whether to try again

`FJS-684` fixed conduit's breaker by asking three columns of every kind: is it
retryable, does it trip the breaker, and what can a caller do with it. The
method is right, and it is conduit's alone.

Junction maps errors its own way, caravan has its own notion of a retryable
failure and its own ladder, and `retryable` itself is already ruled
framework-wide by `FJS-D194`. One concept, three homes, and one of the three is
a shared ruling — which is the shape that says the concept was always shared and
only the code was not.

**`FJS-D197`'s argument, made before the drift instead of after.** The gate
ladder was four hand copies with a comment at each saying *change one, change
both*; it drifted, and the drift was invisible because no test imported two of
them. Nothing here has drifted yet. That makes this cheaper now. It does not
make it optional.

The kit is `@frontierjs/toolbelt/fault`: the kind vocabulary, and per kind the
three columns. Toolbelt because it is pure — a kind is a word and three
booleans, with no clock, no socket and no row — and because `FJS-D26` is what
lets conduit, caravan and junction each import it without any of them importing
another.

**What it does not own is classification.** Whether a given failure IS a given
kind stays with whoever saw it: conduit reads an HTTP status, caravan reads a
thrown value, junction reads both. A kit that classified would need a transport,
and would stop being substrate.

The tripwire is the one `FJS-684` already names: a new kind lands as a PAIR —
the case that has it beside the case that does not — because a taxonomy that
stopped counting everything passes any test that only checks the new kinds
(`FJS-351`).

*Lives in:* `FJS-D194` · `FJS-D197` · `FJS-D26` ·
[`FJS-710`](ISSUES.md#fjs-710) · [`FJS-711`](ISSUES.md#fjs-711) · `FJS-684`

### <a id="fjs-d200"></a>2026-09-04 · `FJS-D200` — `$` is a CLOSED set the framework owns. App state is `ctx.locals`.

`FJS-687` fixed the leak — `$` surviving its call and following it into timers.
What it did not settle is what may live there, and `core-11` asks for a per-call
timeout, an `AbortSignal` and a trace parent on the same object.

**The set is closed and the framework owns every key.** `$.config`, `$.log`, and
whatever a later ruling adds by name. An app may not claim into it.

The reason is Invariant 5 one layer down. `app.<thing>` has one owner per name
and a claim is explicit, because an ambient object with an open surface is where
every package puts its key and nothing can then say what a call carries. `$` is
the worse case, because it is invisible at the call site: a reader sees
`currentCall()` and cannot see what the app added to it.

`ctx.locals` is the app's, and already is — per call, typed by the app, and
visible in the signature.

**Adding a key to `$` is a ruling, not a pull request.** That is the whole
content of *closed*, and it is what stops this being a preference somebody
relitigates per feature.

What it permits: the three `core-11` asks are framework concerns and may land on
`$` when each is ruled on its own, since a timeout and an abort signal are the
call's own facts and have nowhere else to live.

*Lives in:* Invariant 5 · `FJS-687` · `packages/junction/src/core/context.ts` ·
`CLAUDE.md` § Bridge index · [`FJS-706`](ISSUES.md#fjs-706) `core-11`

### <a id="fjs-d199"></a>2026-09-04 · `FJS-D199` — Junction refuses an unknown AUTHORING key by name, and reports every one of them at `start()`

Litestone ruled its own side in `FJS-579`: a client throws on an unknown
property, and `createClient` refuses an unknown option by name. Junction never
got the same ruling, and ten authoring mistakes compile green — `before: {
creat: … }` builds a dead pipeline, `{ prot: 4444 }` is merged with `warnings:
[]`, a custom method named `cache` is dispatched AND eaten as the option so
caching turns on with no bust, two `create*Service` exports in one file keep the
first, and a duplicate service name takes the first alphabetical.

**§ IV resolves ergonomics against strictness by cost, never by temperament, and
the cost here is asymmetric.** Every one of those is silent, and the thing that
fails is the app in production rather than the author at their desk. `apiPrefx`
is not a preference; it is a typo, and there is no reading under which the
author wanted the default.

**Refuse by name.** The message names the key that was not known and the nearest
one that is — § IV again, familiarity against precision: fail the muscle memory
loudly and name the equivalent.

**At `start()`, collected — not at construction, one throw at a time.** An app
has a config, N service files and a hook table; throwing on the first makes
fixing them serial, one boot per typo. `start()` already runs a phase list every
caller shares (Invariant 4), so it is the only place a whole-app verdict can
exist.

**Not a warning.** `warnings: []` is the thing being replaced, and `FJS-431` is
the id for that shape.

What stays tolerant is anything a CALLER sends. The audit's `D1` was *fail-closed
on the caller, fail-open on the author*; this inverts the second half and leaves
the first exactly as it is.

**No escape hatch, deliberately.** An unknown key that ought to be legal is a
missing feature. A flag permitting it widens the shoulder and records nothing
(§ IV, the paved road).

*Lives in:* [`FJS-706`](ISSUES.md#fjs-706) · [`FJS-709`](ISSUES.md#fjs-709) ·
[`FJS-431`](ISSUES.md#fjs-431) · `FJS-579` ·
`packages/junction/src/config/index.ts` · `core/service.ts` · `core/loader.ts`

### <a id="fjs-d195"></a>2026-09-04 · `FJS-D195` — the OUTERMOST transaction owns the announcement and the effect queue, and the tap asks a SET of names rather than comparing one.

Recorded after the fact: this is what `FJS-682` and `FJS-688` shipped on
2026-09-03, and it stood in no register until now. The question was filed as
`FJS-D183`, an id `DECISIONS.md` had already issued that day to the encryption
envelope — three documents cite it in that meaning, so the envelope keeps it
and the question is reissued here.

**A call decides *did this succeed* and then announces and drains its
`afterCommit` queue. That is the right owner only when the call is also what
makes the write durable, and under `transactional:` it is not.** A nested call
settles on its own clock while the rows belong to the transaction above it.
Measured on the rollback path: the inner effect RAN and the inner announcement
went out, both for a row that no longer existed — a subscriber told about a
create that never happened. The double-announce reproduced too, three events for
one inner create, because litestone buffers a transaction's write events to the
COMMIT and the tap's `announcingService()` then reads the OUTERMOST call's span.

**So a transaction opens a scope and the calls inside it hand their effects and
their announcements over.** Commit drains them, rollback discards them, and a
nested transaction REUSES the scope it finds rather than opening a second, which
is what makes the outermost one the owner. `FJS-D64` ruled that a commit scope is
a declared wrapper rather than a hook phase; this says what that wrapper owns
once it is open, and the word is the same word.

**`announced` is the third member and it is the tap's half.** The filed question
asked whether a buffered event should carry the name of the service that wrote
it. It should not: the name is not a property of the event, it is a statement
that somebody in this transaction has taken responsibility for announcing that
model. A set on the scope, asked by `announcedInCommitScope(name)`, where tagging
each event would have put the same fact in as many places as there are writes.

**Refused: making the tap the only announcer**, which has seven measured holes
including `ctx.dispatch = false`.

**What did NOT move is `FJS-089`, and it is the substance.** An `afterCommit`
effect follows the CALL's verdict; the announcement follows the WRITE's. Two
questions about one throw with opposite answers — a caller told the call failed
does not also get the email, while a subscriber must still be told the row moved.
The first cut of the fix unified them and an existing test caught it. They are
not to be "unified" later either.

**Three things the building of it turned up, each caught by a test rather than by
reading**, and any re-work meets them again. The scope must be captured INSIDE
the pipeline, since the announcement point runs after it with the scope already
closed — get this wrong and a rolled-back write announces anyway. The call that
OPENED the scope drains it itself and must not defer into a queue it has already
emptied. And that same call is the only one that needs telling the transaction
rolled back, because `methodSucceeded` is true either way.

**Where the boundary is:** `CommitScope`, `commitScope()`, `runInCommitScope()`
and `announcedInCommitScope()` in [core/context.ts](packages/junction/src/core/context.ts),
asserted in [commit-scope.test.ts](packages/junction/tests/commit-scope.test.ts).
`owner` is answered at the moment the scope is created rather than inferred by
the caller, because every proxy for it — is it empty, is a flag set — is also
true of a scope somebody else opened a moment ago and has not filled yet.
Negative controls, stubbed one at a time: **3 / 2 / 1 / 1**.

Closes [`FJS-682`](ISSUES.md#fjs-682), [`FJS-688`](ISSUES.md#fjs-688).

### <a id="fjs-d179"></a>2026-09-02 · `FJS-D179` — `update` is patch with an id REQUIRED. Feathers' full replace is retired, because the write never did it.

`update` was validated against the CREATE-mode document and `patch` against the
update one. The create document omits `@version` — it is emitted for update and
only for update — so a create-mode validator STRIPPED the version a `PUT`
carried, and the Data boundary then refused the write for not carrying one.
**`FJS-335` exactly, one method along** (`FJS-663`), unfound because nothing here
drives a `PUT` on a versioned model: measured on `example`, `PUT /api/tax-rates/1`
carrying the version read one request earlier was a 400 naming `version`, on a
service with no hooks at all, while the identical payload through `PATCH` was a
200.

**Swapping the word is the fix, and it is a ruling because of what create mode
was buying.** The two documents differ on exactly two things: create omits `id`
and `version`, and create has a `required` list. So create mode's only
contribution to `update` was REQUIREDNESS — and the write underneath is
litestone's `table.update`, which merges. Measured: a `PUT` stating only `title`
leaves `subtitle` and `note` where they were. The validator was demanding fields
that would not be replaced.

**Three layers already agreed and the fourth was the odd one out.** The write
merges; sierra's `field-rules.js` grades a form with `isPatch = mode === 'patch'
|| mode === 'update'`; and a sierra resource never issues `update` at all —
`save()` is create-or-patch (`FJS-D114`). Feathers' distinction survived in one
comment and one half-working validator, and that half was the defect.

**What stays is the id, and it is a real distinction rather than a consolation.**
`patch` without an id is a bulk write over a query; `update` refuses without one.
So a REST client's `PUT` can never become a bulk write, which is worth a verb.

**The alternative was ruled out rather than overlooked.** Making `update`
genuinely replace means junction synthesising the null-out set for every absent
writable column — deciding what *absent* means for a default, an `@immutable`, a
`@system` and a `File` — and handing every caller a write that silently discards
what they did not restate. That is a feature with a design of its own, not the
repair of a strip.


### <a id="fjs-d178"></a>2026-09-02 · `FJS-D178` — a hook says which `@system` columns THIS CALL is supplying, through a Set it adds to. `@guarded` gets no equivalent, deliberately.

`@system` means *the application writes this column and the caller does not*, so
the Data boundary refuses a payload naming one. Its narrow hatch is `system: ['col']`
on the litestone call — naming the field IS the statement, and it keeps the gate,
the row policies, `@@softDelete` and the audit actor where `asSystem()` drops all
four to set one value.

**The gap was that a hook could not reach the hatch.** A hook shapes `ctx.data`
and the write happens downstream, on the caller's own client, through the derived
`create`/`update`/`patch` — so a value the application DERIVED arrived at the
boundary indistinguishable from one the caller sent. That is not a corner: any
column computed from the payload rather than declared in the schema has this
shape. Measured on `example`, where a hook rebuilds a slot-keyed mirror from a
customer's `fields` and every customer create over HTTP was a **403** (`FJS-644`).

**`ctx.system` is a Set the hook ADDS to.** `ctx.system.add('slots')`, fresh per
call, not propagated, `readonly` so an assignment is a compile error. It is a Set
rather than a list one hook assigns because `before.all` and `validated.create`
each legitimately derive their own column, and an assignment from the second
silently drops the first's — the same class of silent loss the seam exists to
close. It is named for the boundary option it feeds rather than for an action,
so there is one word for the thing at both ends of it.

**Three properties are the ruling and each is asserted as a pair.**

*Naming a column widens one CALL, never the model.* A service that named nothing
still refuses the identical payload; the pair is the test.

*The set is not a hole a payload climbs through.* Naming a column is the
application vouching for what IT put there. Where a hook derives the value, a
caller who sends the same key has it overwritten before the write, so what lands
is the derived value — asserted on the STORED value and never on a 201, which a
service that simply accepted the forgery would also answer.

*An empty set is not "all".* Nothing reaches the boundary that did not have to,
so a call naming nothing is exactly the call that existed before.

**`@guarded` gets no such hatch and that is the point of the pair.** `@guarded` is
a system-context lock in BOTH directions and answers both halves at once; a hatch
would make it a slower `@system` with a worse name. The consequence is that
reaching for `@guarded` when the argument is entirely about the write is a
misdeclaration, and it presents as a 403 nobody can act on — which is what
`Customer.slots` was. The question to ask of a column is *is there anything to
hide*, not *should the caller write it*: `example`'s mirror holds a re-keying of
`fields`, which any caller who may read the customer already reads.


### <a id="fjs-d160"></a>2026-08-30 · `FJS-D160` — the server STATES its build; the client compares. It is the build and not the Release.

**The gap.** A deploy replaces the code under browsers that are already running.
Their HTML and their JavaScript are the previous build's, and they keep calling
the API — which is fine until it is not, and the failure is silent on both sides:
the person sees a screen that half works, and nothing connects it to the deploy
that caused it. Phase 3 of `IDEAS/release-transitions.md`.

**Half of it already shipped and nobody had said so.** `03-build-web` merges the
previous release's assets into the new one, so a stale client's content-hashed
chunks keep resolving, and because each deploy merges from the one before it the
coverage chains forward across `keep_releases`. What was missing was never the
assets — it was identity.

**The server states, the client compares.** A response header (`x-fjs-build`) and
a field on the socket's `connected` frame, and nothing on the server reads a
build off a request. The alternative — the server diffing per call — answers a
question that changes at most once per deploy, on every call, and has to be
written twice because the two transports carry headers differently. Stating a
value is one fact on both wires, and the side holding the stale code is the side
that can act on it.

**It rides `connected` rather than a new frame.** That frame is sent once per
socket, which is exactly the cadence: a deploy restarts the container, every
socket drops, and the reconnect is when a stale client finds out.

**It is the BUILD, not the Release** (`FJS-D158`'s neighbor and a sharper
distinction than it looks). A Release is the image digest ⨯ bindings ⨯ schema
surface ⨯ pivot; a browser holds none of that — it holds the web bundle. Two
Releases can share one bundle, which is every API-only or schema-only deploy, and
telling those browsers they are stale is a reload prompt for a change that cannot
reach them. It is *also* the only identity available where it must be stamped —
`03-build-web` runs before `04-build-api`, so no Release id exists yet — but that
is a consequence of the argument rather than its reason. If the two disagreed,
the argument would win.

**Inert unless both sides know their build.** A client with none cannot be
behind; a server with none was deployed by nothing that stamps one. The header is
gated so `_finalizeWithHeaders`'s no-op fast path — which exists to hand an
untouched `Response` back — survives for every app that never deployed. `stale`
fires **once**: being told a new version is available is useful, being told on
every call afterwards is the same fact as noise, and the reload that settles it
belongs to the person.

**Refused: routing two Releases at once.** The record's text asks for it, and it
needs a second container, an nginx routing table and a lifecycle for the old one
— which is the orchestrator this realm refuses in the same document, and which
Phase 4 already defers alongside multi-host. The honest single-host claim is that
browsers already out there keep working, and are told when they cannot.

**Proven where it crosses.** Two packages have to agree — the cli decides the
value (`03-build-web` stamps `VITE_FJS_BUILD`, `06-swap` passes `FJS_BUILD`) and
junction states it — and neither can be asked alone, so `deployJournalCycle`
asks a deployed container and compares what it answers against the commit the
deploy built.

**What it cost to get right**: the browser client imports the wire names, and a
client is compiled under the *app's* tsconfig with no node types — so a bare
`process.env` put `Cannot find name 'process'` into every consuming app's `tsc`,
which is `FJS-268`'s class. `tests/client-types.test.ts` caught it by compiling a
fixture the way an app does.

`packages/junction/src/core/build-id.ts` · `tests/build-id.test.ts` ·
`packages/sierra/src/junction/index.js` · `_steps-docker/03-build-web.md`

### <a id="fjs-d159"></a>2026-08-29 · `FJS-D159` — a service filename derives ONE canonical name, and the filename's own spelling stays mounted as an alias.

**The gap.** Invariant 2 names three resolvers that depend on a model's name
agreeing. A kebab-case service FILENAME was a fourth spelling and nothing
reconciled it, so `product-variants.service.ts` broke two resolutions at once.
`deriveModelName('product-variants')` singularises to `product-variant`, which
is not the accessor — which is why all six multi-word services in `example`
hand-write `model:` — and Sierra's `serviceNameFor('ProductVariant')` answers
`productVariants`, which matched nothing. **Every relation picker onto a
multi-word model rendered, opened and offered nothing**, which a person reads as
*there are no variants* (`FJS-570`). One word hid the whole class: `Product` →
`products` and `products.service.ts` → `products` agree by accident, so every
single-word model in both apps was fine and no drive could see it.

**The ruling.** `deriveName` folds `-` and `_` into camelCase, so the SERVICE is
`productVariants` — one spelling, the one the other three resolvers already
derive. The FILE keeps its kebab name, because that is this repo's convention
everywhere else and a rename would move every multi-word URL an app has already
shipped. The filename's own spelling is registered as an ALIAS, so
`/product-variants`, `app.service('product-variants')` and a WS frame naming it
all still resolve.

**Why not the alternatives.** Teaching Sierra both spellings invents a fifth
rule and leaves junction's own model derivation broken, so the `model:`
workaround stays written six times. Reading the mapping off `createResource` is
exact where it applies and silently wrong where the resource module has not been
imported yet. Renaming the files kills the class at the source and changes every
multi-word URL, which is a cost paid by apps rather than by the framework.

**What the alias is not.** It is not a second service. Every lookup goes through
`ServiceRegistry.get`, which resolves an alias to the canonical service, and both
transports then use `service.name` — so a call arriving under the old spelling
announces, resolves its model and appears in telemetry under the one name the
service has. `list()` answers canonical names only, and an alias never shadows a
real service: a registered name always wins.

**A DECLARED name is untouched.** `createService({ name: 'hub-config' })` is a
statement, and basecamp's three make it deliberately; auth's `api-keys` is the
same. The reconciliation is of a DERIVED name, and guessing at a declared one is
the thing this ruling refuses. What covers those is the second half:
`resource.options()` now answers `error` on a failure, so *there are none* and
*I could not ask* stop being the same empty list.

*Lives in:* `packages/junction/src/core/loader.ts` (`deriveName`),
`src/core/service.ts` (`ServiceRegistry`), `tests/service-name-kebab.test.ts`;
the alias is committed in every `surface.snapshot.md` as **also answers to**.

### <a id="fjs-d158"></a>2026-08-29 · `FJS-D158` — an attached service is declared in the app and bound per environment, and half-bound always refuses.

**The gap.** An app needs things it does not own — an n8n, a mail server, a
search cluster — and nothing in the framework knew that. The dependency existed
as four environment variables somebody remembered to set, so a missing one was
discovered at 3am on the first request that reached the service, hours after the
deploy that caused it and with nothing connecting the two events. Phase 2 of
`IDEAS/release-transitions.md`.

**Where it is declared, and why that is not two files.** The app declares what it
NEEDS (`attachments` in `junction.config.js`, or `createApp({ config })`); the
environment BINDS it, as the ordinary variables the target actually carries.
**Not phase 1's binding set** — that is RECORDED into the Release for identity
and revert and applied by nobody; the container's environment comes from a file
`fli` reads and mounts and does not write (`FJS-585`). The check grades the
process's own environment, which is the right place precisely because it is true
however the variables got there. That is the declaration/binding split the phase is named
for rather than a duplication — `frontier.config.js` is what the tooling reads
about where the app goes, and *this app needs a workflow engine* is a fact about
the app.

**It is not a second `defineEnv`.** Every per-key question — present, non-empty,
a URL, long enough — is `checkEnvField`'s, which is now extracted from
`defineEnv` and called by both (Invariant 4). An attachment adds exactly the
three things a flat spec cannot say:

- **These keys are one service**, so the refusal names the service. `N8N_API_KEY
  is required but not set` says a string is missing; `n8n is bound halfway` says
  what is broken.
- **All or nothing.** `optional: true` forgives a service nobody bound and still
  refuses one bound halfway, because *the app can run without this* is not *the
  app can run against half of this*. Half-bound is the shape that actually
  reaches production — somebody sets the URL and forgets the key — and it is
  precisely the shape a per-variable check cannot see, since every individual
  variable it can name is either legitimately absent or legitimately set.
- **A defaulted key is not evidence.** It is satisfied whether or not anybody
  bound the service, so counting it would make every unbound attachment with one
  default look half-bound and turn the rule above into noise.

**The refusal is at STARTUP, and surfacing it is half the build.** An app that
refuses to boot says why in its own output — and until now the operator running
the deploy saw none of it: `healthOrRestore` printed the polled URL, a hint about
`apiPrefix` that is wrong whenever the app never came up, and rolled back. The
app's own sentence was in `docker logs`, where nobody looks at 3am because
nothing said to. So `showContainerTail` tails the container on a failed health
check — bounded at 40 lines, because burying the one line that matters is the
same failure one layer along, and on the revert path too, where a failed health
check means a target with no working release on it.

**A top-level key in `junction.config.js` had to be mapped or it does nothing.**
`loadConfig` maps `app` and two `middleware` keys onto `AppConfig` and stashes
everything else under `_junction` for whichever subsystem owns it — so a block
nobody looks up is read by nothing, silently, which is `FJS-431`'s shape. The
mapping is in `loadConfig` rather than a fallback read in the phase, because a
reader that falls back is a second answer to *where do attachments live*.

**Refused, and stated.** We never manage the service: not install, not upgrade,
not health-check, not back up. Provisioning is easy and *de*-provisioning is
where integrated platforms die, so the boundary is the declaration and the
binding. **Whether the dev compose file is ours to generate stays open**
(`IDEAS/release-transitions.md` § Open questions) — the declaration names the
variables a service is reached through and says nothing about its image, its
version or its volumes, and inventing those is exactly where the helpful/Caprover
line is crossed.

**Proven end to end.** `deployJournalCycle`'s tenth assertion declares an
attachment nothing binds, deploys for real, and grades all three halves at once:
the deploy fails, the operator's terminal carries the app's own refusal naming
the service, and the release that was serving is still serving.

`packages/junction/src/core/attachments.ts` · `tests/attachments.test.ts` ·
`packages/cli/commands/deploy/_module.md` § showContainerTail

### <a id="fjs-d157"></a>2026-08-29 · `FJS-D157` — a backfill is a durable row plus a Caravan job, and it is a cursor over one table rather than a durable workflow.

**The gap.** `litestone release` refuses a contract on a required column and
hands back *expand → backfill → contract*. It grades the first and third steps —
they are deploys — and the middle one was a sentence sitting between two
commands: *fill `x` for the rows that predate it*. Offering a split whose middle
step is a hand-written script is worse than not classifying the pivot at all,
because the refusal implies there is a supported alternative
(`IDEAS/release-transitions.md` § *The hole in this record*).

**What it is.** A `BackfillRun` row holding the position, and a Caravan job that
fills one chunk and queues the next. Shipped from **junction**, the way the
outbox is: a `.lite` fragment imported by name, a plugin, and Caravan as the
engine. Litestone cannot own it — it cannot see Caravan, and dependency
direction is Invariant 1.

**Why not the deploy journal.** It is the other thing here that records progress
durably, and the shape is wrong on inspection rather than by preference: a
transition's steps are READ off `_steps-docker/` and planned ahead of time,
where a backfill is N chunks and N is unknown until the scan ends.

**Why not a bare Caravan job carrying its own cursor.** Cheaper, and it gives no
single object to observe — `app.backfills.status()` would have nothing to read,
and the rows would accumulate one per chunk.

**And what it is NOT: a durable workflow.** The record treats *the noun arriving
twice* as evidence for `IDEAS/overview.md` 4.19. The opposite reading is taken
here: **two narrow mechanisms that look alike are not yet a primitive.** Nothing
in this feature is general — no steps, no compensation, no point past which it
can only go forward — and 4.19 stays where it is until something needs those.

**Four of pgroll's five properties come from the shape rather than being built.**
Idempotent, resumable, chunked, checkpointed. The one worth saying out loud:
**idempotence is the PREDICATE, not the cursor.** A chunk re-reads *the column is
still null*, so a row an interrupted chunk already filled is skipped whatever
position was saved — the cursor is an optimization, and a custom `where` that
does not exclude its own writes breaks the property, which the option says.

**Throttling is the one build, and it is a duty cycle.** The gap before the next
chunk is a multiple of what the last one cost, so a backfill that is costing more
stands down in proportion without anything measuring the database. **What it does
not measure is stated rather than implied**: the signal is this backfill's own
latency, so it responds to contention it is part of and is blind to load that
does not touch these rows. `busy_timeout` is a PRAGMA (`FJS-D155`), so SQLite
swallows the retries and only wall time is visible from here at all. `paused` on
the row is the throttle of last resort.

**Every write it makes is silent, including its own bookkeeping — and that took
measuring.** `announce` is a BULK option: a single `update` has none and always
fires. So the chunk groups its rows by the value the fill answered and issues one
`updateMany({ announce: 'none' })` per group, and the run row's own progress is
written the same way, through `updateMany` on its primary key. The assumption
worth recording is the one that was **wrong**: `asSystem()` does not suppress a
`$tapEvents` tap. A system per-row update announces `update:row` exactly as any
other does, so a per-row backfill over ten million rows broadcasts ten million
times. The test asserts it with two controls, because *silent* has to be told
apart from *nothing is listening*.

**A restart needs a term that MOVES, and that is not obvious until it is
measured.** `dispatch({ id })` treats a taken primary key as work already queued
for all time, so a chunk that ran and declined — the run was paused under it —
holds that id forever. Without a moving term, resuming is not slow but
impossible, and the recovery sweep cannot restart a run the queue gave up on
either. `generation` on the row is a term of the chunk id, bumped by a resume and
by recovery: the same counter the deploy journal keeps, for the same reason.

**A backfill naming a column that does not exist is refused rather than
completed.** Nothing below would catch it — a `where` with an unknown key warns
to stderr and matches no rows, so the empty first chunk reads as the end and the
run marks itself `done` having filled nothing. Silently finished is the one
outcome this feature must not have, because a later contract is allowed to rely
on it.

**Where the advice is rendered is a layering decision.** Litestone puts the FACT
on the finding — `needsBackfill: { model, field }` — and stops. Which mechanism
fills a column is a question about the running application, so `fli
release:check` reads the app's own source for a `defineBackfill` naming that
model and field, and prints either where it is declared or the stub to write.
Read as source rather than by a directory convention, the way `fli check`'s
thirteen source-reading rules already work: a rule keyed on a path reports a
correct app as missing one.

**What no command can answer is whether it has RUN**, because that is a row in
the deployed database and `release:check` has no target. It says so, and names
`app.backfills.status()`.

**Scope, stated rather than discovered.** One database. Under
`createApp({ tenants })` with `strategy database` each tenant has its own rows
and its own run row, so a backfill there is N independent backfills carrying a
tenant through the queue — not built, and **refused by name** rather than run
against the app-level database, which is nobody's and would report a completed
backfill having touched no tenant's rows.

### <a id="fjs-d145"></a>2026-08-25 · `FJS-D145` — a live list's answer is a WINDOW THAT GROWS, not pages. A keyset cursor is the wire under it and never a concept anyone types. `offset` stays, for the numbered page it was always right for.

The last thing `IDEAS/client-data-lifecycle.md` was written about (its Hole 4,
ranked 2.15). It is ruled after the rest of that file was built, because what
the store became changes the answer.

**Four parts.**

**1. `limit` is the window; `more()` raises it.** A live resource pages by
growing, not by stepping. There is no page 3, and the reason is that nobody who
does live data has one: TanStack DB's query-driven sync goes from ten products
to twenty by sending the delta rather than reloading, Zero keeps a limited query
live as a materialised view, and Relay appends into a connection. The framework
had the incompatible half — a `channel:` subscription pushing rows into a store
that pages by position, with no coherent answer to *what does page 3 mean now*.

**2. A cursor is the WIRE and not the concept.** Keyset: the sort key plus a
unique tiebreaker, compared as a row value. Both halves are already declared —
`db.$checkOrderBy()` is the one definition of what may be sorted by and why, and
its `reason` already separates *no such field* from *`@computed`, so SQLite can
neither sort nor paginate by it*, which is exactly the distinction a cursor has
to make; the schema states the unique keys. So the tiebreaker is derived and
nobody writing an application types the word cursor.

**3. `stale` shrinks, and this is the part that is only true now.** A window
bounded by VALUES answers *is this row in it* with a comparison the browser
already makes — `comparatorFor` is the same `parseSort` the server compiles.
Today a pushed row past page 1 is refused and counted, because a list paging by
position cannot know whether the row belongs on an earlier page. With a window
it can: a row landing inside is placed, and `stale` reduces to the honest case,
a row beyond the far edge. That turns the counter from *the framework cannot
page* into *there is more below*, which is a thing a view wants to render
anyway.

**4. `offset` stays exactly as it is.** A numbered page is a legitimate UI and
`Pagination.mesa` renders one. The rule is **`offset` is what you ASK for; the
window is what a live resource GETS** — and asking for one is not an error, it
is asking for today's behavior, including the refusal past page 1. The default
is derived rather than configured: a cursorable ordering over a model with a
unique key gets a window, everything else gets offset.

**Opaque, and it costs less here than it costs anywhere else.** Relay's
rationale holds — the server owns the format, the client cannot fabricate one,
and an unencoded cursor is filtered on by somebody within a week, after which
the sort key and the tiebreaker are public API forever. What opacity normally
costs is debuggability, and here it does not: an illegal cursor is refusable
**by name** through the same mechanism that already refuses an illegal sort, and
`fli tinker` can decode one, because the server is in the room.

**One refusal, and it is the reason this is a framework feature rather than an
application's.** A cursor over an ordering with no unique tiebreaker is refused
by name. The keyset literature is unanimous that a non-unique sort column fails
*silently* — rows at the boundary are duplicated or skipped, with no error and
no gap, which is this repo's whole silent-wrong-data class. The unique keys are
declared, so the framework can refuse at the seam instead of being subtly wrong.
Same move as `@@unique` over a nullable column (`FJS-D130`).

**A change of filter or `orderBy` RESETS the window.** That is a `load()`, not a
`more()`, and it is stated here because it is cheap to say now and expensive to
discover: a `more()` carrying a cursor minted under a different sort is a scan
through an order that no longer exists.

**What this deliberately does not build.** Numbered pages backed by cursor
tokens — the worst of both, and the shape that makes a cursor a concept an
application has to hold. `offset` made illegal. And a second paging directive
landing in `ctx.directives` before the precedence against `$offset` is settled.

**It is smaller than the ranking reads.** `findManyCursor` already ships in
litestone's client, so what is missing is the directive, the envelope
(`endCursor`, whether there is more) and the store's window — not the SQL. The
design question was never the query; it was where the cursor is carried and what
a live list does with one.

### <a id="fjs-d144"></a>2026-08-25 · `FJS-D144` — a fixed-time schedule fires ONCE per calendar day across a DST boundary, following Vixie cron. A wildcard schedule follows the new wall clock, and a shift over three hours is a clock correction.

Caravan evaluates a cron expression in a named zone, and what it does at a
transition had never been stated, tested or chosen. Measured 2026-08-25 against
`America/New_York`: `30 2 * * *` is **skipped entirely** on the spring boundary,
and `30 1 * * *` fires **twice** on the autumn one — `05:30Z` and `06:30Z`, both
reading *1:30 AM*. The queue's own idempotency does not cover the second: a cron
fire is dispatched under `cron:<job>:<epoch-minute>` (`FJS-294`), the two 1:30 AMs
are different minutes, and both queue a row. A job that charges a card or emails a
customer runs twice a year, twice.

**The rule is Vixie cron's, verbatim from `man 8 cron`, and it is the opposite of
ours on both boundaries.** Forward: *those jobs which would have run in the time
that was skipped will be run soon after the change.* Backward: *those jobs that
fall into the repeated time will not be re-run.* Adopted because thirty years of
production is a stronger argument than either alternative, and because the rule it
encodes is the one an operator already believes — **a daily job runs daily,
whatever the clock does.**

Two clauses come with it and neither is obvious.

**Only a FIXED-time schedule is affected.** A schedule carrying `*` in the hour or
the minute is not asking for a particular moment, so it simply follows the new wall
clock; applying the compensation to it would fire an hourly job an extra time for
no reason. This is a carve-out we did not have and would not have derived.

**A shift of more than three hours is a clock correction, not daylight saving**, and
the new time is used immediately. Without that clause an NTP step or a machine
whose zone was misconfigured replays a day of work.

An offset is not a zone and an abbreviation is not one either — `systemd.time`
documents the failure, where a local abbreviation lets a schedule specify daylight
saving in winter. An IANA name, validated at parse against
`Intl.supportedValuesOf('timeZone')`, is the only spelling.

**This is a Caravan ruling and not Junction's**, on `FJS-D36`'s ground: Caravan owns
the clock, `app.scheduler` is an in-process timer with no persistence, and a
schedule that dispatches into a queue is the queue's.

**Built the same day** (`FJS-525`). Both boundaries fall out of one loop rather
than being special-cased: a fixed-time schedule keeps a mark — the last
wall-clock minute it looked at — and each tick walks FORWARD over the local clock
from that mark to now. Spring goes 01:59 → 03:00, so the skipped hour is still in
the walk; autumn goes 01:59 → 01:00, so the walk is empty until it passes 01:59
again. **The mark only ever moves forward**, which is the half that is easy to get
wrong: the first implementation let it follow the clock down, walked the repeated
hour a second time, and reproduced the defect in new code. A fixed-time fire is
named by the wall clock it belongs to, so the autumn duplicate collapses into one
dispatch id through `FJS-294`'s machinery. Free with the walk: a minute missed to
a blocked event loop is caught up, which sampling the current minute could not
see.

### <a id="fjs-d126"></a>2026-08-25 · `FJS-D126` — a tenant DOES carry configuration. The read moves to call scope, the source is a resolver, and what may be overridden is an explicit list refused at boot.

`tenancy { }` decides which ROWS a caller sees and stops there. Everything an app
is configured WITH resolves once at boot and is the same for every tenant — the
mail transport and its from-address, a storage bucket, a timezone, a locale, a
branding value, a flag default, a rate limit. The architecture the feature exists
for is *one deployment, many customers, each of whom thinks it is theirs*, and
the customer-facing half of *theirs* is mostly not rows (`FJS-385`).

Three clauses, and they were built in this order deliberately.

**1. The read is `$.config`, and `app.configFor(tenant)` where there is no call.**
One owner (`core/config-scope.ts`), so a value that becomes per-tenant becomes
per-tenant for every reader at once rather than needing every reader found again.
Shipped *before* the source, answering `app.config` for every tenant identically
— because the same boundary move under a live feature means finding every reader
again, and under no feature it costs nothing and changes no behavior.

**2. The view is read-only, deep, and `app.config` is never written to.** This is
the clause the prior art decides. Laravel's tenancy bootstrappers rebind
`config()` per request and pay with a standing rule that every singleton must
capture the central value in its constructor, because after `bootstrap()` the
original is unreachable; there is an open issue where the framework's own config
cache fights it. Django states the same lesson as a prohibition — never
module-level variables, use request context. NestJS documents that a
request-scoped provider silently makes every dependent one request-scoped, and its
own documentation points at AsyncLocalStorage instead.

Junction already has the ALS, so what all three pay for is free here — **provided
the view cannot be written**, since a writable view is that rebind wearing a
different word and the next reader after a write sees somebody else's tenant.
Deep, because the shallow version refuses `$.config.name = x` and admits
`$.config.http.cors.origin = x`, which is the same defect one level down and the
one somebody actually writes.

**3. The source is `createApp({ tenantConfig })`, a resolver, and never a
declaration.** `FJS-D113`'s ground, unchanged: the source is a row for one app, a
file for another and a control plane for a third, so a declaration would have to
name one. Memoised per tenant — the PROMISE rather than the value, so two
requests for one tenant arriving together resolve once — with
`app.invalidateTenantConfig(id?)` as the explicit way out, because a memo with
none is a config change that needs a restart. A failed resolve is not memoised:
the row it reads may be a second from existing.

**The resolve happens where the tenant is already resolved, not at the point of
use.** `$.config` is a property read and a resolver that reads a row is async, and
the two cannot meet at the point of use without making every reader `await`,
which throws the read shape away. So the around hook that establishes
`ctx.locals.tenantId` warms the store before anything downstream runs — exactly
where `applyClaims` resolves the principal rather than at the point some policy
needs it — and `runAs` warms it too, because a job is the caller most likely to
need a tenant's from-address and least likely to have a request behind it. A
resolver that throws fails the call; serving the floor instead is one tenant's
mail going out under another's name.

**What may be overridden is `tenantConfigKeys`, required, and the reserved set is
refused at boot.** Not a deny-list on its own: the allow-list already says what
applies, and `RESERVED_CONFIG_PATHS` — `port`, `host`, `database`, `http`, `auth`,
`apiPrefix`, `logging` — exists for the entry somebody adds by mistake. A database
path handed to a tenant is every other tenant's rows one typo away; the rest are
read at boot with no tenant in scope, so a per-tenant answer would be written and
never read. Boot-time because a per-request refusal is a production incident and a
boot-time one is a failed start.

Laravel's `storage_to_config_map` is the shape and the confirmation that an
explicit per-key list is what works in the field. What is added here is that
**the list is committed**: it renders as § Per-tenant configuration in
`principal.snapshot.md`, so a path arriving there is a reviewable diff rather
than a line in a config file nothing compares. That list is the half that makes
the feature safe rather than the half that makes it work, which is exactly why it
is the half worth committing.

**A key the resolver answers that the list does not name is REFUSED, not
dropped.** Dropping it is a tenant whose configuration silently does not apply,
which reads as *the feature is broken* and arrives as a support ticket; the
refusal names the key and is deterministic on the first request.

What this does not do: nothing here is per-tenant unless an app opts in, an app
that installs no resolver is unchanged in every respect, and the snapshot says so
in words rather than by an empty table.

### <a id="fjs-d138"></a>2026-08-25 · `FJS-D138` — the client data lifecycle has one owner. A node per row keyed by MODEL, a list is a VIEW over it, optimism is an overlay of INTENT, and a draft never enters the store.

Four things, and until now the repo has had one of them. Each owns exactly one
question, and the whole of this ruling is that they are four and not fewer:

| | holds | keyed by | dies |
| --- | --- | --- | --- |
| **node** | the synced truth for one row | model + id | a TTL after the last view lets go |
| **view** | the ids a query answered, in order | the query | with its subscriber |
| **overlay** | a submitted mutation not yet confirmed | the mutation | on confirmation, or on rollback |
| **draft** | text somebody is typing | the form | with the form |

Today there is only the second one, per `resource()` call, holding whole rows —
so two `createResource('orders')` in two route files are two stores holding two
copies of one row (`client/index.ts`, `const store = new Store<T>()`), and a
record fetched with `service.get(id)` is a plain object no announcement can
reach. Both were measured: `example/web/src/routes/products/[id].mesa` and
`packages/basecamp/web/src/components/widgets/ServiceHealthBody.mesa` each hold
a detail row that a channel push updates nowhere ([FJS-518](ISSUES.md#fjs-518)).

**The fourth row is the ruling's center, and it exists because of `FJS-341`.**
That defect was a live store defeating `@version`: a push moved a number the
person had never read, and the save carried it and won the race the column
exists to lose. It was fixed by keeping the copies apart — the version is
recorded from READS this resource performed, never from the store. A shared
node reopens exactly that wound by default, so the separation is stated up
front rather than rediscovered: **the node is the truth, the view remembers
what it read, and unsubmitted text is in neither.** An optimistic mutation and
a draft are not the same thing — one is submitted intent and the other is text
in a box — and merging them is how a normalized cache starts overwriting the
screen somebody is working on. `@version` behavior is unchanged by this
ruling; `_versions` stays with the view.

**A node is keyed by the model, not by the service.** Junction holds no schema,
so the model name is passed in, the way `match` already is and for the same
reason (`ResourceOptions`). Keying by the service is the shape Apollo escaped
from — theirs is `__typename:id`, and their standing confusion class is the
object that failed to normalize and got embedded in one query's result instead.
A model reached through two services is one row, and `accessorCandidates` is
already the one answer to which spellings name it (Invariant 2).

**A list is a view, and the incremental placement stays exactly as it is.**
`insert`/`drop`/`place`/`verdict` in junction's `resource()` answer membership
and position per event, which is the expensive half of what a query engine
does, and they are already correct — `FJS-011` and `FJS-270` bought them.
Nothing here replaces them with a dataflow engine; the entity map goes
underneath and they run on top. `store.get()` keeps answering materialised rows,
so no screen in either app changes, and the ids become the honest interior.

**Lifetime is a TTL, not a reference count.** Apollo and Relay both ship
`retain`/`release` around a subscription and it is the most-complained-about
part of both: a lifetime the application has to remember is a leak with extra
steps. Zero's generation chose time instead, per query. A TTL also answers the
question a reference count makes awkward — list → detail → back — for free,
because the node is still warm. One number, configurable per resource, and no
`retain` in application code, ever.

**A detail read is a view of one.** `resource.record(id)` is a view whose query
is the id, running the same membership and placement path as any other, so it
is sugar rather than a second mechanism — the shape Meteor's cursors, Convex
and Zero all arrived at. `service.get(id)` stays raw and dead, exactly as
`service.find()` stays raw and does not touch the store: the escape hatch is
the raw proxy, and it opts out one call rather than the resource
([`FJS-D114`](#fjs-d114)).

**Optimism is a transaction that carries INTENT, and confirmation is keyed to
the mutation.** Not to the row: another writer patching the same row while your
write is in flight would otherwise clear your overlay, flash their value, and
then be overwritten when yours lands. The framework already owns a mutation
key — the `Idempotency-Key` claimed in `callService` — and `@version` already
says which revision a write was against. Rollback is automatic when the call
throws. **The overlay stores the intent and not the resulting value**, which
costs nothing today and is what admits a rebase later: Replicache and Zero
replay pending mutations on top of each new server state, and replay needs an
intent to replay. That direction is not taken here, because re-executing a
mutation in the browser means the gate, the row policies and the validators in
the browser, which is `compass` (`IDEAS/offline-first-and-release.md`) and not
this ruling.

**What this deliberately does not do.** No differential dataflow — the
incremental list logic is already the win that engine buys. No cursor: paging
is a separate axis (`IDEAS/client-data-lifecycle.md` hole 4), and it gets
cheaper once a list holds ids rather than rows, not harder. No offline; the
order everywhere else has been normalize first and persist second, and building
the store twice is the outcome that order avoids. And nothing new for jetty —
its store is Sierra's from two versions ago and gets the whole of this by
importing it ([FJS-493](ISSUES.md#fjs-493)).

**Why a framework may do what the libraries refused.** TanStack Query declines
normalization on the record, and the stated reason is that doing it correctly
needs a way to infer or ingest a schema, which is more opinion than a library
may hold. FrontierJS emits that schema: `$defs`, the id field, `x-relations`,
the declared unique keys, and `$checkOrderBy` as the one answer to what may be
sorted and why. The objection that kills this elsewhere is the argument for it
here — and the same asymmetry is why the cursor that follows can be derived
where Apollo makes an application hand-write a `keyArgs` and a `merge` per
paginated field.

**Build order, and it is not the order the features are interesting in.**
(1) this ruling; (2) the node map, model-keyed, in junction's client, since it
owns the socket and the store and jetty needs it too; (3) lists hold ids, with
`store.get()` materialising so nothing above changes; (4) TTL; (5)
`resource.record(id)`, which is the first behavior anybody sees and is proven
by `example`'s `verify:live` — a second tab patches a product and the detail
screen moves; (6) the transaction and the overlay; (7) cursor paging,
separately.

### <a id="fjs-d125"></a>2026-08-23 · `FJS-D125` — a query string is PARSED, by one module, with a number rule that round-trips. The schema still wins.

**Two boundaries read the same syntax and gave different answers.** Sierra's
router inferred types off a URL with `Number(value)`, so `?sku=007` became the
number 7 — the guess Sierra's own widget props already refuse for
`data-pid="007"`. Junction's transport did not infer at all. So a filter typed
into the URL bar and the same filter sent by the client meant different things,
and nobody could see it because both answered a 200.

**Worse, the two TRANSPORTS disagreed, and the socket was the correct one.**
Measured 2026-08-23 with one service echoing `typeof` for every key, one client
on HTTP and one on a live socket:

| filter | over the socket | over HTTP |
| --- | --- | --- |
| `qty: 5` | `5` | `"5"` |
| `live: true` | `true` | `"true"` → **0 rows** |
| `archivedAt: null` | `null` | **dropped** → every row |
| `id: { in: [1,2] }` | `{in:[1,2]}` | `'{"in":[1,2]}'` → **0 rows** |
| `sku: '007'` | `'007'` | `'007'` |

`buildWsQuery` spreads filters into a JSON frame; `buildQueryString` `String()`d
every scalar, `JSON.stringify`d every container and dropped `null` outright, and
nothing on the far side turned any of it back. An app therefore worked until its
socket dropped and then silently filtered on text. `FJS-450`.

**The ruling.**

1. **One module — `@frontierjs/toolbelt/query`.** Three readers: Junction's
   transport off a request, Sierra's router off a URL, Junction's client writing
   one. Same reason `/directives` and `/inflect` are there; this is the third
   invariant that had as many answers as it had callers.

2. **A string is a number only if it ROUND-TRIPS** — `String(Number(v)) === v`.
   One test, no special cases, and every trap of the `parseFloat` version falls
   out of it: `'007'`, `'0x10'`, `'+1'` (a phone number), `'1e5'`, `' 12 '`,
   `'1.50'` (money keeping its cents) and `'9007199254740993'` (a snowflake id
   whose last digit the round trip loses) all stay strings. `NaN` and `Infinity`
   round-trip and are excluded by name.

3. **`true`, `false` and `null` are themselves.** The two that were not handled
   were each a silent empty list at the Data boundary.

4. **Structure is brackets, never a sigil.** `?qty[gte]=10&id[in][]=1` — the
   operator vocabulary reaches the wire at all, and it reads as itself in a URL.
   A repeated key is an array, because that is what a multi-select form emits.
   A tilde-style type marker was considered and refused: it would appear in
   every URL an app ever showed a person.

5. **A quoted value is a literal string** — `?code="5"` is `'5'`. The single
   escape, for the 5% where a caller means text and no model is there to say so.
   It is also what the encoder emits for a string that would otherwise read back
   as something else, which is what makes the two halves exact inverses rather
   than approximately so.

6. **`undefined` is dropped; `null` is sent.** Absent and *asked for nothing*
   are the same on a wire with no way to write one. `null` is a filter.

7. **Parse where the transport LOST the types, and nowhere else.** A WS frame is
   JSON and already carries them, so running the parser over it would turn a
   filter that genuinely says the string `'5'` into 5 — the one direction the
   socket has always had right.

**The schema still wins, and that is the stated gotcha rather than a defect.**
`model Item { id String }` filtered by `?id=5` reads 5 here and Litestone
converts it back to `'5'` — measured, one row. Only the schema knows, and the
alternative is this module guessing on the schema's behalf. Where there is no
model, `?code=5` is the number and `?code="5"` is the text.

**One Data-boundary fix falls out.** A Boolean column filtered by `'true'`
matched no rows: SQLite stores 0/1, column affinity converts numeric text (which
is why `?qty=5` on an Int column always worked) and cannot convert `'true'`.
`buildWhere` converts the two spellings where `fieldKinds` says the column is
Boolean. Silent-empty was the worst of the three available answers.


### <a id="fjs-d124"></a>2026-08-23 · `FJS-D124` — `gateAuth` leads the whole chain, `before:` keeps meaning *after auth, before validation*, and `validated:` is the phase that runs after the derived layer.

**The defect that forced it** (`FJS-403`). `createBaseService` appended the
schema-derived hooks AFTER the app's own, so a model service's create ran
`<app hooks> → gateAuth → autoValidate`. Measured on `example`, two
unauthenticated POSTs to `/api/orders`: one naming a customer that does not
exist answered **400 `That customer is no longer on file`**, the identical
request naming a real customer answered **401**. That difference is an existence
oracle over a `@@gate("4.4.4.5")` table, available to anyone. The app's hook also
saw `ctx.data.total` as the wire string `"12.5"`, because the coercion that makes
it a number had not run yet.

The comment justifying the old merge argues for exactly one of the derived hooks:
a before hook should be able to shape `ctx.data` before it is validated. That
argument is sound and it does not reach the 401.

**Three rulings.**

1. **`gateAuth` runs before anything an app wrote, and it is an AROUND hook.**
   Leading the per-method list is not enough — `resolvePipelines` runs
   `before.all` ahead of `before.<method>`, so a service declaring
   `before: { all: […] }` would have kept the whole defect, and so would an app
   declaring one. A service-level around hook wraps every before hook at either
   scope, and still sits INSIDE the app-level `withLitestoneDb` that scopes the
   client the gate reads. It is one hook rather than six, because the operation
   is a property of the method; a method the table does not name is not gated
   here, which is what a custom method already had.

2. **`before:` keeps its meaning — after auth, before validation.** The
   alternative was to make it mean *after auth AND validation*, which is the
   safer default and the wrong one: it breaks every shaping hook that exists,
   and it forces the validator to run for callers an app hook is about to
   refuse. A hook that rejects a caller (basecamp's `sessionScope`,
   `requireWorkspaceRole`) belongs early, and this keeps it there.

3. **`validated:` is a real phase, between `before` and the method.** It is the
   position for a rule that reads the database off `ctx.data` — it needs a caller
   the gate has graded and a payload the validator has coerced, and before this
   there was nowhere in a service to say that. The mechanism already existed
   internally: `createService` pushes the `validateInput` map after
   `effectiveHooks`. It was simply never offered. It short-circuits like `before`
   (setting `ctx.result` skips the method) and is skipped entirely when a before
   hook has already answered the call.

**What it costs.** Every model service in every app changes run order, and both
committed `surface.snapshot.md` in this repo carry the move as a diff — which is
the point of committing them. An app whose before-hook depended on running for
unauthenticated callers on a gated model was depending on the defect. A public
model (`@@gate("0…")`) is unaffected, so a signup or a public catalogue service
does not change.

**What it does not fix.** An app-level `around: { all: […] }` hook still precedes
the gate, and must: that is where `withLitestoneDb` establishes the client the
gate grades against.


### <a id="fjs-d23"></a>2026-08-17 · `FJS-D23` — a payload key that is not a column says so in the seed, with `@transient`, and Junction lifts it onto `ctx.transients`.

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

### <a id="fjs-d36"></a>2026-08-17 · `FJS-D36` — Caravan owns the clock; `app.scheduler` is in-process only.

(Closing `FJS-047`.)

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
`packages/basecamp/api/src/services/jobs/job-schedule.ts`.

### <a id="fjs-d35"></a>2026-08-17 · `FJS-D35` — A durable effect is a NAME and a PAYLOAD in the app's own database, and the queue stays a separate file.

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
flavor of client for the refusal above.

*Still open beside this:* delivery is at-least-once, so a handler must be
idempotent — the framework hands it the outbox row id and says nothing else.

*Lives in:* `packages/junction/src/core/outbox.ts`,
`packages/junction/db/outbox.lite`, `packages/junction/src/plugins/outbox/`;
the worked example is `example/api/src/services/orders.service.ts` (`pay`).

### <a id="fjs-d30"></a>2026-08-17 · `FJS-D30` — Login stays HTTP; cycling the socket IS the login event.

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
`example/api/src/app.ts` and `packages/basecamp/api/src/app.ts`.


### <a id="fjs-d10"></a>2026-08-16 · `FJS-D10` — the deferred API cluster, ruled. Two adopted, two refused, and the fourth item turned out to be a defect wearing a naming question.

Four proposals deferred 2026-08-01 pending `FJS-D06`. Graded one at
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

### <a id="fjs-d69"></a>2026-08-16 · `FJS-D69` — deferred work runs as the ENQUEUING PRINCIPAL, re-resolved — not as a system identity, and not as nobody.

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

### <a id="fjs-d20"></a>2026-08-16 · `FJS-D20` — the developer-facing auth API. A route is what ESTABLISHES a session; everything after it is a service. The browser half belongs to the client that holds the token.

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

### <a id="fjs-d13"></a>2026-08-15 · `FJS-D13` — a stream sits OUTSIDE the result envelope. `kind` stays `single | list`.

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

### <a id="fjs-d11"></a>2026-08-14 · `FJS-D11` — Partial success extends to a filtered PATCH and REMOVE, and the reason is enforcement rather than symmetry

(Closing `FJS-044`).
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

### <a id="fjs-d01"></a>2026-08-13 · `FJS-D01` — A service is a definition and a compiled runtime, and `methods:` declares.

(Closing `FJS-016`.)

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

### <a id="fjs-d08"></a>2026-08-10 · `FJS-D08` — A method may answer what it likes; an ANNOUNCEMENT is about a row, so it carries one.

(Closing `FJS-020`.)

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

### <a id="fjs-d70"></a>2026-08-10 · `FJS-D70` — An app's own User columns reach the session through one hook, at the point the row is already in hand.

`createLitestoneAuth(db, {
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

### <a id="fjs-d71"></a>2026-08-10 · `FJS-D71` — A saved view names a declared kind. It never stores a query.
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

### <a id="fjs-d72"></a>2026-08-10 · `FJS-D72` — Where a declared vocabulary cannot bound the act, the RECORD bounds it — and the two live on separate screens with separate roles.

Ruled
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

### <a id="fjs-d73"></a>2026-08-08 · `FJS-D73` — A field that is accepted on the wire but is not a column is captured in a BEFORE hook, never read from the method body.

Ruled while
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
  the framework's behavior, which is the worst kind.
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


### <a id="fjs-d21"></a>2026-08-06 · `FJS-D21` — A custom action announces like any other write, under its own name.

Fixes `FJS-033`. `callService`'s one announcement
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

### <a id="fjs-d07"></a>2026-08-06 · `FJS-D07` — A service narrows its method set with one key: `methods`.

Fixes `FJS-004`. Two forms on the same key —
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

### <a id="fjs-d76"></a>2026-08-02 · `FJS-D76` — The result envelope has one owner, and `kind` is the discriminant.
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

### <a id="fjs-d77"></a>2026-08-02 · `FJS-D77` — `$` is transport syntax, not an internal data model.
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
**Scope, clarified 2026-08-22:** the rule is about a `$`-PREFIXED KEY —
`$limit`, `$offset`, `$orderBy`, `$select` — and about nothing else. It was
written as "`$` is transport syntax" and read for a while as a claim about the
character, which junction's ambient `$` (the service call in progress) then
contradicted by existing at all. The two are unrelated: one is a prefix on a
parameter name that the bridge strips, the other is an identifier a service
reads. No `$`-prefixed key survives the bridge; that is the whole of it.
*Lives in:* `packages/junction/src/transport/bridge.ts` (`parseDirectives`),
`src/core/context.ts` (`QueryDirectives`, `RESERVED_PARAMS`),
`src/core/litestone.ts` (`parseQuery`).

### <a id="fjs-d78"></a>2026-08-02 · `FJS-D78` — `errors[]` is load-bearing: bulk writes return partial success.
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

### <a id="fjs-d79"></a>2026-08-02 · `FJS-D79` — One event origin, and broadcasting is declared on the service.
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

### <a id="fjs-d80"></a>2026-08-02 · `FJS-D80` — Broadcasting is opt-in in the framework, opt-out in the scaffold.
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

### <a id="fjs-d74"></a>2026-08-01 · `FJS-D74` — Custom service actions stay on `X-Service-Method` header dispatch.

**Status:** amended-by [`FJS-690`](ISSUES.md#fjs-690) — dispatch is a declared table now, not a block-list, so a method attached after construction 404s. That the header is the mechanism, that case is preserved and that CRUD is refused on it are unchanged.
Proposal to move to sub-path dispatch (`POST /api/notes/:id/summary`) was
considered and declined. Case is preserved for action names (`getStats` works);
CRUD names remain blocked from header override; `restore`/`upsert` match
case-insensitively.
*Lives in:* `packages/junction/src/transport/bridge.ts` (the header, the case rule and the CRUD refusal) · `packages/junction/src/core/service.ts` (the dispatch table `FJS-690` made authoritative).

### <a id="fjs-d75"></a>2026-08-01 · `FJS-D75` — `createService({ model })` carries the derived hook layer.
The model path must always include schema-derived gates/validation
(`base.hooks` = user hooks + derived); hook-less custom actions run the `'*'`
(all-hooks) pipeline, never an empty one. Litestone error names map across the
package boundary: `AccessDeniedError` → 403, `ValidationError` → 400.
*Lives in:* `packages/junction/src/core/service.ts`, `core/hooks.ts`,
`core/errors.ts`.

## UI substrate (Mesa)

### <a id="fjs-d216"></a>2026-09-05 · `FJS-D216` — `<mesa:*>` keeps its closing slash, and the spec's own examples were wrong

`<mesa:window on:keydown={h}>` written unclosed is the only spelling §12.1
showed and the one §23's flagship complete component used, and it has never
compiled — the parser wants it self-closed and answered `Unexpected EOF`,
which `FJS-844` has since made readable. Six of the eight bad fences in
`VISION.md` were this.

**Making them void elements was refused in favour of one spelling.** They can
never have children, so accepting the bare form would cost nothing at the
parser — and it would mean two ways to write one element, in a language whose
argument is that a developer predicts more from less knowledge. The docs were
wrong; the docs are what changes.

`test/docs-fences.test.js` compiles every whole-component fence in `docs/`,
which is the artefact this ruling needs: the examples were wrong for the life
of the file because nothing had ever executed one. Fences without a `<script>`
are not graded — a fragment illustrating one attribute names bindings it never
declares, and a check that fires on correct documentation is a check people
delete.

*See `FJS-868` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `xcut-6`.*

### <a id="fjs-d211"></a>2026-09-05 · `FJS-D211` — an instance `<script>` has four export forms, and `export var` is the snapshot

RULE 56 said an instance script exports *exactly two things* and that every
other form is a compiler error. Both halves were false in different directions:
`export const` was neither refused nor implemented (`FJS-D209`), and **`export
var` is documented in §3.3 and implemented as a mount-time SNAPSHOT prop** —
read once when the component mounts and never updated by the parent again. The
summary row and §3.3 had disagreed for as long as both existed, and the row is
the one people cite.

**It stays, and it is written down.** Four forms:

| | |
| --- | --- |
| `export let` | a prop; the parent's later values arrive, the child may write it |
| `export const` | a prop the child may not write; the parent's later values still arrive (`FJS-D209`) |
| `export var` | a prop SNAPSHOTTED at mount; the parent's later values do not arrive |
| `export function` | a method on the interface `bind:this` hands the parent |

**`var` is the one form whose behavior cannot be read off its keyword**, which
is the whole cost of keeping it: in JavaScript `var` reads as *`let`, older*,
and here it means the opposite of `let` on the only axis that matters. That is
paid for with a sentence in RULE 56 rather than with a removal, because the
behavior is worth having and no better spelling has been proposed. Withdrawing
it would break whatever uses it to buy a name nobody has written yet.

*See `FJS-D209` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `xcut-5`.*

### <a id="fjs-d217"></a>2026-09-05 · `FJS-D217` — a `javascript:` URL is refused on the four attributes that navigate

`href`, `src`, `action` and `formaction` took a `javascript:` URL unfiltered,
at runtime and baked into a static file by a prerender. Mesa had no URL policy
at all.

**The scheme is refused on those four attributes, the attribute is dropped, and
a warning names it** — in both the runtime and the static render, since a
refusal in one of them is a page that ships what the other rejects.
`data:text/html` is the same door and is refused with it.

**This is an existing rule reaching a case it missed, not a new policy.**
`spreadAttributes` already refuses `innerHTML`, `outerHTML`, `srcdoc`, `text`
and a non-function `on*` by name, warning and skipping, and since `FJS-872` it
skips an attribute name the DOM rejects the same way. What made the URL case
different is only that nobody had asked it.

**Leaving it to the app was the alternative and it is what `{@html}` does.** It
was refused on frequency: `{@html}` is written deliberately and rarely, while
these four attributes take their values from data constantly, and nothing in
the package said so. The refusal is narrow on purpose — a relative URL, a
protocol-relative one, `mailto:`, `tel:`, `blob:` and `data:image/*` are all
ordinary and all survive.

*See `FJS-858` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `xcut-1`.*

### <a id="fjs-d212"></a>2026-09-05 · `FJS-D212` — a `const` is derived only when something it names can move

RULE 2 says a top-level `const` referencing another REACTIVE variable is
automatically derived. `reactiveSet` was built from every top-level binding
whose `kind !== 'var'` — every `let` and **every `const`**, static ones
included — so `const url = apiBase + '/orders'` over a static `const apiBase`
compiled to a `trackDerived` that can never recompute.

**The cost is not the wasted memo, it is that promotion makes the initializer
lazy.** `const handle = subscribe(channelId)` emits identically whether or not
the template reads `handle`, and if nothing reads it `subscribe()` never runs —
no subscription, and an `$.onDestroy` closing a handle that was never opened.
Nothing warns, nothing throws, and the value is correct everywhere it IS read.
The defect is the side effect that did not happen, which is the hardest class
of all to see.

**A `const` is promoted only when it transitively depends on something that can
move** — a `let`, a prop, or a watched import. That is what RULE 2 already
said; the word *reactive* had simply never been defined, and was doing work
nobody had written down. The transitive closure is a real pass and is the
price: the alternative considered was keeping the promotion and running the
initializer eagerly, which trades a silent MISSING side effect for a silent
EXTRA one — the same defect relocated, which `FJS-D208` refused one layer up.

**A call to a binding the script holds is a second door and the first cut
missed it.** `useStore` hands back a getter, so `const rows = useStore(s).get`
is an ordinary function and `Math.max(10, ...rows().map(f))` reads a signal
INSIDE the call, where no name the closure walks can see it. Blanket promotion
had been covering that by accident, through the memo's runtime auto-tracking.
Narrowed, `example`'s catalogue computed its price ceiling once against an
empty store and every filter above it collapsed to one row — caught by
`verify`, green in every unit suite, because the two halves of the promotion
had never been separable before. A const whose initializer CALLS a local
binding is therefore derived on the strength of the call, with no named
dependency; what it reads is decided at runtime.

**An IMPORTED function is not that door, and the asymmetry is the existing
rule rather than a new one.** `EXTERNAL_REACTIVITY.md` already requires state
arriving from outside to be declared with `$:`, and a function is state — so
`const handle = subscribe(id)` over an imported `subscribe` stays eager and
keeps its side effect, which is the case this ruling exists for.

*See `FJS-847` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `script-4`.*

### <a id="fjs-d213"></a>2026-09-05 · `FJS-D213` — in Markdown, `{…}` is a path and `\{` is a brace

Markdown prose is Mesa template source, so a brace that was never meant as an
expression is compiled as one. `A set {1, 2, 3} of numbers.` renders **"A set 3
of numbers."** — a comma operator, valid JS, no error, wrong prose — and
`FJS-D208`'s `?? ''` made it quieter still, since a free identifier now renders
empty rather than throwing.

**Interpolation in prose stays and narrows to a bare path**: an identifier or a
member chain and nothing else. Everything else is literal text, and `\{` is the
escape for a brace that would otherwise open one. `{title}` and
`{post.author.name}` are unchanged; `{ y }` and `{1, 2, 3}` are prose again.
What is given up is `{a + b}` inside a `.md`, which nobody has asked for and
which a `<script>`-computed `const` covers.

**The neighbours were surveyed and they split two ways.** MDX treats `{}` as an
expression everywhere, documents `\{` on its front page, and errors loudly on a
malformed one; Vue, Astro's content collections, Jekyll, Hugo and Eleventy all
leave a single brace as prose and interpolate with a two-character delimiter.
Nobody interpolates single braces silently. Two braces in `.md` was the
strongest alternative and was refused on **coherence**: `.mesa` and `.md` would
then disagree about the delimiter, and one language with two spellings of
interpolation costs more than the expressions given up.

*See `FJS-873` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `ssr-6`.*

### <a id="fjs-d214"></a>2026-09-05 · `FJS-D214` — a server render stays silent about browser globals, and says so in the contract

During a server render `window.innerWidth` answers `1280`, `navigator.userAgent`
answers `Node.js/22` and `matchMedia().matches` answers `false`, because the
render runs inside happy-dom. A responsive component bakes the desktop branch
and nothing says so. A diagnostic is mechanically possible — every one of those
globals is configurable on happy-dom 20 — and it is refused.

**Every neighbouring rule is deliberately silent.** `{@attach}` does not run on
the server, `$.onMount` is inert, `watchProxy` is off (`FJS-146`, RULE 19).
Warning here would break that pattern with nothing behind it, and it would fire
on every page of a Sierra prerender — hundreds — which is how a console stops
being read at all. The failure this would catch is real and rare; the noise
would be constant.

**What was actually missing is a position.** `SSR_SPEC.md` is the server-render
contract and took none, so an author had nowhere to learn the trap before
hitting it. It now states which globals answer and what they answer, which is
the artefact the ninth question asks for: this ruling knowingly leaves a defect
invisible at runtime, so it may not also be undocumented.

*See `FJS-870` and the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `ssr-1`.*

### <a id="fjs-d206"></a>2026-09-05 · `FJS-D206` — `{@html}` is the only way to write markup from a value. `innerHTML`, `textContent` and `innerText` leave `_DOM_PROPS`

`set_attribute` decides property-vs-attribute from a fixed list of DOM property
names, and three of them parse or replace content: `<div innerHTML={h}>` renders
`h` as markup. Measured, rendering a live `<i id="pwn">`. It is not the spread
hole (`FJS-837`) — there the KEY comes from data, here the author wrote the
attribute, which is the same thing that makes `{@html}` acceptable.

**The objection is not danger, it is that there are two spellings and only one
announces itself.** `{@html}` is a construct a reader stops at and RULE 33 warns
about it. An attribute among other attributes reads as ordinary markup, and
nothing in VISION or `CLAUDE.md` mentions it — so a reader who has met RULE 33
reasonably concludes the other forms were considered and are safe.

**Nothing in either app uses the spelling**, so removing the three keys costs no
existing code; they fall through to `setAttribute`, where an `innerHTML=`
attribute is inert. `{@html}` becomes the one owner of *parse this as markup*,
which is the rule `set_attribute` and `bindClassPassthrough` already argue for
in their own header blocks.

*Closes the question raised by `FJS-837`'s fix, which found the claim that
`set_attribute` refuses to be a sink was false. See the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe).*

### <a id="fjs-d208"></a>2026-09-05 · `FJS-D208` — a template path is an ordinary expression. RULE 12 is withdrawn, and a nullish interpolation renders empty

RULE 12 promised that the compiler wraps every member chain in a template with
optional chaining and a nullish fallback — `cart.user.prefs.theme` generating
`cart?.user?.prefs?.theme ?? ''`, quoted as *zero runtime errors*. None of it
was ever implemented: the compiler emits the raw chain and a deep path throws
out of `createEffect` at mount. It was the most-cited safety promise in the
language document and the most-read sentence the code did not honour.

**Implementing it was refused because it converts a visible failure into an
invisible one.** Under the rewrite a misspelled path and a genuinely absent
value are indistinguishable: both render empty, neither reports, and the
component looks like it works. That is the class this audit spent two waves
closing, bought back one layer up.

**The empty string is kept, and it is a separate and narrower rule.** RULE 12's
`?? ''` was where an author reasonably expected `{maybe}` to render nothing
rather than the literal word `undefined`, and that is a real defect on its own
(`FJS-854`): the compiler wraps every interpolation in a template literal, so
the nullish guard both runtime text writers carry is unreachable. Coercion moves
to the one owner that writes text, and does not require the path rewrite.

*See the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `dom-3` and `dom-2`.*

### <a id="fjs-d209"></a>2026-09-05 · `FJS-D209` — `export const` is a prop the child may not write. RULE 56 gains a third form

RULE 56 said an instance `<script>` exports only `export let` (a prop) and
`export function` (a method on the interface `bind:this` hands the parent), and
that every other form is a compiler error. `export const` was neither refused
nor implemented: it compiled to `const x = props?.x !== undefined ? props.x : 1`
— a prop, but a plain `const`, so the parent's later values never reached it and
a child write failed at runtime with *Assignment to constant variable*, naming
neither the prop nor the file.

**The concept was right and the implementation was not, which is why it stays.**
An author reading `export const x = 1` reads *a prop, with a fallback, that this
component will not change* — and that is a thing worth being able to say. Half
of it already existed: `export let x = 1` compiles the fallback in exactly that
way. What was missing is the guarantee, and the compiler refuses a write to no
constant today, exported or not.

**It compiles to what `export let` compiles to, minus the setter.** The same
tracked signal, so a fallback works and a later value from the parent reaches
the child; no `$$set_x`; read-only through `bind:this`; and a write in the child
is refused at compile time naming the prop. **Immutable describes the child, not
time** — a value frozen at mount would make a parent's update a silent stale
screen, which is the failure mode this whole audit is about.

*`FJS-867`. Zero instance scripts in this repo use the form, so the change is
additive; all 66 occurrences of `export const` are in `<script module>`, where it
is an ordinary ES export and is untouched. See the [Mesa audit](https://claude.ai/code/artifact/05d792af-815d-4b4b-b2d8-9c9cb21efabe), `xcut-5`.*

### <a id="fjs-d136"></a>2026-08-24 · `FJS-D136` — on an ELEMENT, `bind:` means the DOM writes back, so it is form values and nothing else. On a component it is unchanged.

`bind:value`, `bind:checked`, `bind:files` — plus `bind:group` and `bind:this`,
which have their own paths. Every other `bind:x` on an element is a compile
error naming `x={expr}`, the one-way form, which already works.

**The second direction was never there.** A two-way binding needs something
other than you to change the value, and nothing in the DOM changes `readonly`,
`colspan` or `contenteditable` by itself — there is no event, so the read-back
handler can never fire. What made this a defect rather than a redundancy is
that the FIRST direction was often missing too: everything but the special
paths landed in `bindInput`'s generic branch, which is `el[name] = v` with a
read-back of `el[name]`, and for the eight attributes whose DOM property is
spelled differently — `for`/`htmlFor`, `readonly`/`readOnly`,
`maxlength`/`maxLength`, `minlength`, `tabindex`, `colspan`, `rowspan`,
`contenteditable`, and `class`/`className` — that writes a **JS expando the DOM
never reads**, in both directions. `FJS-478` is the measured case; the others
are the same shape and were found looking for siblings of it.

**Sized before ruling, and the exposure is zero.** Every `bind:` in this repo is
a form value (`value` 91, `this` 40, `checked` 8, `files` 1) or a **component
prop** — `record`, `sort`, `page`, `open`, `errors`, `active`, `submitted`,
`dirty` — and a component prop goes through `bindProp`, a different path
entirely. Not one element in the workspace binds an attribute this rule
touches.

**The alternative was an alias table** mapping the nine attribute spellings onto
their DOM properties. Rejected because it buys plumbing for bindings that can
only ever be one-way: `bind:readonly` would then WRITE correctly and still never
read back, which is a binding that looks two-way and is not — the shape this
ruling exists to remove.

**A future readonly binding is a different feature with a different name.**
Svelte's `bind:clientWidth` is the shape — element → variable, one direction,
observer-backed — and if that is ever wanted here it arrives as its own thing
rather than as a loosening of this rule.

*Lives in:* `DOM_TWO_WAY` in `packages/mesa/src/compiler.js`, checked at the one
site that emits `bindInput`. `emission.test.js` runs the accepted set, the
refusals, and a component prop for each refused name.

### <a id="fjs-d137"></a>2026-08-24 · `FJS-D137` — `__` is the fourth tier and it is the CALLING CONVENTION. It does not converge on `$$`, because three of its four names are protocol.

`$` the door · `$:` the label · `$$` the compiler's locals · `__` how a
component is called.

`FJS-470` closed intending a three-line rule and left `__anchor`, `__block`,
`__props` where they were, calling that half open. It is closed here as a
statement rather than a deferral, and the reason is `FJS-D134`'s: **jetty's
build plugin matches those three by name**, as text, out of compiled output —
`/export default function (\w+)\(__anchor,\s*__props,\s*__block\)/`. That
makes them protocol, and a protocol name does not move with a tiering change.

**The convergence framing was wrong about the population, which is why it kept
looking unfinishable.** `__` holds three kinds of thing and only one of them is
a name any rule can touch:

| the calling convention | `__anchor` `__props` `__block` `__prev` — parameters, in scope, three of them protocol |
| runtime properties | `$$runtime.__dev`, `n.__resolving` — properties, not scope names, unshadowable |
| generated locals | `__a`, `__args`, `__r` — inside emitted callbacks, unreachable |

Renaming the second group is meaningless and the third is free and pointless.
The argument was only ever about four names, three of which cannot move without
a version bump and a coordinated jetty change.

**What decided it was watching the same move fail today.** `FJS-470` renamed
`$runtime` to `$$runtime` for a naming rule with no user-visible benefit, and
that rename silently broke jetty's HMR registration for every component with a
delegated event — undetected for weeks, behind ~450 green tests (`FJS-481`).
Doing it again, against a name read by a regex in the same package, to shorten a
sentence in a document, is the same trade with the same downside and less to
show for it.

**And the distinction is real rather than an excuse.** `$$sig_c` is something the
compiler CREATES for the author's variable; `__anchor` is HOW YOU CALL the
thing. A rule with four lines that are each true beats three with a silent
exception.

The four names are reserved (`FJS-482`), so the collisions refuse rather than
compiling and failing at mount.

**One named exception remains inside `$$`, and it is stated rather than
tolerated**: `$class` and `$dom` keep a single `$` because they are protocol
too (`FJS-D134`) — `$class` is the prop the `{class}` shorthand travels under
and `runtime.js` reads it by name, `$dom` is the key a block factory answers
with. Emitted output carrying a single-`$` name is therefore correct for exactly
these two, and `FJS-470`'s *no single-`$` name* is read with that exception.

*Lives in:* `BUILTIN_LOCALS` in `packages/mesa/src/compiler.js`, VISION § 17's
rule table, and `packages/jetty/src/build/mesa-plugin.js`, which is the reader
that makes three of them protocol.

### <a id="fjs-d135"></a>2026-08-24 · `FJS-D135` — the five members read as DATA carry a bare spelling as well as the door one, and the bare one is canonical. What is CALLED keeps the door.

`{...$attributes}`, not `{...$.attributes}`. `$props.x`, `$slots.default`,
`$context.form`, `$async.rows.fetching`. The door still answers all five and
always will — one binding under two names, aliased at emit — but the bare
spelling is what the docs and this repo's own components use.

**The measurement is what decided it, and it is lopsided.** `$.attributes`
appears 82 times in this repo's `.mesa` files and **81 of those are the single
spread `{...$.attributes}`** — sitting in markup, where `$.` is JavaScript
punctuation in the middle of HTML. `$.context` is 51, `$.slots` 10, and
`$.props` and `$.async` are **zero**. So the complaint is not about twelve
members; it is about one shape, and the shape is in the template.

**The line is how the author READS it, not how the compiler treats it.** A data
bag is a name and then a key. A call is a call:

| bare and door | `$props` · `$attributes` · `$slots` · `$context` · `$async` |
| door only | `$.onMount` · `$.onDestroy` · `$.onCleanup` · `$.mounted` · `$.tick` · `$.emit` · `$.inspect` · the five animation helpers |

`$.context` and `$.async` are on the sugar side even though neither is a plain
object underneath — `$.context.k` compiles to a `$$ctxRead` call and `$.async.x`
is generated per awaited variable. That is deliberate: the author writes
`$context.form` and `$async.rows.fetching`, which read as a key on a bag, and
what the compiler does under them is not a fact the spelling should carry.
Sorting by implementation would have put the two most-used members on opposite
sides of a line nobody writing a component can see.

**`FJS-D132` is amended, not reversed.** Its sentence was *the compiler stops
injecting a name into the author's scope*, and for seven of the twelve that
stands. What it bought is untouched: the collision class `FJS-471` names is
still closed, because the five bare names **stay reserved** — a top-level
`let $props` is refused rather than silently shadowing the injected one — and
they were never available to an author in the first place. Every one of the
twelve was already refused by name, so the sugar costs no namespace at all; it
changes five names from *refused, pointing at `$.x`* into *an alias for `$.x`*.
`FJS-470`'s win is likewise untouched: `$foo` is an ordinary user name for every
`foo` outside these twelve, and the compiler still emits nothing under a single
`$` that is not author-space.

**Two spellings is the real cost and it is paid once, in the docs.** Which is
why the bare one is canonical rather than merely permitted: two spellings with
no stated preference is how a codebase ends up using both at random. The repo's
own 143 sites across 79 files were moved in the same commit.

**One thing the sugar did NOT make go away**, and it was measured: `{$context.k}`
in a template is the same silent `undefined` that `{$.context.k}` was, because
the sugar rewrite is script-only. `FJS-477`'s template refusal covers both
spellings for exactly that reason — the bare form is now the one people will
write, so it is the one that had to be caught.

*Lives in:* `SUGAR_MEMBERS` and `REFUSED_BARE` in
`packages/mesa/src/compiler.js`, the `$sugar-decl` emit block beside
`$dollar-decl`, and `BUILTIN_LOCALS` for the reservation. `emission.test.js`
runs both spellings and asserts they are one binding;
`packages/cli/tests/generated-mesa.test.js` reads the refused list off the
compiler rather than restating it.

### <a id="fjs-d134"></a>2026-08-24 · `FJS-D134` — the component protocol is a fourth namespace, and a name in it is frozen where the other three are merely spelled.

`class`, `$class` and `children` are not scope-locals. They are the keys two
COMPILED components pass each other, and `runtime.js` reads them as strings —
`restProps` skips `['class', '$class', 'children']` by name, and
`bindClassPassthrough` merges the value that arrived under `$class`. They belong
to none of the three tiers `FJS-D132` and `FJS-470` are about: not the `$` door,
not the compiler's emitted locals, not block plumbing.

**The distinction is what a rename BREAKS, and it is a different kind.**
Retiring the bare `$onMount` broke source, which recompiling fixes; the whole of
`FJS-D132` phases 3 and 4 was one codemod and a rebuild. Renaming a protocol key
breaks compiled output meeting other compiled output — a published
`@frontierjs/ui` compiled by one version of mesa, consumed by an app compiled by
another, with nothing at either build saying so. Measured while attempting
`FJS-470`: renaming `$class` to `$$class` compiled cleanly, parsed cleanly, and
silently broke class passthrough between every parent and child.

So a protocol key does not move with a tiering change, and moving one is its own
decision with a version bump attached.

**`RULE 31a` is corrected rather than kept.** It called `$class` *a
compiler-internal name*, which is the reading that invites exactly the change
measured above — internal names are precisely what `FJS-470` moves. It is not
internal: it is shared between two packages and between any two compiled
components. What the rule was protecting is still true and is now said directly
— a component never declares `export let $class`, because the `{class}` and
`bind:class` forms wire it, and an author who writes it by hand is writing a
prop the runtime will also try to merge.

Not a hazard in the `FJS-471` sense, and that was checked rather than assumed:
`$class` is auto-declared only where the shorthand is used, so an author
declaring it in any form still compiles and parses, and no `.mesa` file in this
repo mentions it.

**A fourth name was listed here on the first writing and has been removed.**
`$$main` was the reserved key `makeClassResolver` used for the unnamed root when
resolving named part overrides out of `$option.$class`, and it was never
protocol because it was never anything: the compiler's only `getClassMap()`
returned `{ classMap: {}, metaClass: {}, main: null }` and had no caller, so the
branch reading it was unreachable twice over. The function, the stub and the
unused `passingClass` flag are deleted. The rule stands on the three that are
real — a name being read as a string by the other package is what puts it in
this namespace, and a name nothing reads is in no namespace at all. The feature
it was parked for is `IDEAS/child-part-styling.md`, which does not want it: with
the root addressed by plain `class=` and named parts by their own channel, there
is no unnamed case for a reserved key to stand in for.

### <a id="fjs-d132"></a>2026-08-23 · `FJS-D132` — Mesa reserves `$` twice and differently: `$` the object is the door to this component instance, `$:` the label is the reactive watch. Separate namespaces, no relation.
**Status:** amended-by [`FJS-D135`](#fjs-d135) — the clause *the compiler stops injecting a name into the author's scope for any of them*. Five of the twelve carry a bare spelling and it is canonical; `$` the door and `$:` the label are untouched. `VISION.md` §17 rules 18a and 18b are still this ruling's.

The twelve compiler-injected builtins move onto one object. `$onMount` becomes
`$.onMount`, `$props` becomes `$.props`, `$context.theme` becomes
`$.context.theme`, and the compiler stops injecting a name into the author's
scope for any of them. The full list, which is the whole of what moves:

| lifecycle | `$.onMount` · `$.onDestroy` · `$.onCleanup` · `$.mounted` · `$.tick` |
| instance | `$.props` · `$.attributes` · `$.slots` |
| channels | `$.emit` · `$.inspect` |
| state | `$.context` · `$.async` |

**This is not a new door. It is finishing one already half-open.** `$` exists in
Mesa today as a thin compile-time namespace holding the animation helpers —
`$.transition`, `$.entrance`, `$.fade`, `$.slide`, `$.fly` — emitted as a
module-level `const $ = { … }` and used at nine sites in `@frontierjs/ui`. What
this ruling does is widen a set that was already there and never argued for.

**It also retires a substring sniff.** The animation namespace is injected on
`rawScript.includes('$.transition')` over the raw source, so a mention inside a
comment injects it and `$['transition']` does not. Once `$` is always emitted
that heuristic has nothing left to decide.

**`$:` and `$_name:` stay, and they cannot conflict.** A reactive watch is a
labeled statement, which is syntax rather than a value, so it can never become
`$.watch`. It is also the most-typed `$` in the repo — 235 uses against 252 for
all twelve builtins combined. The absence of conflict is structural rather than
lucky: the compiler matches on the `LabeledStatement` node type, so detection is
never textual, and JavaScript keeps labels in a namespace separate from
bindings, so `$` the const and `$` the label cannot see each other. A
statement-position `$ ? a : b` disambiguates from `$: …` in the parser.

So the claim this ruling licenses is **"`$` is one identifier and one label"**,
not "`$` is one object". Stating the weaker thing is the point — the stronger
sentence would be false the moment anyone typed a watch.

**Three refusals, each by name at compile time.** `$` may not be destructured,
aliased or shadowed. The reason is the same trap Junction's ambient `$` carries:
`const { props } = $` snapshots a reactive getter, and every read after it is
silently stale. Mesa already refuses by name in this class — an unknown `mesa:*`
block, an instance `<script>` export that is neither `export let` nor
`export function` — so this is the existing mechanism rather than a new one.

**Sierra does not join, and the reason is the dependency direction.** The
tempting extension is `$.page`, `$.session`, `$.theme`. Mesa is the leaf
(Invariant 1) and cannot know Sierra exists, so an extensible `$` would need a
registration seam — which is precisely the `externalSignals` map that
`externalReactivityHints: 'strict'` deliberately closed, where strict is the end
state and not a migration aid. Reopening it to make one namespace prettier trades
a ruled boundary for a cosmetic gain. `$` therefore means *this component
instance*, a closed set, and Sierra keeps ordinary imports.

**Compiler internals are deliberately out of scope and are the follow-up**
(`FJS-470`). `$runtime`, `$dom`, `$option`, `$parentElement`, `$class`,
`$domFirst` and `$domLast` keep their single `$` for now. The consequence to
state rather than hide: the sentence *`$foo` is an ordinary user variable name*
is **not** true when this lands, and must not be written into `VISION.md` until
the follow-up does. What this ruling delivers is one door and one label; what it
does not yet deliver is a clean namespace.

**Cost, measured.** 252 author sites across 122 of the repo's 296 `.mesa` files
— `$onDestroy` 90, `$attributes` 82, `$context` 51, `$onMount` 19, `$slots` 10.
The other six builtins have no in-tree uses at all and move as pure surface. The
change is mechanical, and the one non-textual part is that `$` stops being a
module-level const of pure functions and becomes a per-instance object, because
`$.props` and `$.slots` are per-instance where `$.fade` is not.

### <a id="fjs-d115"></a>2026-08-22 · `FJS-D115` — A destructive action confirms itself with an attribute, and one delegated listener answers.

The kit already shipped `ConfirmationPopover` and it is wired per call site: a
trigger snippet, an `onconfirm`, about ten lines of markup each. **What that cost
was measured, not argued.** basecamp — the largest app in this tree — has 16
destructive one-click buttons (`Delete` / `Remove` calling `remove(row)` straight
off `onclick`) and not one confirmation of any kind: no popover, no
`window.confirm`, not one *cannot be undone* string anywhere under `web/src`.
`example` uses the popover once. The component was not rejected. It was
out-competed by not doing it, which is what every rule with a cost and no default
loses to.

So the affordance costs a word now:

    <button class="btn danger" data-confirm="Delete this order?"
            on:click={() => remove(order)}>Delete</button>

`<ConfirmProvider />` is mounted once near the root, beside `<Toaster />` and
`<AlertProvider />`. It installs ONE listener, at the document, in capture phase
— which is Invariant 11's argument (the nearest delegation root owns an event)
applied to a root that is above Mesa's own: stopping propagation there is exactly
what makes the guarded handler not run.

**The re-fire is the mechanism, and `el.click()` is why it is one mechanism.** On
confirm the element is marked and clicked again; the mark is what lets the second
click through. That single re-fire covers all three shapes an action arrives in —
a delegated handler sees a bubbling click, a submit button submits its form, an
anchor navigates — so there is no per-shape branch to get wrong. Wording is read
off the element (`data-confirm-title`, `data-confirm-label`, `data-confirm-tone`),
and a valueless `data-confirm` asks for the app's default rather than for a blank
panel.

**One panel, not two.** `ConfirmPanel.mesa` is the confirmation itself, anchored
to an element; `ConfirmationPopover` keeps its trigger API and renders it, and
the provider renders it against whatever was clicked. The alternative was the
same panel written twice, drifting on which one closes on Escape — and the
evidence that this drift is real is in the app this was read from, which had a
`use:confirm` action sitting beside its attribute with zero call sites.

`data-return`, the sibling the same app writes in the same shape, is deliberately
NOT part of this. The mechanism looks identical and the owner is not: *where does
back go* is navigation, and the kit does not depend on a router. `FJS-D118`.

— `packages/ui/components/overlay/{ConfirmProvider,ConfirmPanel}.mesa`,
`test/browser/specs/confirm-attribute.spec.mjs`.

### <a id="fjs-d116"></a>2026-08-22 · `FJS-D116` — A component file may export the verbs that belong to its noun, and two boundaries say when it may not.

The same rule `FJS-D112` gave a resource file, applied to a component: the file
owns the noun, so it owns the verbs that only make sense for that noun.

    import FileUpload, { formatBytes, isImage } from '@frontierjs/ui/components/forms/FileUpload.mesa'

It costs nothing to allow, and that was measured rather than assumed: a
`<script module>` export compiles to a plain top-level ESM export beside
`export default`, so a caller importing the function alone imports a function —
no component is instantiated and a bundler can drop the rest.

**Why not keep the kit's three homes.** The argument for holding the line was
that `utils.js`, a store and an instance API already cover it, and a fourth place
is a fifth place to look. That is backwards: a verb in the file that owns its
noun is FEWER places, and the import line says where it came from. Invariant 4
does not decide this either — one owner is satisfied by both arrangements, since
the invariant is about one owner per translation and not about which file a
function sits in.

**The two boundaries are where it stops:**

1. **A second caller moves it out.** A verb one component owns stays there. The
   moment a sibling component needs it, it goes to `utils.js` — otherwise the
   kit grows component→component imports, and a flat helper module becomes a
   lattice nobody can safely edit.
2. **A `.mesa` import needs the Mesa build plugin**, so it cannot cross into
   anything running outside that build — an API service, a node script, a
   migration. A pure function the SERVER would also want belongs in
   `@frontierjs/toolbelt` (`FJS-D26`), which is exactly the argument `/inflect`
   already settled.

`formatBytes` and `isImage` moved out of `FileUpload`'s private scope as the
first instance, and the kit's browser drive imports them by name and renders what
they answer — a claim about the compiler and the bundler, so it is asserted
through both rather than described.

The other half of the question is answered by what the kit already ships. The app
this came from writes `use:empty={{name, span}}` for an empty table row; `Table`
here takes an `empty` snippet and an `emptyText` prop, which is the same idea in
the form this component model already has. Nothing to build, and an attachment
would be a second way to say it.

— `packages/ui/components/forms/FileUpload.mesa`, `packages/ui/CLAUDE.md`.

### <a id="fjs-d17"></a>2026-08-16 · `FJS-D17` — A UI plugin contributes a CONTROL, and a control is two registrations in two packages.
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

### <a id="fjs-d18"></a>2026-08-15 · `FJS-D18` — Braces mean *run code*; parentheses mean *watch*. A block whose body only reads values is refused by name.
`$: (a, b)` is a multi-path watch. `$: { (a, b) }` is a compile error — as are
`$: { }`, `$: { count }` and `$: { cart.total }`. The two forms parse to the
*same AST* (a `SequenceExpression` of identifiers), so the parentheses are the
only thing that separates them and the check reads them from source position.

Why: effects do not drive renders in Mesa — a template's `{a}` tracks its own
reads — so an effect with no side effect is unobservable, and every one of those
forms is somebody reaching for braces to express a watch. Reporting it costs
nothing, because it is decidable, and the previous behavior was worse than
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

### <a id="fjs-d81"></a>2026-08-05 · `FJS-D81` — A component's composition API is snippet props, and a snippet's arguments are getters.
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

### <a id="fjs-d82"></a>2026-08-05 · `FJS-D82` — `$attributes` is the REST of the props, and a portal is a delegation root.
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

### <a id="fjs-d83"></a>2026-08-05 · `FJS-D83` — A compiler error fails the build.
`analysis.errors` is not advisory: Sierra's `mesa-plugin` throws rather than
serving the module.

Why: a settings screen with five `bind:` errors in it — each one correctly
diagnosed as "must be a writable top-level `let`" — rendered, looked right, and
silently collected nothing, because the plugin forwarded `warnings` and never
looked at `errors`. A diagnosis nobody sees is the same as no diagnosis, and
this repo's recurring failure mode is exactly that: the compiler knew.


### <a id="fjs-d84"></a>2026-08-04 · `FJS-D84` — `x = x` forces a notify — the same idiom for local state and for watched imports.
Self-assignment on a reactive binding compiles to a write that skips the
equality guard, so `user.score += 10; user = user` re-renders. It reads as a
no-op and deliberately is not one: it is how you say *"I mutated this in place,
notify anyway"*.

Why: the idiom already existed and already meant exactly this — for an
**imported** proxy root, `themeNew = themeNew` compiles to `$$fire_themeNew()`
(ES module bindings are read-only, so the assignment could never have been
literal). For a **local** `let` it compiled to an ordinary `$$set_user(user)`,
and signals write through `Object.is`, so the identical reference was skipped and
nothing happened. One idiom, two behaviors, no diagnostic — and the natural
guess for anyone arriving from Svelte, where `x = x` is the standard nudge.

**The force is per-write, never per-signal.** `track()` has carried an unused
`_alwaysNotify` flag that would have made a binding always notify; that is the
wrong shape, because it discards the equality optimization for every ordinary
write to that binding. `createSignal`'s `write(next, force)` and
`set(tracked, value, force)` take the flag per call instead, and only the
self-assignment call site passes it. RULE 43 is unchanged: a bare mutation with
no assignment is still inert.
*Lives in:* `packages/mesa/src/compiler.js` (`rewriteAssignments`, beside the
imported-proxy case it mirrors), `packages/mesa/src/runtime.js`
(`createSignal`, `set`), VISION **RULE 43**; pinned by three tests in
`test/compiler.test.js`, one of which asserts an ordinary equal write is still
skipped.


### <a id="fjs-d85"></a>2026-08-03 · `FJS-D85` — Scoped CSS binds to the selector's SUBJECT, not to an ancestor.
A component's `<style>` rules are emitted by appending the component hash to the
**rightmost compound selector** (`button` → `button.mHASH`), and every element in
a styled component carries that hash. Two things follow, and both reverse the
previous behavior: a component **can** style its own root element, and it
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

### <a id="fjs-d86"></a>2026-08-03 · `FJS-D86` — CSS scope ids are content-addressed, never generated.
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

### <a id="fjs-d87"></a>2026-08-03 · `FJS-D87` — A page assembles its own styles; the renderer offers both shapes.
`renderComponent` returns `.styles` — `[{ id, css }]` per component in tree order
— alongside the concatenated `.css`, and `styleTag: false` suppresses the blob it
otherwise prepends to `.html`. A caller emitting `<style id="mHASH">` per
component gets dedupe for free: the id is the scope hash, so the runtime's
`addStyles` treats the block as already present. Sierra's prerenderer does this,
taking an island's CSS on a static page from three copies to one.
*Lives in:* `packages/mesa/src/render-component.js`,
`packages/sierra/src/build/prerender.js` (`wrapDocument`).

### <a id="fjs-d88"></a>2026-08-03 · `FJS-D88` — The NEAREST delegation root owns an event; ancestors stay out.
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

### <a id="fjs-d89"></a>2026-08-03 · `FJS-D89` — An ancestor island's mount is authoritative; `client:static` under a live parent cannot be honored.
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

### <a id="fjs-d90"></a>2026-08-03 · `FJS-D90` — A prerendered page's CSS keeps its scoping; only the inlining targets flatten it.

`renderComponent`'s `email` and `fragment` targets push
declarations into `style=""` attributes, so their selectors are consumed and
flattening them is harmless. The `html` target ships a `<style>` block, where the
hash is the only thing keeping one component's rules off another's markup.
*Lives in:* `packages/mesa/src/render-component.js` (`compileTree`, `opts.descope`).

---

## Design system (`@frontierjs/css`)

### <a id="fjs-d94"></a>2026-08-16 · `FJS-D94` — A theme ships no selector, so anything a look needs is a token — and a token has to reach a descendant to count.

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
`:root`'s own `--surface`, and inherits that color past every `.theme-*`. The
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

### <a id="fjs-d91"></a>2026-08-08 · `FJS-D91` — There is no Menu term. A dropdown menu is Popover + Items.menu + a keyboard contract, and the third one is not CSS.

Asked while building the wizard: does the vocabulary need Menu or Dropdown?

It does not, and the reason is the same one that made Bar and Toolbar two
terms rather than one with a variant. **A role is a promise the app owes.**
`role="menu"` tells a screen reader the list is one tab stop and the arrow
keys move within it; a stylesheet cannot implement any of that. A term named
Menu would advertise a contract the package has no way to keep, and the
person who trusted it would ship a menu harder to use than a plain list of
links.

The composition already exists and is what everything real uses:
`.popover` is the surface, `.items.menu` is the list, and the behavior comes
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

### <a id="fjs-d92"></a>2026-08-08 · `FJS-D92` — The guide gets a decision wizard, and its tree names terms only.

`guide/decisions.js`, first page of the guide, new `Learn` nav group.

The guide was 48 reference pages and no entry point. Every one of them answers
"how does Badge work" for somebody who has already decided they want a Badge —
and nothing answered the question that comes first, which of the 54 terms the
thing in front of you actually is. That question is where the mental model
lives: Pill or Badge, Bar or Toolbar, Alert or Toast or Dialog, Item or Row.

**A wizard rather than a lesson**, chosen deliberately over a linear
first-principles walkthrough. A lesson is read once; a decision tree is
returned to, and the near-miss pairs are the thing people get wrong repeatedly
rather than the thing they fail to learn initially.

**Questions are about behavior, placement and promise — never about looks.**
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

### <a id="fjs-d93"></a>2026-08-08 · `FJS-D93` — Syntax highlighting is `glow()` in `@frontierjs/toolbelt/glow`, and its theme is element selectors in `@frontierjs/css`. Neither side knows a class.

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
relative color syntax exposes the channels of one origin color, and the origin
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
all three variants is 6.02:1. `.outlined`'s border takes the same color, which
is WCAG 1.4.11 rather than 1.4.3: a boundary at 1.99:1 is the variant not being
drawn.)*

Comments and punctuation are deliberately **not** derived — they are the
theme's own `--ink-mute` and `--ink-soft` verbatim, so retuning a theme's ink
ramp moves them, and a theme whose muted ink does not read is visible as a
theme defect rather than absorbed here (`FJS-125`).

---

### <a id="fjs-d95"></a>2026-08-08 · `FJS-D95` — The tint ramp is three named tokens, and `tones.css` is the only place the percentages live.
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

Every rendered color in the package is byte-identical after the change —
verified in a browser against a captured baseline (toned/untoned Card, nested,
dark theme, both lineages), not assumed. Five tests in `tones.spec.js` pin it,
including one that overrides `--tint-surface` and asserts a Card follows.
*Lives in:* `packages/css/src/foundation/tones.css`; read by `surface.css`;
`guide/guide.js` → *Tones & contrast* → "The tint ramp".

### <a id="fjs-d96"></a>2026-08-08 · `FJS-D96` — `Bar` and `Toolbar` are two terms. The difference is a promise, not a pixel.
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
keyboard behavior is a component*. The app owes a roving `tabindex`,
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

### <a id="fjs-d97"></a>2026-08-08 · `FJS-D97` — The vocabulary covers everything the stylesheet ships, and a test says so.
Six tiers grew to **eight**, and the term count is `vocabulary.js`'s to answer —
the suite reads it, so a number written here is one nothing checks. Nothing was
designed: the CSS already shipped every addition and the vocabulary simply did
not name it.

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

### <a id="fjs-d98"></a>2026-08-08 · `FJS-D98` — `Pill` is the count and `Badge` is the status. Kept, against the industry.
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

### <a id="fjs-d99"></a>2026-08-08 · `FJS-D99` — UnoCSS is supported alongside `@frontierjs/css`, not banned.
Amends Invariant 13, which previously read "No UnoCSS, no utility classes,
anywhere." The semantic half of the invariant stands unchanged and is the part
that matters: style with a **tone** and a **treatment**, never a color. What
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

### <a id="fjs-d100"></a>2026-08-08 · `FJS-D100` — The type scale is tokens. No literal `font-size` in a component.
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

### <a id="fjs-d101"></a>2026-08-02 · `FJS-D101` — An alias token declared in `:root` is always wrong.
If token A should follow token B, write the fallback at the *use site* —
`var(--ring, var(--color-primary))` — and do not declare A at all. The
`:root` form (`--ring: var(--color-primary)`) looks equivalent and silently
is not: the `var()` resolves once against `:root`'s own value and the result
inherits straight past every `.theme-*` override. This has now bitten twice:
`--badge-radius` (Elite's square buttons kept round badges) and `--ring`
(**every** focus ring in **every** theme was the default blue). There is no
case where the `:root` form does what it looks like it does.
*Lives in:* `packages/css/src/foundation/tokens.css`; tested in `test/specs/focus.spec.js`.

### <a id="fjs-d102"></a>2026-08-02 · `FJS-D102` — One focus ring, in the last cascade layer.
`focus.css` writes the whole recipe once, at `:where()` specificity, in the
`a11y` layer. Variation goes through `--ring-color` / `--ring-width` /
`--ring-offset`, never a second recipe. It is in the last layer so a component
cannot switch the ring off by accident — which is exactly what had happened:
`.btn.outlined { box-shadow: none }` and the ring's `box-shadow` were the same
specificity in the same layer, so outlined and link buttons had **no focus
indicator at all**. A consumer's unlayered CSS still overrides deliberately.
*Lives in:* `packages/css/src/a11y/focus.css`; `test/specs/focus.spec.js`.

### <a id="fjs-d103"></a>2026-08-02 · `FJS-D103` — A Treatment class works on every element that reads it, or it is a bug.
This was already the rule for the seven tones; it applies equally to
`.raised` / `.outlined` / `.ghost`. Only `.outlined` was implemented on `.btn`,
so a toolbar of `.btn.ghost` rendered as solid primary blue. The test for a new
Treatment consumer is not "does it look right" but "does every value of that
Treatment do something".
*Lives in:* `packages/css/src/components/buttons.css`; `test/specs/components.spec.js`.

### <a id="fjs-d104"></a>2026-08-02 · `FJS-D104` — Competing background inputs compose through a variable, not specificity.
Stripe, hover and tone all want a say in a table row and only one can own
`background`. They set `--row-base` and the tone mixes into it, so a tone
survives a stripe instead of being out-specified by it. Any future "several
things tint the same surface" follows the same shape.
*Lives in:* `packages/css/src/components/tables.css`; `test/specs/tables.spec.js`.

### <a id="fjs-d105"></a>2026-08-02 · `FJS-D105` — `.icon` means "this element IS an icon". The icon-only button is `.btn.square`.
**Breaking rename**, v0.10. One class cannot mean both, or `<button class="btn
icon">` sizes the button itself to 1.15em. Icon sizing is one rule in
`icon.css` — it was previously hand-copied into three files with three
different sizes and a missing selector branch — covering the components the
package owns, plus `.icon` for anywhere else, varied by `--icon-size`.
Note the old markup fails *quietly*: with `border-box` a width under
padding+border clamps, so a stale `.btn.icon` floors at 30x30 and looks
roughly right while having lost its `aspect-ratio` and padding.
*Lives in:* `packages/css/src/components/icon.css`, `buttons.css`; `test/specs/core-gaps.spec.js`.

### <a id="fjs-d106"></a>2026-08-02 · `FJS-D106` — Interactive state is styled from ARIA, never from a class.
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

### <a id="fjs-d222"></a>2026-09-05 · `FJS-D222` — the runtime split is by ROLE, not by package. A harness runs under node; a package runs under what it needs.

The question was whether every package should run under Bun. Re-measured
2026-09-05, and the August reading holds: `ui/test/browser/run.mjs`,
`jetty/test/phase0.test.js` and `css/test/run.js` use **no** `Bun.*` and no
`bun:` import between them, `scripts/ci.mjs` is `#!/usr/bin/env node` and uses
neither, and junction reaches `Bun.serve` or `bun:sqlite` in ten files and
cannot be otherwise. So *can we* was never the question, and unifying would buy
one runtime at the price of the one place the split is doing work.

**The split is real and it is not per-package.** A **harness** — anything that
decides whether the tree is good — runs under plain node, deliberately: a
harness sharing a runtime with the thing it grades cannot report that runtime
regressing, and `bun run ci` is the same run on a laptop and on a runner
precisely because nothing bun-specific is in the harness itself. Everything else
runs under what the package needs, and for junction that is Bun.

**Where a package is free, the choice follows the package rather than a repo
rule.** Three harnesses here would run under either, and nothing is gained by
converting them; a rule that moved them would be a rule with no failure behind
it.

**What was actually broken is that the rule was never written, and the map
drifted off it.** `CLAUDE.md`'s runner table calls `css` *node driving headless
Chrome*; `packages/css/package.json` declares `"test": "bun test/run.js"` and
the file carries `#!/usr/bin/env bun`. The package and its shebang agree and the
document is wrong. Nothing caught it because **nothing parses that table** —
`core/preflight.js` reads the *Start first* column of the DRIVES table, and the
runner table is unbacked prose in a Map-tier document, which is the one thing a
Map may not be.

**So the column is derived.** A package's runner is decidable from its own
`test` script, which is the authority, and a table restating it by hand is a
second origin that has already disagreed once. Deriving it retires the whole
drift class; the ROLE rule above is the half that cannot be derived and is what
this ruling is for.

**§IV, coherence against convention.** A rule that lives only in the author's
head is already broken for everyone else. The rationale for node-in-the-harness
existed in one sentence of `CLAUDE.md` and the practice drifted away from it
without anyone deciding to.

*Lives in:* `scripts/ci.mjs` (the harness) · `CLAUDE.md` § Running things (the
table, to be generated) · [`FJS-D119`](ISSUES.md#fjs-d119) is what it closes


### <a id="fjs-d196"></a>2026-09-04 · `FJS-D196` — a ruling in force says NOTHING about its status. The word is written only where being in this file has stopped being the whole answer.

`PHILOSOPHY.md` §VII said a ruling is `proposed`, `accepted`, `superseded-by` or
`withdrawn`. Nothing enforced it and no ruling carried one, so the rule existed
at the tier that governs every other document and graded nothing — which is
`FJS-D190`'s shape one file over. Implementing it as written meant stamping
**`accepted` on 180 of 182 headings**.

**That is a restatement, and §V asks whether it can be derived instead.** It can:
a ruling is in `DECISIONS.md`, and this file's own name is the statement that it
was decided. Writing the word once per heading buys nothing and costs the thing
the field exists for — the ruling that has since stopped being true would read
exactly like the 179 around it, one word different in a wall of identical ones.
**Absence means in force.** The vocabulary is the exception only:

`superseded-by` — a later ruling replaced it wholesale · `amended-by` — a later
ruling changed part of it and the rest still governs · `withdrawn` — taken back,
nothing replaced it.

**`proposed` is dropped because it has no referent here.** A question nobody has
answered lives in `ISSUES.md` § *Needs a decision*, which is where `FJS-D195` was
until this morning. A ruling is what that row becomes.

**Written under the heading and nowhere further down.** A register is read by
scanning headings, so a retirement announced in paragraph nine is one the reader
has already walked past — which is exactly how five rulings came to be retired in
prose and cited as live afterwards.

**A retirement names what replaced it**, or the reader who cannot follow it
searches 182 rulings for a successor nobody wrote down. `FJS-D62` is the case:
it opens *supersedes the ruling written earlier the same day* and names no id, so
the ruling it retired cannot be found from the one that retired it. `withdrawn`
is the exception, since nothing replacing it is the content.

**Two things this also settles, both found by reading §VII against the code.**
`FJS-D187` contradicts itself: its amendment says the four-word list "is right
for a ruling" and then enumerates a replacement vocabulary omitting `accepted`.
And §VII said a proposal may be `accepted` — "those four plus `partial` and
`shipped`" — while `IDEA_STATUS` has never allowed it, so the stale half was the
sentence about proposals rather than the one about rulings. A proposal's
vocabulary is `IDEA_STATUS` and `accepted` is not in it.

*Amends `PHILOSOPHY.md` §VII in this commit, which is what that section requires
of a ruling that overrides a guiding document.* Enforced by `RULING_STATUS` in
`packages/cli/core/registers.js` and the `ruling-status` rule in
`core/register-check.js` — a word outside the set, and a retirement naming
nothing. Absence is not graded, because it is the answer for nearly every row.

### <a id="fjs-d194"></a>2026-09-04 · `FJS-D194` — `retryable` answers *may this request be sent again*, and it is false only where the request may already have been applied

`FJS-733` is the discovery underneath this and it stands: an unkeyed POST that
timed out came back `retryable: true`, the layer above conduit acted on the flag,
and a charge conduit had declined to repeat was repeated by a job. The fix was a
squash — a request conduit will not replay is answered `retryable: false` — and
it was applied wider than its own reasoning.

The reasoning is *the request went out and nobody knows whether it was applied*,
and `declineReplay` already computes that fact under its own name,
`indeterminate`. It withholds it from a 429 (the target refused) and from a
refused connection (no bytes left the process), correctly — and then squashed
`retryable` for both anyway. Two more sites never went through that function at
all: load shed at admission wrote `retryable: false` as a literal with no
argument beside it, for `circuit_open`, whose own message names the seconds to
wait, and for `overloaded`, which wants a free slot.

Measured, four rows wrong out of five:

| fault | dispatched | was | is |
| --- | --- | --- | --- |
| `rate_limited`, unkeyed POST | yes, refused | `false` | `true` |
| `rate_limited`, GET | yes, refused | `true` | `true` |
| `connection_failed`, refused | **no** | `false` | `true` |
| `circuit_open` | **no** | `false` | `true` |
| `overloaded` | **no** | `false` | `true` |
| `server_error`, unkeyed POST | yes | `false` | `false` |

**The ruling is the discriminator, not the flips.** `retryable` is a statement
about THIS request and never about the logical operation behind it, so
`indeterminate` decides it: where nothing was applied, a fault keeps whatever
answer its own kind gave. A 404 stays permanent under that rule, which is the
control that says the rule is not simply *transient means retryable*.

**Why the direction is safe.** Wrong toward `true` is a double charge and is far
worse than wrong toward `false`; the change is admissible only because it flips
nothing outside `indeterminate === false`, and `FJS-733`'s two rows — a 500 and a
timeout on an unkeyed POST — are asserted beside every flip.

**Why it mattered.** `collect-invoice` throws on `retryable` and logs-and-returns
otherwise. Five failures open the breaker, and every send in the next thirty
seconds was a provider outage reported as permanent: the invoice was written off
in a `console.error` and the job reported success (`FJS-739`).

**`CONDUIT_ERROR_KINDS` is the artefact.** The union now derives from a walkable
array, because three kinds were wrong at once and a kind with no stated answer
reads exactly like a decided one. The suite walks it.

*Lives in:* `packages/conduit/src/transports/http.ts` (`declineReplay`) ·
`packages/conduit/src/conduit.ts` (the admission reject) ·
`packages/conduit/src/types.ts` (`CONDUIT_ERROR_KINDS`) ·
`packages/conduit/conduit.test.ts` § *retryable (FJS-739)*.

### <a id="fjs-d193"></a>2026-09-04 · `FJS-D193` — a webhook subscriber is an audience, and the audience is whoever registered it

`FJS-631` closed the broadcast half: `@@allow` compiles into a SELECT's WHERE, a
frame is not a SELECT, so a row reaching somebody over a socket had been filtered
by nothing. `db.$readAs(accessor, row, principal)` is the mechanism, and
`FJS-D175` made the fan-out ask it.

A webhook delivery is the same class one layer over, and the mechanism does not
carry across unchanged: **a URL is not a principal.** Measured on the code as it
stood — `deliver('users:created', { …, password: 'hunter2' })` arrived at the
receiver in full (`FJS-724`).

Three shapes were on the table and they are not equivalent.

**Ids only** — send `{ id }` and make the subscriber fetch through the API, which
is what Stripe's thin events are and which moves the whole question onto a door
that already grades. Rejected: it makes every integration two round trips and
requires the subscriber to hold API credentials, which is a second authentication
story this framework does not have. It is also the one shape that cannot express
`deleted` — there is nothing left to fetch.

**`$protectedFields` alone** — strip what the schema says must never be written
down. Rejected as the whole answer, and kept as the FLOOR: it says nothing about
a row policy, so a subscriber still receives another tenant's rows, and a partial
redaction that reads like a read gate is worse than none.

**A stated audience** — the registration names a principal and the payload goes
through `$readAs` as them. Taken, with the one change that removes the UI it
seemed to need and the escalation it would otherwise be: **the audience is not
stated, it is READ from the principal in scope at registration.**

That is not a new concept. Deferred work in this repo already answers exactly
this question the same way: caravan records the principal at `dispatch()` and
junction re-resolves it through `IAuth.sessionFor` when the job runs, so a caller
demoted in between is graded at the standing they hold NOW. A registration is
deferred work with a longer fuse. So an ID is stored, never a session, and the
principal is rebuilt at every delivery.

**Reading it rather than taking it is the security property.** `sessionFor` must
never be wired to anything a request can name; `manage` (default 5) is the bar
for creating a registration, and an audience the registrant chose would make that
same 5 the bar for receiving anything anybody can read. A caller gets what they
already have.

**Three answers, and the line between the last two is the design.** *Graded* — a
model resolved and `$readAs` answered. *Ungraded* — grading was never
APPLICABLE: no Data boundary on the app, an event naming no model
(`webhook:test`, a custom method's summary), a payload that is not a row; the
delivery is made with the floor applied and said out loud once. *Refused* —
grading WAS applicable and could not be answered, or answered no; nothing is
sent and **no pending row is written**, because a payload nobody may read must
not sit in a retry table for a day. `channels.ts` draws the same line for a
broadcast, and conflating the two is how a fail-closed check becomes fail-open at
the first odd shape.

**A registration that speaks for nobody is graded as a stranger.** App code at
boot has no principal, which is the app acting on its own behalf and resolves
through `createApp({ system })`; an app declaring none gets `null`, and a gated
model then reaches that subscriber as nothing. That is the fail-closed answer and
it is *said* at registration rather than discovered as silence — but only where
there is a rule to ask, since an app with no Data boundary grades nothing.

**ABSENT is not `null`, and a custom store is why.** `IWebhookStore` gained a
fourth argument; an implementation written before this cannot record an audience
and answers `undefined`. Treating that as *nobody* stops every delivery in an app
that upgraded, and treating it as *anybody* is the hole. It is neither: the
payload goes out ungraded and says so — the same distinction `ctx.auth` already
makes between a call naming no principal and one naming `null`.

*Lives in:* `packages/junction/src/plugins/webhooks/payload.ts` ·
`packages/junction/src/plugins/webhooks/index.ts` ·
`packages/junction/src/core/litestone.ts` (`accessorIfModel`) ·
`packages/junction/tests/webhook-payload.test.ts` · `FJS-724` · `FJS-D175`.

### <a id="fjs-d187"></a>2026-09-03 · `FJS-D187` — every document is one of four kinds, precedence is stated once, and a status is one of four words. `PHILOSOPHY.md` §VII holds the rule.

Every contradiction found reading the prose top-down had one shape: a sentence
written before a fix or a ruling and never re-derived. `ARCHITECT.md` §5 called
tenancy and the context shape unsettled after [`FJS-D05`](#fjs-d05) and
[`FJS-D03`](#fjs-d03) had ruled them; junction's `ARCHITECTURE.md` described
four context fields and a typecheck baseline of 214 against a tree holding six
and zero; the root README counted components. The framework's first axiom
already names the disease. This ruling points it at the documents.

**Four kinds** — guiding, register, map, assessment — each with what a
sentence in it may say, so that a count in a guiding file or a *used to* in a
map is a rule broken rather than a judgement call. **Precedence** — invariant,
ruling, map, package document, assessment — so a ruling that must override an
invariant amends it in the same commit, which [`FJS-D108`](#fjs-d108) and
[`FJS-D112`](#fjs-d112) did not and [`FJS-D169`](#fjs-d169) assumed the
opposite of. **Status** — proposed, accepted, superseded-by, withdrawn — so
*parked* and *under review* stop letting a settled question read as open.
**Numbers** are generated or absent. And **the delete test** for the sentence
that is in the right file and may still not belong: if it vanished, could
someone acting on this file make a mistake it would have prevented?

The rule lives in `PHILOSOPHY.md` §VII rather than in a fifth root file because
it is Axiom 1 applied to prose and that file already says *write it down or
lose it*. What enforces it is `fli check`'s doc-audit rules; the one they do
not yet carry — a guiding document calling open what the register holds as
ruled — is the class every finding above belonged to.

**Amended the same day, by the corpus.** The section first said status had four
words — proposed, accepted, superseded-by, withdrawn — which is right for a
ruling and cannot describe a proposal: `IDEAS/` was already carrying `partial`
and `shipped`, the two build states between a decision and a fact, and a
roadmap needs both. Forcing eighty-two files into the smaller vocabulary would
have made the register worse to serve a rule written without reading it, which
is *doctrine vs discovery* (`PHILOSOPHY.md` §IV) answered the way that section
says to answer it. The vocabulary is `proposed` · `partial` · `shipped` ·
`superseded-by` · `withdrawn`, plus `assessment` for a reading of the tree and
`index` for a file derived from the others. `idea`, `proposal` and `argued` are
retired.

**Amended again, by measurement.** *Numbers are generated or absent* was the one
clause with nothing behind it: `doc-claims-count` grades a stated number against
a generator, which by construction can only reach a count somebody had already
written a countable for. Measured across the map tier, the one count with a
generator behind it was right and every count without one had drifted — `170
commands over 27 namespaces` against 190 and 35, `970 tests across 48 files`
against 60, and a kit described as shipping 65, 64 and 70 components in three
files at once. `doc-unchecked-count` is the other half, and the discriminator is
the one the writing already uses: digits and a countable artefact noun are an
inventory, a spelled number is rhetoric. A package `README.md` is named in the
map tier because that rule grades one, and because a consumer acts on it without
reading anything else.

*Lives in:* `PHILOSOPHY.md` §VII · `packages/cli/core/registers.js`
(`IDEA_STATUS`, enforced by `fli register:check`) · `packages/cli/core/doc-audit.js`
(`doc-status-stale`, `doc-map-narration`, `doc-unchecked-count`).

### <a id="fjs-d191"></a>2026-09-03 · `FJS-D191` — a claim is per request, a broadcast has none, and the app answers per channel

`FJS-D175` made a broadcast graded: `db.$readAs(accessor, row, principal)` asks
the gate, the row policy and the field policies for each recipient, because
`@@allow` compiles into a SELECT's WHERE and a frame is not a SELECT. The
principal it asks about is the one on the CONNECTION, and that is where this
stops: a connection's principal was built at the upgrade, and `FJS-D113`'s whole
point is that a standing and a tenant claim are resolved **per request**, off a
header, by `createApp({ principal })`. An upgrade carries no workspace header —
basecamp's own channel wiring says so in a comment, three lines above the query
it does instead.

So under `strategy row` the graded recipient carries no tenant claim at all.
Row tenancy desugars into an `@@deny` ([`FJS-D05`](#fjs-d05): allows are OR'd
within an operation, so an allow would widen every read to the whole tenant),
and an `@@deny` fires on
UNKNOWN as well as on TRUE. That is not a narrower answer. **It refuses every
subscriber on every tenanted model, permanently**, which is an application's
entire live layer — eighteen services on basecamp — and the only sign is a
once-per-service warning whose own wording reads as *the model is genuinely
private*.

**The ruling: the missing fact is `(channel, connection) → claims`, and the
application owns it.** `channels(setup, { claims })`. Three shapes were
available and two are wrong:

- **Junction derives it from `db.$tenancy` and the payload's tenant column.**
  This makes tenancy grading a no-op for broadcasts — every member of the
  channel is handed the row's own tenant — and dresses *trust the channel join*
  up as a rule the schema stated. The app never said that.
- **The claim goes on the connection.** One person in two workspaces is one
  principal on one socket and holds a different tenant in each, so a single
  value per connection is wrong for one of them. There is a test that is
  precisely this negative control.
- **The app answers per channel.** The app named the channel, so only the app
  can read `workspace:<id>` back. Where the join is itself the proof — basecamp
  reads `WorkspaceMember` through `asSystem()` and joins a connection only where
  a row exists — returning the id is exactly the statement `membershipClaim`
  makes for a request.

**What it returns is a claim, not a request to trust the channel.** That is the
same contract `membershipClaim` carries and it is the security property: an app
whose resolver answers a tenant it has not verified hands rows across tenants,
and no layer below can tell. An empty object is not a claim — `{}` would turn a
`null` principal into an object, and every `getLevel` in the field grades an
object a rung above a stranger.

**Cohorts are keyed on the principal AND the claim set.** The identity key alone
was right while claims did not exist; with them, two SOCKETS of one person in
different channels on one publish would be graded under whichever channel was
reached first. That case fires no other assertion, which is how it was found:
the mutation that removed the split passed 15 of 15, so the test was missing
rather than the mechanism unnecessary.

**And the refusal now names the cause.** Where the schema is `strategy row` and
no resolver is installed, the refuse-all warning says which claim nobody
carries. Diagnosing this took a signed heartbeat, a real socket and an
instrumented `$readAs`; the sentence is what makes the next one thirty seconds.

*Lives in:* `packages/junction/src/transport/channels.ts` (`ChannelClaimsFn`,
`gradeRecipients`, `tenancyHint`) · `packages/junction/tests/channel-claims.test.ts`
· `packages/basecamp/api/src/app.ts` · `packages/basecamp/api/src/channels.ts`.
*Closes:* [`FJS-749`](ISSUES.md).

### <a id="fjs-d190"></a>2026-09-03 · `FJS-D190` — an invariant names what fails when it stops being true, and `none` is a recorded answer

`CLAUDE.md` § Invariants is the top of the prose stack — nineteen rules that may
not be broken without a ruling — and until this it was the least enforced
document in the repo. `doc-invariant-ref` graded the citations, which is the
direction that cannot hurt anybody: it catches a paragraph pointing at
a number past the end of the list. Nothing asked the other direction. Measured before the fix, six of
the nineteen were cited by a `fli check` rule and thirteen were reachable from
no artefact at all.

That is `PHILOSOPHY.md` §III's corollary — *a check that can only fail open is
not a check* — one tier above where it usually bites, and it bites harder here:
an unenforced invariant reads exactly like an enforced one from every document
that cites it.

**`invariants.snapshot.md` is the projection**, generated by `fli ws:invariants`
and gated by the `snapshots` phase. Two halves, and only one derives: a rule
declares the invariant it serves and is read off the rule table, while a test, a
CI phase or a drive is a statement somebody makes and is declared in
`packages/cli/core/invariants.js`. The declared half is checked to RESOLVE —
`invariant-enforcer`, an error — for the reason `proof-target` exists: advice
that fails when taken is worse than no advice, and an invariant pointing at a
renamed suite reads as covered from every angle.

**A partial enforcer names its half.** Invariant 1 is *Dependency direction*, and
what the `hygiene` phase actually grades is that the substrate package declares
no dependency — `Litestone ← Junction ← Sierra` itself is graded by nothing. A
row claiming the whole would have been the most misleading entry in the file, so
`covers` is required rather than decorative.

**`none` is a recorded answer and the rule does not fail on it.** Three
invariants have no enforcer — 4 (*one owner per translation*), 8 (*caller-supplied
names never enter a SQL pattern*) and 16 (*runnable examples are verified*). Each
is now either a rule somebody writes or a statement that no mechanical check can
reach it, and until one of the two is recorded neither has been decided. Failing
the build on the gap would make the fastest fix deleting the row, which is the
opposite of what the file is for.

*Lives in:* `packages/cli/core/invariants.js` · `packages/cli/commands/workspace/invariants.md`
· `invariants.snapshot.md` · `packages/cli/core/checks.js` (`invariant-enforcer`).

### <a id="fjs-d192"></a>2026-09-03 · `FJS-D192` — house style is American spelling, not British. The rule flipped; the words did too, except where a word is data.

The house-style line had said British spelling in prose since it was written,
and it was followed: `behavior`, `serialize`, `color` and their kin spread
through every `.md` file, every code comment and every string in the repo as
the convention worked as intended. Asked to change it, the honest fix is not a
paragraph — a rule nobody reads until they trip on it is the shape `FJS-D187`
already named — it is flipping the words themselves, everywhere the rule
governs, in the same change that flips the rule.

**~3600 occurrences across 703 files**, swapped case-preserving
(`Behaviour`→`Behavior`, `BEHAVIOUR`→`BEHAVIOR`) over a curated pair list —
true spelling variants only (`-our`/`-or`, `-ise`/`-ize`, `-re`/`-er`,
`licence`/`license`, `tyre`/`tire`, and so on), not word-choice pairs like
*whilst*/*while* or *amongst*/*among* that read as British but are not
misspellings of anything, so the swap does not also rewrite the register's
voice. Left alone by name: `packages/litestone/test/fixtures/corpus/**` and
`**/scale/**`, which are real third-party schemas imported for fidelity
tests — an enum value spelled `Cancelled` inside `erpnext.lite` is data, not
this project's prose, and editing it breaks the corpus's whole reason for
existing (`FJS-D186`'s own residue argument, one layer up: a check that
compares against an edited fixture is checking against itself). Every
`*.snapshot.*` file is generated and gated by the `snapshots` CI phase
(`CLAUDE.md` § Running things); hand-editing one desyncs it from its own
generator, so those regenerate on the next run of their command rather than
being touched here.

**Two words turned out not to be spelling at all — one stayed British by
choice, the other did not.** `colour` was a live column on `example`'s
`ProductVariant`, and `cancelled` a persisted enum value on four
`@@transitions` models across `example` and `basecamp` (`OrderStatus`,
`SubscriptionStatus`, `DeployStatus`, `JobStatus`). Both were first excluded
from this ruling on the same reasoning: a stored value's spelling is a schema
question, not a prose one, and `fli release:check`'s expand/contract question
applies to a renamed column the way it applies to any other. `cancelled`
stays — nobody asked for it, and it is data in the same sense the corpus is.

**Amended, same day: `colour` renamed too.** Nothing this schema declares has
ever left this machine — no deployed release, no `fli release:check --strict`
run against a prior one — so the migration concern above does not bind here;
it would bind the day `example` or `basecamp` is actually deployed with a
predecessor to stay compatible with. Renamed by hand rather than by the same
mechanical pass, because `colour` and `colours` also appear as English prose
throughout the design-system packages (`@frontierjs/css`, `@frontierjs/ui`)
with no relation to this column, and the pass cannot tell "the field" from
"the word" — `model Colour` → `Color`, `valueset ProductColour` → `ProductColor`,
the `ProductVariant.colour` column → `color`, `colours.service.ts` →
`colors.service.ts` (`createColoursService` → `createColorsService`), and
every camelCase compound the word-boundary pass cannot reach on its own
(`pickColour`, `colourOf`, `seedColours`, `colourOnly` — a bare `\bcolour\b`
never matches inside them, since there is no boundary between two word
characters). `example/db/migrations/main/20260823021906_initial.sql` stays
untouched regardless — it is the historical record of DDL actually run, and
editing a migration that already ran misstates what happened, machine-local
database or not. The five generated snapshots under `example/db/` and
`example/api/` were regenerated from their own commands, not hand-patched,
per the paragraph above.

*Lives in:* `CLAUDE.md` § House style · every `.md`/`.ts`/`.js`/`.mesa` file the
swap touched · `example/db/schema.lite`, `example/db/seed.ts`,
`example/api/src/services/{carts,inventory,product-variants,colors}.service.ts`.

### <a id="fjs-d188"></a>2026-09-03 · `FJS-D188` — the tutorial is a command, and CI grades it

`docs/QUICKSTART.md` was the last large document in this repo with no compiler
behind it, and it had already rotted in the way that costs most: its own header
said §7 *Deploy* was "documented from the pipeline, not from a live deployment",
while `README.md` said every command in it had been run against a clean
scaffold. One path, two documents, disagreeing about whether it had ever
worked — and nothing could tell you which was right.

Everything else here that carries knowledge executes it. `fli check` runs the
live-hazard catalogue, `fli proves` runs the drive table, `core/preflight.js`
runs the *Start first* column, the `snapshots` phase reruns every committed
artefact's own generator. The tutorial is the same shape and gets the same
answer: **`fli tutor` is four commands, each step's prose is the lesson text,
each step runs the real command, and each step ends in a probe against the
running world** — a port that answers, a table in `sqlite_master`, a row read
back out of the file the app wrote, the image id a container is on, a nonce
minted a second earlier coming back out of a job's recorded output. A step that
cannot prove itself refuses and says what it asked for and what it got.

**A probe rather than an exit code, and that is the ruling's substance.** Every
one of the defects this found was green by exit code: nine of `fli new`'s ten
refusals exited 0 (`FJS-735`), `fli auth:create-user` created an account and
reported failure (`FJS-736`), and every command the deploy pipeline sent to a
machine did nothing at all under node while reporting success (`FJS-738`). A
tutorial graded on exit codes would have passed against all three and taught
each of them.

**Graded by `bun run ci`, in the full tier**, so a command renamed out from
under a step is a red build. Without that this is a script that rots the same
way the prose did, one release later.

**The counter-precedent is deliberate.** `FJS-D92` chose a *decision wizard*
over a linear lesson for `@frontierjs/css`'s guide, and this goes the other
way. The distinction is what the reader is doing: that question is a lookup
somebody returns to a hundred times and enters from the middle, and this one is
a first run, in order, once. A wizard for a first run is a menu in front of
somebody who does not yet know the words.

**What stays prose is what is a reference rather than a sequence.** QUICKSTART
keeps *Where to write what* and loses the step-by-step half — deleting the file
outright would have taken a working reference with it, and executing a table
that maps intentions onto directories is not a thing a probe can do.


### <a id="fjs-d163"></a>2026-08-30 · `FJS-D163` — `AGENTS.md` is a permitted fifth file at a package root and is not a required one. It is `CLAUDE.md`'s question asked about the other audience, and that audience has a tarball rather than a tree.

**The problem.** Invariant 17 named four files and warned about a fifth, which is
the right shape for a rule that cannot tell a stray design note from the next
thing everyone needs at the root. `packages/css/AGENTS.md` had sat under a named
allowance since 2026-08-14 saying it was the same KIND of thing as `CLAUDE.md`
and that the ruling was deferred. Deferring it cost nothing while there was one.
Writing the second one is what forces the answer, because an allowance per
package is a rule nobody has stated.

**The two files are not one file, and the split is the audience's ACCESS.**
`CLAUDE.md` addresses somebody working IN the package: it can cite `src/`, name
a test, and assume a grep will resolve. `AGENTS.md` addresses somebody writing
AGAINST the package from an installed copy, where `docs/` and every snapshot are
absent and the only things on disk are whatever `files:` shipped. Folding them
would put the contributor's file-by-file map in front of a consumer who cannot
open any of it, and would put the consumer's compressed reference in front of a
contributor who has the authority beside them. Two audiences is why it is two
files, the same argument `packages/frontierjs-vscode` already makes for keeping
`CHANGELOG.md` beside `CHANGES.md`.

**Permitted and not required, because the audience is not universal.** A package
that nobody writes against — `outpost` is a process, `config` is a dependency
with no source — owes nothing here, and adding it to the four would manufacture
an empty file per package to satisfy a count. So `package-root-md` admits the name and
asks for it nowhere; a sixth root file is still the question it always was.

**The half that makes it real is `files:`.** A root document for an installed
consumer that the tarball does not carry is a file for nobody, and it fails
silently in exactly the direction nothing notices: the repo reads correctly
throughout. litestone shipped `["src/", "README.md", "LICENSE"]`, so its `docs/`,
its `catalog.snapshot.md` and its new `AGENTS.md` all stopped at the workspace
edge. `exports.snapshot.md` already commits the tarball listing per package, so
this is decidable from a committed artefact rather than from a pack — which is
the same argument the `scaffold` CI phase makes one level up, where a declared
entry point `files:` omits is a broken install.

**What it may NOT do is restate a generated table.** litestone ships
`catalog.snapshot.md` — 98 words, asserted against the parser's own switch arms
in both directions — so the AGENTS file carries the judgement half (which word
to reach for, what a legal spelling means when it is the wrong one) and points
at the catalogue for the language. A hand-written word list beside a generated
one is the copy `FJS-D33` refuses, and it goes stale in the direction that reads
as authoritative. Where a package has no such artefact the file carries the
vocabulary itself, which is why `packages/css/AGENTS.md` is a different shape
and is not a template violation.

### <a id="fjs-d156"></a>2026-08-29 · `FJS-D156` — the journal owns *what state did the last run leave*; the deploy lock owns *is another run working here*. They are two questions, and the lock only looked like a second answer to the first because it could not expire.

**The problem.** `fli deploy` had two records of a run in flight. `.deploy.lock`, a
file per machine and path, written at preflight and removed at cleanup. And the
journal, a `running` transition per app and environment, opened after the build
and settled at the end. In the ordinary case they agree because they are written
and cleared by the same run. In the case the whole Release design exists for —
a deploy killed mid-flight — they disagree: the journal knows the transition is
`running` and `resumeDecision` grades exactly how to continue it, while the lock
refuses the run that would. The only way through was to delete a file by hand
(`FJS-573`), and the message telling an operator to do that named a pid.

**The pid was a lie by construction, and that is the load-bearing fact.** The lock
script wrote `$$`, expanded by the `sh -s` that ran it — a shell that exits the
instant the file is written. The number was dead on arrival. It cannot be fixed
by recording a better one: `fli` runs on the operator's machine and reaches the
target one command at a time, so **there is no process on the target to point
at**, and no probe can be built on one. `deploy:status` did not even parse its own
format — it split `<pid>:<iso>:<target>` on `:` and read the hour as the timestamp.

**The ruling.**

1. **The journal is the record of what happened.** Unchanged. A transition it
   left `running` is resumable, and dropping a lock never settles one.

2. **The lock is mutual exclusion, and it records what is TRUE**: the run, who
   started it, when, and **which step it is inside**. Not a pid. It is
   `core/lock.js` — one format, one parser, four scripts, three readers
   (`deploy`, `deploy:status`, `deploy:doctor`), where each used to `cat` the
   file and read it its own way.

3. **The step is what makes the duration mean something.** Four minutes in
   `04-build-api` is a build; four minutes in `06-swap` is a run that died. The
   step runner announces it before each step, which is the only place it can come
   from: the build is the longest thing a deploy does and it runs BEFORE the
   journal opens (`04c-journal`), so for the window where *is this alive* is asked
   most, the journal has nothing to say. **A timer cannot serve it either** —
   `execSync` blocks the loop for the whole of a step — so a step boundary is the
   finest grain there is.

4. **Neither judges.** Whether that other `fli` is still running is a fact about a
   process on a machine this one cannot see. So the refusal reports and names both
   ways out, and they are not the same choice: **`fli deploy --resume`** continues
   what the journal holds and takes the lock over, and **`fli deploy:unlock`**
   drops the lock and starts fresh.

**Why `--resume` is safe without a liveness probe.** Resuming is idempotent by
construction and was already: a succeeded step replays into a no-op, a step is
claimed compare-and-set, and the transition id carries the Release id, so a rerun
against different bytes opens a new transition rather than continuing the old one.
The lock was never what made a resume correct — it was only what made it
unreachable.

**A TTL was considered and refused.** It is the shape the field uses (and the one
caravan uses one layer down, `FJS-294`), but it needs a heartbeat, the heartbeat
can only tick per step, and a step is minutes long — so the TTL would have to
exceed the longest build, which puts an operator whose deploy was killed in a
fifteen-minute wait to reach a feature that is already safe to reach immediately.
A declared verb costs nothing and says what it does.

**A freshness check on `--resume` was built and then removed, and the reason
generalises.** *A lock whose step moved seconds ago is a live run* looks sound and
is not: the recorded time is when a step STARTED, and nothing records one ending
or a pulse inside it — so a fresh timestamp is equally consistent with a run three
seconds into a five-minute build and with a run killed three seconds into it. It
was measured that way round, by the cycle: the crash it exists for leaves exactly
that lock. A sound version needs a heartbeat within a step, which `execSync`
forecloses. **Nothing was lost by removing it**, because the fact is already on
screen — *in step 06-swap — 3s in it* — where a person can weigh it and the
machine does not pretend to.

**What the lock still cannot do**, said rather than hidden: two operators deploying
at once, one of whom types `--resume`, is a takeover of a live run. It is reported (the takeover prints what it
displaced, and a refresh finding another run id warns and stops writing), and the
narrower guarantee underneath is the step claim, which already assumed the lock could
be wrong.

**Proven** by `deployJournalCycle` in CI's `deploy` phase, which used to `rm` the
lock file itself to reach the resume it was testing and now asserts the refusal
names the step, offers `--resume`, and that `--resume` continues the same
transition.

### <a id="fjs-d133"></a>2026-08-24 · `FJS-D133` — the live-hazard catalogue is `fli check`'s rule table. `fli doctor` stays what it already is: fli's own setup.

`IDEAS/diagnostics.md` proposed `fli doctor` — § Live hazards turned into
executable rules — and was written before `fli check` existed. Both commands now
exist and mean different things: **`fli doctor` asks whether this MACHINE can run
fli** (binaries on PATH, the global env file, every namespace's declared
`requires:`), and `fli check` asks whether **this app** obeys the rules nothing
enforces. A scaffolded app's `bun run check` already calls the second one
(`FJS-D33`), and its CI workflow calls that script and nothing else.

So the hazards land in the registry that ships rather than a second one beside
it. The infrastructure the idea called *what would have to be built* was all
there — ids, two severities, `--list`, `--json` with a non-zero exit, a named
allowance with a reason — which leaves the rules, and **the rules were the
proposal**. Two registries answering *what is wrong with this app* is the shape
Invariant 4 exists to prevent, and the second one would be the one no app runs.

**What this widens is the membership test, and only its INPUT.** A rule still
earns its place by being silent when broken; what changes is that a rule may read
a line of the app's own JavaScript rather than only the file tree. Both halves of
the original boundary hold: a linter owns generic JavaScript correctness, this
owns everything derived from the seed — and the two rules that could not be lint
rules at all are the ones that argue it, since a per-call header is declared in
`api/` and set in `web/`, and *does this service name reach a model* is a question
about `db/schema.lite`.

The corpus is the asset and it grows: **a new hazard arrives as a rule plus a line
in `CLAUDE.md`, not a line alone.**

**Where a BUILD already proves something, a rule here asks whether the proof is
switched on — never whether it passes.** Sierra grades a prerendered page's reads
against `@@gate` at build time and nothing textual can reach that question; what
text can see is a `target: 'static'` surface wiring no `db:`, which leaves the tap
with no client, and a `publishes: 0`, which is the default bar and therefore
raises nothing while silencing the two fail-closed branches. The build owns the
verdict, `fli check` owns the wiring, and that is the boundary for the next check
of this shape rather than conceding the whole class to the build.

**`--fix` shipped with the first nine rules, and it carries its own rule: only
where the rewrite is the WHOLE fix.** Three qualify — `:id` → `{id}` is a
spelling, and the two model rules have already worked out the exact name the call
is missing. The rest carry none deliberately, and `set-auth-discarded` is the
argument: `const scoped = db.$setAuth(u)` satisfies the check and leaves every
write below it going through the unscoped client. **A fix that makes a check pass
without fixing the failure is worse than no fix**, because the next person reads
a green check. `fli check` with no flags stays the plan; `--fix` applies it and
re-checks from disk.

**The ratchet shipped with them, as `check-baseline.json`** — Invariant 14's
mechanism applied to a second kind of count, and the two verbs are the ruling:
`--update` may only lower, `--adopt` may raise and is its own word for that
reason. A baseline **grandfathers nothing**: the findings still print, and what
the file changes is the exit code — because debt nobody can see is debt nobody
pays, and a rule set that goes red on the day it is installed gets removed
rather than obeyed. It does not replace the allowance, which answers the other
question: *this one is fine, and here is why*, keyed by path and carrying a
reason.

### <a id="fjs-d127"></a>2026-08-23 · `FJS-D127` — the public, prerendered site is `site/`, a surface of its own; `target: 'static'` inside `web/` is a defect, and the reason is OUTPUT.

`FJS-D107` set the test — a directory at the app root earns the name when its
config, its tests and its release are all different answers — and then listed the
surfaces that pass it. A **public prerendered site** was not on that list, so the
framework's own example did the only documented thing available: a second config
in `web/config/sierra.static.config.js`, a second `routesDir` under `web/src/`,
and an `outDir` of `dist/public`. Nothing objected. `fli check` had no rule that
could see it, `ports.js` had no slot for it, `fli` had no command to make one, and
the `site:` namespace was held by six ksite commands that have nothing to do with
FrontierJS.

**It passes `FJS-D107`'s test on all three axes.** The config is a different
target — `static` emits the SPA's bundle and then prerenders every route
declaring `render: static` into its own file, and it carries two keys the SPA has
no use for: `db`, so the build can tap what `load()` read and refuse to publish
anything gated, and `document`, because a prerendered page has no `index.html` to
inherit a body class from. The tests are a different shape — the SPA is proved by
driving a running app, and this is proved against FILES: one per route with the
data already in them, plus the islands that come alive when a browser parses one.
A page that renders perfectly and mounts nothing is the failure, and it is
invisible to every assertion the SPA's drive makes. The release is a different
release — a bucket and a CDN with no application server behind it, shipped when
the content changes and reachable when the API is down.

**A fourth answer decides it, and it is the one that made this a defect rather
than a preference: output.** One Vite root is one `dist/`, so the site's build
landed inside the SPA's — and Vite empties `outDir` by default, so `bun run build`
deleted `dist/public/` and the next drive failed a preflight telling the reader to
rebuild. Order-dependent, silent, and indistinguishable from a stale build. This
is the axis `FJS-D107` did not need, because a widget's `dist/embeds` and an
extension's `dist/chrome` never collided with anything. It is folded into the test
now: **config, tests, release — and whether the two builds can share a directory.**

**Dev is an SPA and the build is files, and that asymmetry is kept rather than
hidden.** `target: 'static'` uses the SPA's Vite config and prerenders afterwards,
so `vite dev` on the surface serves the routes as a client-routed app. That is the
writing loop and it is worth having. What ships is the build, and only the build
has prerendered HTML, the publish check and island chunks — so a page that works
in dev and fails in the build is the normal case, and every generated file and
command says so rather than pretending the two are one thing.

**Ports get two categories, not two service slots** — `siteDev` (6) and
`siteServe` (7), mirroring `widgetDev`/`widgetServe`. A surface that is both
written against and served as its own origin needs two numbers; putting the
served half in the `fe` row would say it is the SPA's second server, which is the
one thing it is not.

**The generator is one function** — `packages/cli/core/site-surface.js`, called
by `fli new --site` and by `fli make:site`, the same rule `FJS-D107` set for
`widget-surface.js`.

**`fli check` gained the rule that would have said so at the time.**
`app-layout` reports a `target: 'static'` config found inside another surface,
decided from the config's own text. It is the one folded surface that reads as
reasonable while it is being written — a second config beside the first looks
like two targets of one app rather than two apps — which is precisely why a rule
has to be the thing that notices.

**`site:` belongs to the surface.** The ksite commands moved to `ksite:*` and
kept their short aliases (`fli clone`, `fli fetch`); the generic `fli serve` is
gone, because two things now serve a directory called `site/` and neither should
answer to a bare verb.

— `packages/cli/core/site-surface.js`, `core/checks.js`, `core/ports.js`,
`packages/sierra/src/site/serve.js`, `README.md` §Project Structure, `CLAUDE.md`
Invariant 3, `FJS-451`.

### <a id="fjs-d128"></a>2026-08-23 · `FJS-D128` — inside an API surface: `index.ts` starts, `src/app.ts` assembles and is never started, `src/core/` is infrastructure. The reason is that describing an app must not bind a port.

`FJS-D127` and `FJS-D107` answer what earns a directory at the app ROOT. This is
one level down and a different question: what the inside of a surface looks like.
It was already written — root `README.md` § Project Structure, which Invariant 3
names canonical, and `fli new` has scaffolded exactly it since it was written —
and it was nowhere argued, so the two apps in this repo each departed from it in a
different direction and both were green for their whole lives.

**The shape.**

```
api/
  index.ts       the entry. Starts the app and assembles nothing
  config/        junction.config.js
  src/
    app.ts       createApp + every plugin. EXPORTED unstarted
    core/        env, the client, the gate, hooks, auth, the mailer
    services/    *.service.ts
    jobs/
  test/
```

`web/`, `site/` and `widgets/` make the same split with `index.html` as the
entry, which is why the entry sits at the surface root rather than inside `src/`:
it is the path a runner or a bundler is POINTED AT, and that is a deployment fact
rather than application code. `src/` is what the entry pulls in.

**Why `app.ts` is not `core/app.ts`.** `core/` is what the app is BUILT FROM —
swap every file in it and it is still the same shop. `app.ts` is the assembly, and
a module that imports every one of its siblings should not be filed among them.
The app's own domain modules sit beside it in `src/` for the mirror reason: they
are what the app IS, not what it is built from. `example`'s `inventory.ts` is the
worked case — the one owner of `ProductVariant.stock`, which is a fact about a
shop and not about a framework.

**The load-bearing half is that the two are separate files at all**, and it is
not tidiness. `junction surface` and `junction jobs` write committed snapshots by
IMPORTING the app and reading it, so the module they import must not listen —
`surface.snapshot.md` cannot be generated by a module that has already taken 8110
off the dev server. With one file the only way to say so is a guard, and a guard
is a condition every reader has to re-derive: `example` carried
`if (import.meta.main)` twice, once around `start()` and once around the dev mail
sink, and a THIRD unguarded statement — `await seed(auth)` at module scope — meant
every description of that app wrote rows to its database. Two files answer it
structurally: the entry starts things, and nothing that merely imports the app can
start anything.

**A seed is a script, and it lives in `db/`.** Same argument arriving from the
other side: seeding at boot is a write performed by an import. `bun run db:seed`
is the verb, `db/seed.ts` is the file, and nothing imports it — so it needs no
guard either. It may reach UP into `api/` for the app's own client and domain
functions, and `example`'s does: a second client would be a second answer to
*what is this database*, and writing `stock` without `move()` would be the second
writer that module exists to prevent. The direction that would be a problem is
the other one, and there is none — nothing in `api/` imports `db/`. The cost is
that an empty database is now reachable, so the entry says so rather than serving
empty lists that read as a broken query.

**Enforced by `fli check`'s `surface-src`** (warn, Invariant 3): a surface with
source at its root and no `src/`, and a stray module beside `src/` that is not the
entry. It deliberately does NOT report a surface whose entry sits inside `src/`,
because `web/`, `site/` and `widgets/` have no entry script at all and a rule that
fires on the normal case for three of five surfaces is one people turn off. That
is the gap `basecamp` sat in — `api/src/index.ts` + `api/src/core/app.ts`, which
has a `src/` and no strays — and it is why the ruling is written down rather than
left to the rule.

**What it cost to find out.** Junction's service autoload defaults to `services/`
beside the ENTRY, which is the flat layout; under this one it resolves to a
directory that is not there and NOTHING FAILS — the app boots, `/health` answers,
and every service route is a 404 (`FJS-458`). `fli new` never hit it because its
`junction.config.js` declares `services.dir`, so the default was unreachable for
every scaffolded app and load-bearing for every hand-written one. Both examples
declare it now; the default is still wrong and the issue is open.


### <a id="fjs-d114"></a>2026-08-22 · `FJS-D114` — A Resource is the model's whole client-side surface, and `save()` owns the write.

`FJS-D112` left the stronger half of its question open: does a Resource own the
model's named queries, or is it a binding each page builds around? It owns them.
A Resource is where the client-side answer to *this model* lives — the store, the
verbs, the reads it is asked for, and the default form.

**The write has one owner and it is `resource.save(data, { mode })`.** `auto`
creates when the model's own id field is absent and patches when it is present;
`create` and `patch` force one; `upsert` is an alias of `auto`, because the two
asked the same question and a second word for it teaches callers that the server
has an upsert method it does not have. `<Form>` calls it and no longer decides
for itself — that decision is about the model's id field, which the resource
knows and a component does not. The defect that argument is made of is already
recorded: `method="auto"` fell through to the client's `upsert`, which is
hardcoded to `id`, so editing a row on a model keyed by anything else created a
duplicate (`FJS-316`). Everything the pipeline already did still happens, because
`save` goes through `_call` — coercion, blank-stripping, validation, the
`@version` this screen read, and the resource's own hooks.

**The reads are declared beside the model too.** `optionsQuery` already existed
and was passed by nothing in this tree; `detailQuery` is its sibling — the
include/select shape `get(id)` asks for when the caller states none. Both are
`{ query, directives }`. It is `detailQuery` rather than the plain `query` the
convention was read from because `query` means FILTERS at every other boundary
here, and one key meaning two things is what Invariant 10 exists to prevent.

**Why an owner rather than a convention:** in the app this was read from, the
convention was followed 6 times in 36 resource files while 80 route files
hand-wrote their own include shape. A shape with no home is rewritten per call
site, and the copy nobody edited is the stale one.

**The generator emits it.** `fli make:resource` writes the module script *and*
the default form — `<Form resource={…} {record} ondone={onsaved} auto={!$slots.default}>`
— so a create page is `<Order />` and an edit page `<Order record={row} />`, and
the form exists once per model instead of once per page. `auto` is stated because
the wrapper always hands `<Form>` a slot: left to itself the component would
answer *did I receive children* about the resource file rather than about the
page, and generation would be off in every app that ran the command. Opening that
file in a browser is what found `FJS-400`.

Still open: §4.6's proposed check — *a route file may not be imported by a
non-route file* — which this ruling unblocks.

— `packages/sierra/src/junction/resource.js` (`save`, `detailQuery`),
`packages/ui/components/forms/Form.mesa` (`_send`).

### <a id="fjs-d112"></a>2026-08-19 · `FJS-D112` — A resource file carries its model's default form. Invariant 18's "no markup" half is reversed.

Invariant 18 said a resource file has no markup and everything goes in
`<script module>`. The data half of that is right and stays: `createResource`
runs once at import, and its named exports are what every other module imports.
The markup half was wrong, and it was wrong in the direction that costs files.

**The evidence is an app, not an argument.** `KOBAMI/my.maid.tech` is a 56k-line
Svelte app built against the pre-alpha FJS client — 36 models, one resource file
each, and every one of them is the model's data layer *and* its default edit
form in one file. What that buys is visible in the routes: `webhooks/create` is
eight lines rendering `<Webhook />`, `webhooks/[webhookId]` is twenty, and the
form itself exists once. Under the old rule those two pages each carry a form,
which is the same form written twice per model and drifting from the first
change onward.

So the rule is now: **`<script module>` is required, markup is optional and it
is the form.** A plain `<script>` beside it is that form's instance scope. A
file with no module scope is still refused, and the reason has not changed — a
`createResource` that ran per instance would give every page its own store, and
the import another module writes would resolve to nothing.

What this does not do is make a Resource a component *instead of* data. The
export is still the resource; the markup is a default a page may ignore. A page
wanting a different form passes children, which `<Form>` already lets win, and a
model with no form at all — a notification, an audit row — keeps a file with no
markup and no instance script. Both example apps have one of each.

Two things follow that are NOT ruled here and are open work: whether
`fli make:resource` should *emit* that default form rather than only permit it,
and whether the resource should own its named queries the way that app's
resources own `query`, `optionsQuery` and `save`. The second is the stronger
idea of the two and has no home in `createResource` yet.

— `CLAUDE.md` Invariant 18, `packages/cli/core/checks.js` (`resource-script`).

### <a id="fjs-d37"></a>2026-08-17 · `FJS-D37` — the terminal is a surface with a tone vocabulary, not a palette of color names; `fli` output stays line-oriented; a TUI buys its engine.
Four rulings from one question, because `packages/cli/core/color.js` and the shape
of a future TUI turn out to be the same decision asked twice.

**§1 — output is styled with a tone, never a color, and the table lives in
`@frontierjs/toolbelt/tty`.** Invariant 13 already says this for the browser, and the
argument it rests on — a color name is a fact about one rendering, a tone is a fact
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

### <a id="fjs-d107"></a>2026-08-15 · `FJS-D107` — A surface is a sub-project — `widgets/` and `extension/`, peers of `api/` and `web/` — and an app may have it and nothing else.

Widgets were built out of
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
owned by none. (`FJS-D127` adds a fourth, learned from `site/`: whether the two
builds can share a `dist/`. They could not, and Vite empties `outDir`.)

**The app owns the install.** One `package.json`, at the app root, for every
surface — `web/`, `site/`, `widgets/` and `extension/` alike. A `package.json` inside a
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

### <a id="fjs-d32"></a>2026-08-15 · `FJS-D32` — FrontierJS adopts a linter and refuses a formatter, and the refusal is measured rather than preferred.

`IDEAS/tooling-decisions.md`
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

### <a id="fjs-d33"></a>2026-08-15 · `FJS-D33` — what a scaffolded app is given is a dependency it extends, never a file copied into it.

The generated `package.json` and config
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

### <a id="fjs-d109"></a>2026-08-15 · `FJS-D109` — `drift-report.md` is retired; its synthesis is `IDEAS/coherence-review.md` and the rest is deleted.

The twelve-package audit
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

### <a id="fjs-d14"></a>2026-08-15 · `FJS-D14` — the four claimed folders are named: two collapse into one package, two are V2.

`orion` is the automations engine and platform.
`toolbelt` is the core pure-function library, shared across repos and meant to
stand on its own outside FrontierJS — which is the reason it is not folded into a
framework package. `datetime-kit` is the date / time / timezone solution.
`oracle` is the solutionizer: it takes a requirement and hands back the mental
model of it.

**Two of the four are now settled by the naming itself.** `toolbelt` as
described *is* `@frontierjs/utils` — core pure functions, shared across repos,
worth having outside FrontierJS — so **`utils` is gone and toolbelt is the
package**, holding everything it held and inheriting the substrate standing
`FJS-D26` granted. `datetime-kit` is not a neighbor of it but a room inside it:
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
(basecamp's partner) and the other is a domain-modeling tool that stops one
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

### <a id="fjs-d108"></a>2026-08-14 · `FJS-D108` — Invariant 17 is a standard, not a wall — `package-root-md` warns.
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

## Dependencies & the ecosystem

### <a id="fjs-d215"></a>2026-09-05 · `FJS-D215` — the mechanism, never the vendor, applies to every battery. Junction's AI adapter ships a shape and no provider.

[`FJS-D153`](#fjs-d153) answered this for Conduit and was written as though Conduit
were the special case. It is not: the argument is about a package that publishes
a boundary, and it lands wherever one does. Junction's AI battery was the same
shape one package along — `createOpenAIModel` and `createAnthropicModel`, two
hardcoded vendor hosts, a hardcoded `anthropic-version`, an `anthropic-beta`
naming a preview that went GA years before, and two bare `fetch` calls with no
deadline on the slowest request an app makes.

**All three of `FJS-D153`'s costs applied unchanged.** *Cadence*: a vendor's API
bump would ship a junction release to every app that installed junction for its
router. *Install weight*: the `registry` and `advisories` phases walk a published
package's runtime dependencies because that is the set every app installs, and a
connector's would sit in front of every junction user. *Suite balance*: a
connector needs a dev sink, and nobody had written one — which is why this code
had **no tests, no callers anywhere in this repo, and one documentation
reference naming `createAnthropicAdapter`, a function junction has never
exported**. Untested vendor code in a published package is the failure the
packaging rule exists to prevent, arrived at from the other direction.

**So the line is the same line.** Junction keeps `IAIModel`, `AIBuilder` and
`AIRegistry` — the shape an adapter satisfies and the two things that compose
over it — and ships no provider. An app's adapter reaches its vendor through
`app.conduit`, where the deadline, the retry, the breaker, the auth header and
the body encoding are declared per target rather than restated per provider; the
missing timeout was not an oversight to patch but the same duplication showing.

**What this does not say.** It does not forbid a first-party AI connector, any
more than `FJS-D153` forbids `@frontierjs/conduit-stripe`. It says where one
lives: its own package, on its own cadence, with its own sink. None exists yet
and the absence is stated rather than implied — an app writes about thirty lines
against `IAIModel`, and `fli new`'s `ai` extra now scaffolds exactly those.

**The general form, for the next battery that grows a provider**: a package that
publishes a boundary may name a vendor in a comment and never in a call. `FJS-903`
is the defect this closed.

### <a id="fjs-d177"></a>2026-09-02 · `FJS-D177` — Conduit holds the RELATIONSHIP, so it is two-way. The axis is who dials, not which way bytes move.

Asked of a Basecamp connection and answered for every counterparty.

**Conduit was never ruled one-way.** The phrase *outbound boundary* appears twice
in this file, both inside [`FJS-D153`](#fjs-d153), both as a premise in an argument
about vendor coupling — never as a decision about direction. It is an artefact of
origin: conduit began as basecamp's fleet arm, and telling a machine to deploy is
outbound by nature.

**And it was never literally true.** `stream()` yields chunks and every `send()`
reads a response; data arrives constantly. What conduit does not do is **listen**.

**So the axis is who dials.** That distinction decides three things at once — who
retries (the dialer's choice, against the callee's problem), who authenticates
whom (we prove ourselves, against they prove themselves), and whether a listening
socket exists at all. A coherent package hides under the old name: *the
connections this process initiates*, where retry, breaker, deadline, pool and a
credential-we-spend all hang together.

**It is not the package conduit is.** Its own claim is *one place lists what this
process may talk to*, and **talk to is a relationship, not a dialing direction**.
A vendor holds two of our secrets and dials us about as often as we dial it —
Stripe issues `sk_live_…` to spend and `whsec_…` to verify, and
`example/api/src/providers/stripe/index.ts` already carries both in one file
because the relationship is one fact. n8n, Zapier, Apache Camel and MuleSoft each
landed here independently; Camel is the sharpest, where a Component *is* an
integration point and `from()` consumes what `to()` produces.

**Ruling: conduit is the third parties an app integrates with, declared in one
place, and a declared relationship has two ends.** Outbound ships; the receiving
end is conduit's and is not built (`IDEAS/inbound-integrations.md`).

**But receiving is two features, and the test is *whose scheme is it*.**

- **Our own scheme is junction's.** The `webhooks` plugin is outbound only —
  `register(url, events)` registers a SUBSCRIBER — and it signs with
  `@frontierjs/toolbelt/signature`. The mirror half is the same scheme read the
  other way, it is generic, there is no counterparty to declare, and an app must
  get it **without installing conduit**, because it completes a feature junction
  already half ships.
- **A counterparty's dialect is conduit's.** Stripe's `t=…,v1=…`, GitHub's
  `X-Hub-Signature-256`, Basecamp's *nothing at all*. The relationship is already
  declared here, so [`FJS-D153`](#fjs-d153) applies unchanged in the new
  direction: conduit owns the mechanism — the route, the raw bytes, the freshness
  window, the dedupe key, the refusal taxonomy — and a connector owns how that
  vendor signs.

**Three things are excluded by name**, so the edge of what was taken is decidable
rather than argued later: a machine caller **becoming a principal**
([`FJS-371`](ISSUES.md#fjs-371)), which is junction's auth door; inbound email,
which Rails made its own noun (`ActionMailbox`) and was right to; and a polled
feed, which is a cursor rather than a route.

**A receiver is not a second kind of target.** A `TargetDescriptor` describes a
place we send to; a webhook has no such place, it has a route of theirs to us.
One relationship, two records — and this is the mistake Camel actually pays for,
whose URI model leaks precisely because a component's consumer and producer
options diverge while one string carries both.

**Two things must not merge.** **Resilience does not cross**: retry, breaker,
deadline and the concurrency cap are ours because we chose to dial, while inbound
the retry is theirs and our only jobs are to be idempotent and answer 2xx
quickly — a breaker has no inbound meaning, and an inbound branch inside
`resilience.ts` is the first sign this went wrong. And **neither half may mint a
principal**, which is the guardrail that pays for itself: a verified webhook looks
identical to an authenticated machine caller from outside and is not one. Stripe
is not a caller with a session; it is an event we verified and then act on as the
system. Conflating them is how a webhook ends up minting a session.

**Anything both halves need is a kit**, or the two drift on the one thing that
must not — which is why `@frontierjs/toolbelt/signature` exists at all
(`FJS-349`: a signer with no verifier reads as a scheme being enforced, and three
fleet endpoints took no credential). It already holds the canonical string, the
freshness-before-compare order and the constant-time compare. It does **not** hold
a nonce store and must not: that is I/O, and computing only what it is given is
the whole of [`FJS-D26`](#fjs-d26).

**What this does not rule is the schedule.** The mechanism is unbuilt and the
ordering is a proposal, not a ruling: the credential seam first
(`IDEAS/third-party-credentials.md` leg three), because it is the only genuinely
shared machinery between two ends of one relationship.

### <a id="fjs-d161"></a>2026-08-29 · `FJS-D161` — a detail read that composes is a TRIGGER, not a value

**The gap.** `resource.record(id)` made a detail screen live (`FJS-518`,
`FJS-D138`): the row has one node, every view is a view of it, and a push moves
what is on screen. Adopting it across basecamp split the sixteen readers of
`service.get(id)` into two kinds, and the second kind broke. A node holds ONE
shape and `_write` REPLACES it, so a screen whose `get()` answers the row PLUS
what hangs off it — an `include:`, a `withWidgets()`, a count assembled per
call — showed its children until the first announcement and then showed none:
a push carries the row alone. Measured: converting `apps/[id]` took the drive
from 302/302 to two failures, `app.domains` empty. Four of basecamp's five
composed reads did the same.

**Not fixed by merging.** A merge cannot tell *this key is absent from the push*
from *this key was cleared*, and it would put one screen's children into the
node every list over that model is a view of.

**Ruled: the node is the trigger and the read is run again.**
`record(id, { composed: true })` says what `load` answers is not the row. The
value is the view's own, the composed row is deliberately NOT written to the
node, and any move of that node — a push, another view's write, an optimistic
overlay — re-runs the read, coalesced per burst. `changed`, the announcement
that names no row, re-runs it too, in both modes: a bulk or `select: false`
write says least and would otherwise be the one thing that leaves a watched row
stale for good.

**Why declared rather than inferred.** Nothing in a browser can see what a
service's `get()` composes — it is a server-side shape, and JSON Schema
describes the model, not the method. The alternative was a per-screen
reload-on-push, which is what all five of these hand-rolled, each with its own
copy of *was that a read?*. One option replaces five copies and keeps the rule
that made them (`detail-read-dead`) unconditional.

**The cost is stated.** One request per announcement about that row, which is
what the hand-rolled version already paid — and a screen that genuinely wants
the row alone should not declare it. What is left after this is a read with
nothing to subscribe to: basecamp's `portal.get()` builds an entry from an
adapter ping, over no model, so no node exists and no announcement will ever
arrive. That is a fair exception and is baselined by name.

Closes `FJS-533`. Extends `FJS-D138`.
*Lives in:* `packages/junction/src/client/index.ts` (`RecordOptions.composed`)
· `packages/sierra/src/junction/resource.js` (`record`) ·
`packages/cli/core/checks.js` (`detail-read-dead`).

### <a id="fjs-d153"></a>2026-08-27 · `FJS-D153` — an official Conduit connector is its own package. Conduit owns the mechanism, never the vendor.

Asked of Stripe, and the answer generalises to every provider this project would
maintain a connection to.

**Conduit is the outbound boundary, and a boundary that knows a vendor stops
being one.** `FJS-D06` already fixed the word: a Provider is a third party the
app speaks to. Conduit's whole job is not knowing who is on the other end of a
declared target, and a `stripe.ts` inside it inverts that in the one package
whose value is the inversion.

Three costs follow and none of them is aesthetic:

**Cadence.** Stripe versions its API on Stripe's schedule. Conduit's version
means *what the outbound boundary guarantees*. Welded together, a Stripe API bump
ships a conduit release to every app that installed conduit for one internal
webhook, and a conduit fix waits on whatever a vendor did that week.

**Install weight.** The `registry` and `advisories` CI phases walk each published
package's runtime `dependencies`, because that is the set every app installs —
which is exactly how `packages/mesa` was found shipping two criticals to every
app that installed mesa (`FJS-475`). A connector's dependencies would sit in
front of every conduit user, whether or not they speak to that provider.

**Suite balance.** A connector needs a dev sink, because a test may not reach a
vendor's API and a connector nobody can run is a connector nobody trusts.
`example/api/src/providers/psp/sink.ts` is 240 lines standing in for ONE provider.
Five of those inside conduit's own tests would be most of conduit's tests, and a
failure in conduit's transport would be reported among them.

**So the line is the mechanism, not the relationship.** Conduit owns body
encoding, the auth types, error mapping and idempotency — anything a connector
would otherwise reimplement, and in particular anything the HMAC signer touches:
`serialize()` produces the bytes the signature is computed over, so an encoder
living in a connector would sign bytes the transport did not produce. A connector
owns the vendor's paths, its payload shapes, its own webhook signature scheme
(Stripe's `t=…,v1=…` is not this project's `X-Fjs-Signature`, and neither is
wrong), and its sink.

**Naming: `@frontierjs/conduit-stripe`, not `@frontierjs/stripe`.** It says which
boundary it plugs into, and leaves the name free for a connector to something
that is not conduit.

**But it starts inside `example/`, and is promoted when a SECOND connector exists
to argue with it.** One instance cannot design the connector interface — whether
`stripeTarget()` returns a target or installs one, whether a connector ships a
sink or a fixture, whether the webhook verifier is a function or a hook are all
questions a single implementation answers by accident. This project's own habit
is the precedent: every `@frontierjs/toolbelt` kit earned its subpath by having
callers first (`/inflect` five, `/history` four, `/match` two live stores), and
`@@transitions` and `@version` were built against a real app before they were
features. `example` is also where the argument gets tested for free — `psp.ts` is
conduit's OWN HMAC scheme and Stripe is a real vendor's, and having both against
one boundary is the only thing that shows whether the boundary is generic.

### <a id="fjs-d111"></a>2026-08-17 · `FJS-D111` — `FJS-D16` amended — `createStore` does NOT move to the substrate, and the reason is the license rather than the effort.

The 2026-08-15 ruling
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

**`mergeHooks` changed shape on the way, for the same license.** It merged in
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

### <a id="fjs-d110"></a>2026-08-15 · `FJS-D110` — SQLite is the only database FrontierJS supports, and serverless follows from that rather than being refused separately.

Both were recorded
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

### <a id="fjs-d26"></a>2026-08-15 · `FJS-D26` — `@frontierjs/toolbelt` is substrate, not a member of the dependency graph. Any package may import it, mesa and litestone included.

The question was what *leaf* meant, and it was undecidable while two
documents wrote down two answers: Invariant 1 said mesa carried zero workspace
dependencies and the pure-function package's README claimed the same standing to
grant itself an exemption from it. Invariant 1 now states the dependency
direction alone, which settles it in the README's favor — `Litestone ← Junction
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

### <a id="fjs-d16"></a>2026-08-15 · `FJS-D16` — all three duplications CLOSE, by three different mechanisms, because the obstacle is different in each. The rule underneath is one: the owner is whoever already computes the fact, and a copy exists because a door was shut — so open the door rather than keeping the copy in sync.
**Status:** amended-by [`FJS-D111`](#fjs-d111) — the substrate-move clause only, and one third of it: `createMakeFromSchema` and the hooks pipeline moved, `createStore` does not and cannot. The other three moves this ruling makes stand.

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

### <a id="fjs-d12"></a>2026-08-15 · `FJS-D12` — FrontierJS ships English, and the seam is reserved by six constraints rather than by a catalogue.

The premise the row was filed under
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
register from the schema. Locale as a client flavor, `db.$setLocale('es')`
beside `$setAuth` / `asSystem` / `$scopedBy`, where Payload uses a query
parameter and Directus a join table. And per-locale prerender on the `static`
target, which is Paraglide's bundle win out of a loop the build already runs.

Closes `FJS-D12`, and retires the *1.5 precedes 1.1* dependency in
`IDEAS/overview.md`.
*Lives in:* `packages/litestone/src/core/parser.js` (`@label`) ·
`packages/sierra/src/junction/field-rules.js` (`labelFieldFor`, `toFieldErrors`)
· `packages/toolbelt/src/inflect/inflect.js` · `IDEAS/ecosystem-gaps.md` 4.

### <a id="fjs-d31"></a>2026-08-14 · `FJS-D31` — FrontierJS wraps third-party binaries, it does not fork or republish them. It controls the VERSION, never the artifact.

Asked of
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

**What this ruling does not cover is coming back.** Driving upstream's binary is the
right call outbound and leaves restore in the same hand-typed shape upstream ships it
in: one `litestream restore` per database, with the jsonl/logger databases litestream
cannot replicate on a third route. The schema knows the set; nothing reads it inbound.
That is `FJS-552`, and it is a wrapper question rather than a fork question — exactly
what this ruling says the project is allowed to build.

**Revisit only on a named trigger**: upstream goes unmaintained *and* a CVE
lands; a patch we need is refused upstream; or "install a Go binary first"
measurably costs adoption — and even then a per-platform downloader wrapper (the
esbuild/biome shape) beats a fork, because it still ships upstream's bytes.
*Lives in:* `litestone/src/tools/replicate.js`, `cli/commands/deploy/_steps-setup/`.

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
§ Needs a decision.
