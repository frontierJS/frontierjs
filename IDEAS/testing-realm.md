# Idea — the Testing realm, as an ordered plan

**Status: Phases 1a, 1b, 2, 3's constraint runner, 4, and Phase 5's transport
parity have SHIPPED — in `@frontierjs/litestone/testing` plus `@frontierjs/testing`.
Phase 3's derived page model, Phase 5's generated pair and Phase 6 are unbuilt.**
Dated 2026-08-11, amended 2026-08-12. This is a design record, not a description of behaviour
(`VERIFYING.md`) — except where § The plan marks a phase shipped, and those claims
belong to `packages/litestone/CHANGES.md`, which is where they should be read.
Every claim about *another framework* was web-researched on the date above and is
sourced in § Evidence; every claim about *this repo* was probed by reading the
tree, and the file it was read from is named.

**Relationship to `testing-and-ci.md`.** That file's gap A (automated CI) shipped as
`scripts/ci.mjs`. Its gap B — the Suite realm — is what this file supersedes. Read
that file for how the question was first framed; read this one for what to do about
it. `IDEAS/overview.md` rows 3.3 and 3.4 point at the old file and should point here.

---

## The one-line verdict

**Most of the generator already exists and nothing calls it.** `generateGateMatrix`,
`generateValidationCases`, `factoryFrom`, `generateFactory`, `snapshot` and `restore`
are 925 lines of shipped, tested code in `packages/litestone/src/testing.js` with no
consumer outside its own package. Junction's `createTestApp` / `request` /
`createStubAuth` / `testCtx` are equally good and equally under-used. The Testing
realm is not a build. It is a **wiring job with a generator already attached**, and
the first useful thing ships in days.

---

## What already exists

Read this before estimating anything.

| Piece                                                      | Where                                                         | State                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `generateGateMatrix(schema, model)`                        | `litestone/src/testing.js:475`                                | emits the `for (const level of …)` axis per model, from `@@gate`. No caller.                    |
| `generateValidationCases(schema, model)`                   | `litestone/src/testing.js:532`                                | constraint cases from field rules. No caller.                                                   |
| `factoryFrom` / `generateFactory`                          | `litestone/src/testing.js:249,270`                            | model factories from the seed. No caller outside litestone.                                     |
| `snapshot(db)` / `restore(db, snap)`                       | `litestone/src/testing.js:165,180`                            | point-in-time copy of every table. Its own header says it **does not isolate concurrent work**. |
| `$transaction`                                             | on the client; used at `litestone/src/core/migrations.js:253` | exists, undocumented as a test tool                                                             |
| `createTestApp` / `request` / `createStubAuth` / `testCtx` | `junction/src/testing/index.ts`                               | good; the gap is that its rows come from hand-written objects rather than from the seed         |
| OpenAPI emission                                           | `junction/src/plugins/openapi/index.ts`                       | ships, and is a second seed-derived surface a generator could read                              |

**The one thing genuinely missing is an environment** — something that stands up a
migrated database, a mounted app and a principal in one call. Everything else is a
generator without a runner and a test kit without rows.

---

## Two research findings that change the plan

Both came from surveying Rails, Laravel, Phoenix/Ecto, Django, Encore, AdonisJS,
RedwoodJS, Wasp, SvelteKit and Supabase. Sources in § Evidence.

**Migration cost dominates isolation cost, and Encore already solved it.** Every
framework's test-database optimisation is *stop re-migrating*, not *isolate more
cheaply*. Laravel's `RefreshDatabase` runs `migrate:fresh` on every run and the
community had to ship a package that re-migrates only when migration files change;
Rails' parallel-test overhead is per-process database setup and fixture loading, to
the point that Rails added an opt-out for creating the databases at all. Encore's
answer is the one to take: **a template database with every migration already
applied, cloned per test, isolated to that test and its sub-tests, dropped at the
end.** In SQLite that is a file copy — microseconds — which makes db-per-test cheaper
here than transactional isolation is anywhere else.

This is also why **Ecto.Sandbox comes off the list as a mechanism and stays on as a
warning.** Its transactional rollback is not the hard part and is not what people
complain about; the hard part is *connection ownership* — which process holds the
checked-out connection — and that is what actually bites, with tasks and LiveView
processes outliving the test, hangs on `DBConnection.ConnectionError`, and `async:
false` documented as a last resort that is not guaranteed to work. None of it
transfers: SQLite has one writer per database, so an open savepoint held by one test
*blocks* another's writes rather than freeing them. Take the outcome, not the
mechanism.

**The ecosystem is reversing out of DOM emulators, and this repo already paid for
that lesson.** `@testing-library/svelte` over jsdom remains the default in a fresh
SvelteKit project, but the migration in progress is to real-browser testing under
Vitest browser mode, driven by setup files that had grown to hundreds of lines of
browser-API mocks. FJS-107 is the same bug from the other side: happy-dom's
`cloneNode` re-derived an input's attributes from default properties, so every
prerendered `<input>` carried the build machine's URL in `formaction` — a DOM
emulator inventing a security defect that no real browser has. **Do not build a
jsdom/happy-dom component tier.** Go straight to a real browser.

---

## Method — boundary pairs, with a wiring tier

J.B. Rainsberger's *Integrated Tests Are A Scam* gives the placement rule: each
boundary gets a **collaboration test** (the client sends the right message and
handles the response, against a stub) and a **contract test** (the real server
honours that message). If both pass, the integration is proven and the integrated
test is redundant.

**The exploit is that both halves are generatable, not just the contract half.** The
seed knows the message shape, so it can emit the contract test *and the stub the
collaboration test runs against*. That matters more than it sounds: this repo's own
house rule is that fake clients hide real bugs — `{ post: {…} }` passed every test
and failed every real Litestone client — which is exactly the collaboration-test
failure mode. Deriving the stub and the contract from one artefact makes drift
between them structurally impossible rather than merely discouraged.

**Where the method needs adapting: "delete the integrated tests" is wrong here.**
`example/README.md` § *Found by building this* is the counter-evidence, and it splits
cleanly. FJS-097 (`userId` vs `auth().id`, every row policy matching nothing),
FJS-098 (`actorId` declared `Int` against uuid sessions), FJS-099 (`methods:` honoured
by one factory and dropped by the other) and the PATCH-rewrites-the-record defect are
all boundary faults a pair would have caught. FJS-106 (a `.mesa` route compiled as
Markdown **only by the prerenderer**, correct in dev and in the SPA build), FJS-107,
and FJS-108 (a prerendered page shipping every class name and no rules) are not
boundary faults at all — they are two code paths compiling the same source
differently, and no contract test can see which build produced the message.

So the chain tier survives, renamed and bounded. **Wiring tests assert that the
pieces are connected, not that behaviour is correct** — one per assembly path (SPA
build, static build, HTTP transport, WS transport), which is a fixed, small,
non-combinatorial set rather than the combinatorial space Rainsberger is arguing
against. Rails prices this tier honestly: browser tests are slow, and they get
*flakier* when you make them faster, because the slow driver's latency was masking
race conditions all along.

**And FJS-114 argues for neither side.** Every kit overlay was invisible and the
command palette put a click-swallowing sheet over the app, while `verify:ui` was 26/26
green, because every assertion asked whether the DOM was there. A human clicking
found it. That is not a placement problem, it is an assertion-quality problem, and it
belongs to § Generator acceptance below.

---

## The plan, in order

Each phase is shippable alone and useful alone. The ordering is by
*unblocking*, not by size.

### Phase 1 — the gate matrix, derived, plus a committed snapshot

Split in two on contact, because the snapshot needs no database and the runner
needs a principal at level N, which is Phase 2's job.

#### Phase 1a — the access snapshot. **Shipped.**

`litestone access` / `fli test:access` writes `db/access.snapshot.md`; `--check`
exits 1 when it is stale, and a fifth `access` phase in `scripts/ci.mjs` runs that
over every committed snapshot. Basecamp's is committed — 37 models, all gated.
`packages/litestone/CHANGES.md` is the record; what follows is what the plan got
wrong.

**The generator was thinner than this file claimed.** `generateGateMatrix` emitted
two cases per operation — the required level and the one below — not "denied
below, allowed at and above". That proves the comparison operator and nothing
else; a gate granting at 6 and again at 2 passed it. The default is now every
operation against every reachable level (0–8), with `{ levels: 'edges' }` for the
old shape.

**Nothing derived the policies at all**, so the snapshot is wider than the
model × operation × level table proposed here: `@@allow`/`@@deny` predicates,
`@guarded`/`@encrypted`/`@secret`, field `@allow`, and `@@transitions` gates. All
of it is access declared in the schema (Invariant 6) and a snapshot naming only
the gates would have implied the rest was absent.

**Two properties turned out to be load-bearing and are pinned by tests.** Models
render sorted by name and empty sections are omitted, because a model inserted
mid-file otherwise shifts every row and the diff stops naming what changed. And
the render must be byte-deterministic — a first cut named the schema by a path
relative to the working directory, so the same schema rendered differently from
the app directory and from the repo root, and `--check` failed on a file nothing
had touched. A check that cries wolf gets disabled.

**Verdicts are not restated.** `levelPasses(required, userLevel)` is now exported
from the gate plugin and is the one definition; `checkLevel` guards on it. An
artefact that carried its own copy of the comparison could certify access the
plugin does not grant, which is worse than having no artefact.

Also settled here: **the snapshot lives beside the schema, one per app**
(`db/access.snapshot.md`), not per model file. It is one reviewable artefact, and
it lands in the same PR as the schema change that moved it.

#### Phase 1b — the runner. **Shipped for reads, as part of Phase 2.**

`env.verifyReadLadder()` executes the read column of every gated model at every
level against a real client — 333 assertions on basecamp in 214ms, **with no
fixtures**, because a read either refuses or answers. Create, update and delete
need a valid row per model, which is the app's schema to know, so they stay
caller-driven behind `env.gateMatrix()`.

**And the first version of it asserted nothing.** See § The oracle problem below;
it is the most useful thing this phase produced.

**Derive at run time; do not emit test files.** Migrations commit because a diff must
be read before it eats data, and a test file is not that. Committed generated tests
churn — a schema touch produces a diff nobody finishes reading — and, worse, a
generated file on disk is editable, which reintroduces exactly the drift the whole
thesis exists to remove. Wasp reached the same shape from the same starting
position: golden snapshots of generated output, diffed in git, because a compiler
that emits a lot of code needs one reviewable artefact rather than all of it.

### The oracle problem — found by building Phase 1b

**A generated test whose expected value comes from the code under test cannot
fail.** The gate matrix first took its verdict from `levelPasses()`, the gate
plugin's own predicate, on the reasoning stated in Phase 1a: an artefact that
restates the rule can certify access the plugin does not grant. That reasoning is
right for the *snapshot* and wrong for the *runner*, and nothing distinguished
the two until a branch was deleted from the plugin outright and **333 executed
assertions produced zero mismatches**.

The fix is a second, deliberate statement of what `@@gate` means, with one
exhaustive test over every (required × level) pair holding it against the
plugin's. Against a real off-by-one (`>=` → `>`): 34 of 333, each naming its
model and level.

**Three things follow for the rest of this plan.**

**Every generated category needs its oracle named.** Not "what does the code
say", but *what independent statement decides this case, and what holds the two
together*. For the gate matrix it is `expectedVerdict` plus one agreement test.

**`generateValidationCases` was checked next, and its oracle was sound while
everything around it was not.** The verdict — *this value is rejected* — is
derived from the attribute's presence, independent of the validator, so the
category was falsifiable. But **nothing had ever executed a generated case**, and
running all of them found five defects, four of which produced tests that fail
against a correct implementation. The worst was that `cases.valid` was itself
invalid for any model with a `@time`, `@date` or `@datetime` String field, so
every case failed naming a field it was not testing.

That refines the rule rather than replacing it. **A sound oracle is necessary and
nowhere near sufficient**: the fixture the case is built on, the message it
predicts and the coverage of rules it claims are three more places the category
can be worthless while every unit test over its *output* stays green. The
cheapest complete check is to run the generated suite against the real thing and
assert it agrees — which is one test, and is now what pins this category.

**This is the strongest argument yet for Phase 4.** "Is generation
under-reaching" was a judgement call and this is what a judgement call gets you:
a suite that ran 333 assertions and asserted nothing, caught by hand, by
accident, from a hunch. Schema mutation testing is how that stops being luck.
The mutant that would have caught it here was not even a schema mutation — it was
a *source* mutation of the enforcement path, which suggests the mutation phase
wants both, and that the small set of source mutants worth running is
enumerable: the gate predicate, the policy compiler, the field stripper.

**It also sharpens § Generator acceptance.** Beck's *predictive* is the property
that failed — the suite was structure-insensitive, specific and fast, and none of
that mattered because it could not fail. Add a fifth: **falsifiable — there
exists a change to the system under test that this category reports.** Cheap to
check once, and it is the only one of the desiderata whose absence is invisible.

### Phase 2 — `createTestEnv`. **Shipped, both realms.**

```js
const env = await createTestEnv({ schema: 'db/schema.lite', plugins: [appGate] })
```

Migrated database, client, factories and both auth doors, in one call. Lives in
`@frontierjs/litestone/testing`; `packages/litestone/CHANGES.md` is the record.

**Template-clone landed and the number is the whole argument**: 476ms → 13ms per
database on basecamp's 37 models, and litestone's own suite went 41.5s to 33.7s
with no test changing. `makeTestClient` uses it too, so nothing had to opt in.
The plan said migration cost dominates isolation cost; in SQLite the isolation is
now a `copyFileSync` and the claim is measured rather than borrowed from Encore.

**`migrations:` builds the template from the committed files**, which is Encore's
actual shape and not the DDL-generating shortcut. It exists because basecamp
needed it: all 61 of its Data-realm tests are about the database a *deploy*
produces, and converting them naively to a schema-generated template would have
left every one of them passing while no longer proving that. **Converting the
file is what proved the env** — 58s → 9.5s, same assertions — and it bought a
question nobody had asked: build a database each way, introspect both, compare.
They agree, and now something says so when they stop.

It also turned up `FJS-193`: `migrate apply` answers *no migration files found*
for basecamp's migrations directory, because the filename does not carry
litestone's 14-digit timestamp and an empty match list is read as an empty
directory. A silent success on the one command a deploy runs first.

**The API tier shipped as `@frontierjs/testing`**, above Junction and imported by
nothing — which is what mounting an app forces, since Litestone may not import
Junction (Invariant 1). The option is `api:`, not `api: true`: an app is built
over a client, and the client does not exist until `createTestEnv` is called, so
what the caller passes is a factory handed the Data-realm tools.

```js
const env = await createTestEnv({ schema, plugins: [gate], api: ({ db }) => buildApp(db) })
await env.as(developer).service('leads').remove(lead.id)
expect(env.announced('leads:removed')).toHaveLength(1)
```

**The tier justified itself on its first run.** The fixture schema wrote the
natural thing — `@@allow('read', ownerId == auth().id || ownerId == null)` — and
the unowned rows never came back. `field == null` compiled to `"col" = NULL`,
never true in SQLite, so the policy hid rows nobody meant to hide and raised
nothing; and `create` is evaluated in JS with `===`, so a caller could create a
row and then not see it. `FJS-195`. Neither half of the Data realm's own suite
had asked, because nothing in it had written that policy.

Three design points worth keeping:

- **The principal is bound at a stated argument, per method.** `find(query, opts)`
  and `patch(id, data, opts)` put `CallOptions` in different places; *the last
  argument if it looks like options* mistakes `create({ auth: … })` for one. So
  `OPTS_AT` is a table, checked against a real caller when one is built, and a
  method it does not name is refused rather than guessed — a call bound at the
  wrong argument runs anonymous, and an empty result reads as a correct answer.
- **`_startForTest()` runs eagerly.** Junction's own `request()` defers it to the
  first request; an internal service call would otherwise meet an uncompiled
  pipeline and unregistered plugins, and a guard that has not registered refuses
  nothing.
- **No second HTTP helper.** `env.http` IS `request(app)` from
  `@frontierjs/junction/testing`. Benefit 4 (the act as the announcement window)
  did need owning here, because `callService` announces and only this package can
  see the bus.

**Port claiming was answered by Phase 5 and answered differently.** `listen: true`
asks for port 0 and reads back what the OS gave, which cannot collide with a
parallel suite at all — where the broker only makes a collision less likely. The
broker's job is a port something *external* was told about in advance, and a test
that opens its own socket is not that; `listen: <number>` is the door for when it
is. Still open: **rate-limit awareness**, which bites a suite that signs in.

**Database lifecycle: template-clone per test.** Migrate once into a template file,
copy per test, discard at teardown. `snapshot()`/`restore()` stay as the same-file
fast path when one expensive seed serves many cases; they are not the isolation
story, and their own header says so.

**Two auth helpers, not one.** *(Shipped, minus the parts that need Junction.)*
`actingAs(user)` puts a real user through the real derivation — the app's own
`getLevel`, and above the boundary `applyStanding()` and Junction re-deriving the
scoped client from `ctx.auth.user`, neither of which the Data-realm env reaches
yet. `atLevel(n)` is synthetic and exists for the matrix grid; it opens a second
client, because a level is fixed when a client is constructed. **Conflating them means the matrix passes while `getLevel` is broken**,
which is the failure this realm exists to prevent. Redwood is the cautionary case:
`mockCurrentUser` broke across versions, silently failed when a context function was
supplied to the GraphQL handler, and resolved asynchronously so the user was null on
first render — a mock beside the real path rather than a user through it. Laravel's
`actingAs` is the helper nobody complains about, and the difference is exactly that.

Also owned here, because nothing else will own them: **port claiming** (env tier 7,
via the existing broker — parallel suites otherwise collide silently and `strictPort`
turns that into a confusing failure rather than a clear one) and **rate-limit
awareness** (`example` signs in on every browser drive against a 10-per-15-minute
limit, and a burst of drives already reads as "broken app" in this repo).

#### Arrange / Act / Assert, enforced by scope rather than by comment

**Shipped as `env.phases()` + `env.setup()`.** All three clients
exist: `env.system` for arrange, `env.actingAs(user)` for act, and
`readOnly(actingAs(user))` for assert — graded *and* unable to write, which is
the pair that phase needs.

`readOnly` is an allow-list of the read methods rather than a deny-list of the
writes, so a write added to litestone later cannot pass through. Worth recording
that the first version looked like it guarded `asSystem` and did not: `asSystem`
is the one escape that is not `$`-prefixed, so it fell through to the table
branch and failed as *not a function*. A guard that holds by accident is the
same shape as the oracle problem one section up — it survives the test and not
the next edit.

**Benefit 1 is `env.setup(fn)`** — the arrange shared across tests rather than
declared per test, run once, snapshotted, and restored by every later `phases()`
call. It takes the same `{ system, factories, db }` `arrange` takes, so hoisting
a line out of a test is a move and not a rewrite, and the ids it returns survive
the restore.

The design question it forced: *who* restores. Making the caller do it
(`beforeEach(env.reset)`) is honest but leaves the hoist optional, and a suite
that forgets it leaks the first test's writes into the second. Making `phases()`
do it means **`phases()` begins a scenario** — which also settles what two
`phases()` calls in one test mean (two scenarios, the second starting from the
fixture) rather than leaving it undefined. `seal`/`reset` keep their own
snapshot so a suite driving them by hand is not quietly re-pointed.

A second `setup`, or a `setup` after the first scenario, is refused. Both are the
same defect — a baseline that does not describe what the tests around it started
from — and it is order-dependent, which is the shape nothing else catches.

The three phases are the right vocabulary and they map onto FJS structurally, which
is not true of a generic app: **arrange is `asSystem()`, act is the principal's
client, assert is a graded read.** Three different clients the environment already
builds — so the phases can be a fact about what is in scope rather than three
headings that drift.

Comment-structured AAA buys nothing technical, and it does not hold. A real
Playwright suite written this way (a Leads CRUD file, `// Arrange` / `// Act` /
`// Assert` throughout) drifted in five separate ways: `goto()` sat in Arrange in
five tests and in Act in a sixth, a test titled *updates UI* asserted through the
API, and two tests pinned bugs as expected values — one asserting a concatenation
where a field should have been replaced, one asserting a 500 and a leaked ORM
message where the comment above it said the correct answer was a 404.

**Four things are gained that a comment cannot give**, in order of what they are
worth:

1. **Arrange becomes cacheable.** A declared arrange can be hoisted, run once,
   snapshotted and `restore()`d per test; an inline one cannot, because nothing
   knows where setup stops. Once template-clone removes the migration cost, the
   seed is what dominates — a four-insert fixture across two hundred tests is the
   whole runtime. `snapshot()`/`restore()` already exist for exactly this.
2. **Failure classification, and retry that is sound.** Arrange failing is an
   *error* — a broken fixture, not a failing feature — where act and assert
   failures are the test failing for two different reasons. Retry is only safe
   when the framework knows the assert phase does not write; retrying a test whose
   assertions mutated state corrupts the next attempt, which is why retries
   elsewhere are a coin flip on anything data-touching.
3. **Assert reads as the principal, not as the system.** An assertion through
   `asSystem()` says *the row exists*; it does not say *this user can see it*. A
   comment lets those be the same line. This is FJS-097's shape — every row policy
   matching nothing while the suite stayed green — and a graded read client in the
   assert phase makes the conflation impossible rather than discouraged.
4. **The act boundary is the announcement window.** Junction announces through
   `callService`; arrange through `asSystem()` writes below that and announces
   nothing. Knowing where the act starts makes `env.announced()` exact instead of
   "everything since the test began", with no buffer to hand-clear.

**Shape: markers in a linear body, not callback phases.** Callbacks cost real DX —
state threaded through return values, and no bisecting by commenting out a line.
Markers keep the body linear and still carry 2, 3 and 4:

```js
test('a developer archives a lead', async (t) => {
  const lead = await t.arrange(sys => sys.factories.lead.createOne({ firstName: 'Scott' }))
  await t.act(as => as(developer).lead.archive(lead.id))
  await t.assert(read => expect(read.lead.get(lead.id)).resolves.toMatchObject({ deletedAt: notNull }))
})
```

Benefit 1 is the separate `env.setup()` slot above — snapshotted once, restored
by every `phases()` call.

### Phase 3 — constraints, factories and the derived page model

**The constraint runner shipped as `env.verifyConstraints()`.** Same argument as
Phase 1b, one realm across: `generateValidationCases` *describes* a schema, and
describing is where a generator's value stops. This executes every case against
the real write path and returns the ones that disagreed — clean on `example`
(22ms) and `basecamp` (157ms), and basecamp's own suite now asserts it.

**The oracle is structural, not textual.** The schema declares a rule, so a value
violating it must be refused; the message is not asserted, which is what keeps the
expectation independent of the code producing it. `generateValidationCases`
predicts messages from the same table the server throws from, so asserting one
would be the gate matrix's problem again.

**The finding that shaped it: a UNIQUE collision is indistinguishable from a
validator working.** Both are a throw on a write that should have been refused,
so a runner counting any throw as *rejected* passes against a validator that does
nothing at all — and the first version of this did exactly that in three separate
ways. One factory clone per model (a re-clone writes sequence 1 every time);
`fresh: true` parents (reused parents give every case identical FKs, which
collides on a `@@unique` over them); a restore between models (two models sharing
a parent each build one from their own seq 1 — 57 cases on basecamp). Each was
found by running against a real schema and reading *why* a case failed, not by
reading the count.

So the runner has **three outcomes, not two**. `error` — the write failed before
validation could refuse it — is reported rather than swallowed, because a case
that could not run is a hole in the coverage the count implies. Its first run on
basecamp was 23 error rows, none of them about basecamp. Without that outcome
they would all have read as green.

Mutation-checked against both real schemas: disabling `@gte` reports 2 and 10,
`@email` 1 and 1, `@length` 8 and 46. One branch is not test-covered and is
covered by those numbers instead — field validation runs *before* plugins, so a
declared-but-ignored rule cannot be staged from inside a schema. The stageable
direction, enforcement *stricter* than declared, has a test.

`factoryFrom` supplies the rows and needed no change; factories are what make the
*written* tier pleasant, which is why this lands close behind Phase 2 by DX value
even though it is generation work.

**The page model is derived, not written.** The Page Object is the one part of a
mature Playwright suite worth keeping — a per-noun object the tests talk through,
so a markup change lands in one file. In FJS all four of its methods already have
a source, and none of them is the object:

| Page-object method | Derived from | Exists |
| --- | --- | --- |
| `Leads.create({ … })`      | `factoryFrom(schema, 'Lead')`        | yes |
| `Leads.get(id)` / `?query` | the Junction service                 | yes |
| `Leads.goto(id)`           | the Sierra route table               | yes |
| `Leads.input({ … })` / `.select({ … })` | JSON Schema + `$context.form` | yes |

A real suite hand-writes one per noun and imports seven of them into a single
spec file. Here `Leads` is `resource('leads')` in test clothing, which makes it
the same argument as the gate matrix one rank up: **drift between the page model
and the page is structurally impossible when both come off one seed**, rather
than being a discipline someone has to keep.

### Phase 4 — schema mutation testing, the completeness proof. **Shipped.**

**Mutate the schema, not the code.** Drop each `@@gate`, grade each one down, remove
each `@guarded`, widen each `@length`, delete each `@@allow` predicate — then assert
the generated suite fails. Nothing failing means the matrix has a hole, and the
mutant names it.

Shipped as `schemaMutants()` + `mutationScore()`. **30 mutants on `example`, 232 on
`basecamp`** — the enumerability claim, measured. Nine kinds: `gate-drop`,
`gate-lower`, `allow-drop`, `deny-drop`, `guarded-drop`, `encrypted-drop`,
`unique-drop`, `validator-drop`, `validator-widen`.

**It worked as designed: the score named holes and closing them was the work.**
The first honest run was 57% on a five-field schema, and the survivors were
`gate-lower create`, `gate-lower delete`, `guarded-drop` and `unique-drop`. So
`verifyGateLadder` grew from the read column to all four operations (the factory
machinery `verifyConstraints` had just proved out supplies the fixtures),
`verifyFieldProtection` was written, and `@unique` joined `verifyConstraints`.
97% on `example` after that, with one survivor that genuinely cannot be tested.

**The trap, and it is the same one every time.** An `error` row must never count
as a kill. Every mutant came back with the same 22 error rows once, and the score
read 93% while four mutations went completely unnoticed — a mutation score
counting its own harness failures as successes is the oracle problem wearing a
percentage. Same shape as `gateLadder` asking `levelPasses()`, one level up.

**Two more findings worth keeping:**

- *Mutating prose.* `example` reported four surviving `guarded-drop` mutants on a
  model with no `@guarded` field — the matches were inside a doc comment
  explaining what `@guarded` is *not*. A mutant that edits a comment is
  behaviourally identical and survives everything, so every documented attribute
  name was quietly costing a point. A well-commented schema scored worse.
- *`parse()` and `createClient()` disagree about what is legal.* A non-monotonic
  `@@gate("4.3.4.5")` parses and the gate plugin refuses it at construction. That
  is a kill — such a schema cannot ship — but it is made by the loader, not by
  the suite, so it needed its own outcome.

This is cheap in a way code mutation is not: a `.lite` file is small and declarative,
so **the mutation space is enumerable rather than combinatorial** — low hundreds of
mutants for a 24-model app, each one a fast run against an in-memory database.

It also settles the question the whole realm turns on. "Is generation under-reaching"
stops being a judgement call and becomes a mutation score, which is the honest form of
the decision gate below. And it is the only item on this list that catches FJS-114's
shape — a green suite asserting the wrong thing.

**Novelty claim, stated accurately:** mutation testing of access-control policies has
roughly twenty years of literature behind it (an XACML fault model at WWW '07;
recent work on testing access-control configuration changes). The technique is not
new. **Shipping it as a framework command, against the app's own schema, is** — the
policy-engine world tests policies in isolation, the app-framework world tests neither,
and nothing bridges them because nothing else has one file that is both.

### Closing the last hole — `verifyRowPolicies`

**The oracle here is a second implementation, not a restatement**, and that is
what makes it different from every other check in this realm. Litestone compiles
a policy TWICE, into two languages: `compileSql` for reads (a WHERE) and
`evalJs` for creates (JavaScript). Reading rows through the compiled WHERE and
asking `evalJs` which should have come back is differential testing between two
things that already existed — the opposite of the oracle problem rather than a
careful avoidance of it. Reverting the FJS-195 fix produces 3 mismatches, which
is the proof: that bug WAS the two implementations disagreeing.

`create` is deliberately uncovered. `evalJs` is its only implementation, so
grading it with `evalJs` is circular and there is nothing else to ask.

**Placing rows on both sides is most of the work, and three things had to be
right — each found by running it against basecamp rather than by reasoning:**

1. **The compared field is usually a FOREIGN KEY.** `workspaceId ==
   auth().workspaceId` is the whole of basecamp's tenancy; a made-up value breaks
   the FK and the row never exists, so every matching-side candidate was lost and
   the model reported one row with all of it excluded.
2. **A generated sentinel must satisfy the column's own validators**, or the
   insert fails and the row is on neither side.
3. **A targeted value and a miss value are not interchangeable.**
   `verifyFieldProtection` seeded with whichever came first and hid the row from
   the very reader it was about to check — silently, and it turned a caught
   `guarded-drop` mutant into a surviving one.

**Rows on one side only are reported, never passed.** A policy that admits
everything and a policy that is not applied at all are the same observation when
every row matches. `example`'s own `@@allow('read', title != null)` over a
required column is exactly that shape, and a `allow-drop` mutant on it survives
*correctly* — deleting a no-op changes nothing anything can see.

### Phase 5 — boundary contracts

The Rainsberger grid, once the environment and the generators exist.

#### Transport parity. **Shipped.**

`env.verifyTransportParity()` — HTTP and WS answering the same call the same way,
over a real port and a real socket. `packages/testing/CHANGES.md` is the record.
It landed here rather than with the cheap parser-walk generators because it needs
a live server, which the first draft mis-costed as generation work.

**The oracle is two real transports**, which is `verifyRowPolicies`'s shape again
and the reason this one was worth building first: neither side restates what the
answer should be, so a mismatch names both answers and a person decides which is
the bug. There is genuinely no shared implementation to collapse into — HTTP goes
URL → router → `bridge.toContext()`, WS goes frame → `channels()` →
`bridge.internal()`, and everything the first derives from a request the second
lifts out of a JSON object by hand.

**Three things the build settled:**

**A derived check that cannot connect must say so.** The browser client falls
back to HTTP when no socket is live, so a runner that did not notice an app
without `channels()` would compare HTTP against HTTP, agree on everything, and
certify a transport it never spoke to. That is the same failure as the 333
assertions that asserted nothing, wearing different clothes. It is a reported
row, and so is an empty call list.

**Volatility is measured rather than named.** A created row differs from itself
run to run — a uuid, a `@default(now())`, a `@version` — and naming those fields
means knowing the schema and being wrong about an app that generates something
else. The runner makes the same call twice over HTTP and treats every path that
differs as volatile. **The WS attempt goes between the two HTTP ones**, which is
what makes it sound for a clock: two back-to-back calls can land in the same
millisecond and mark `deletedAt` stable, and then the third lands a millisecond
later and reads as a transport difference. Bracketing means the HTTP pair spans
at least as much time as the HTTP↔WS gap. Found by running it, not by reasoning.

**The port is asked for as 0 and read back.** That answers Phase 2's open *port
claiming* item for this tier and answers it better than the broker would: an
OS-chosen port cannot collide with a parallel suite at all, and the broker's job
— a port something external was told about in advance — is not what a test that
opens its own socket needs. `listen: <number>` is there for when it is.

The falsifiability test stages a hook that refuses over the socket and expects a
418 back. It got a 500, from both transports, which is `FJS-196`: junction mapped
fourteen status codes to error classes and collapsed every other one to
`GeneralError`. A deliberate 423 arrived as a server error.

#### Still to build — the generated pair

**Generate the stub with the contract**, per § Method. Nothing here does that yet;
parity is a contract test with no collaboration half, because both sides of it are
real by construction.

#### The triage — which Bridge index entries are boundaries

The open question was how many of the ~30 entries in `CLAUDE.md` § *Bridge index*
are boundaries in Rainsberger's sense rather than one-owner rules, because that is
what sizes the rest of this phase. Answer: **about eleven**, and the ranking
matters more than the count.

Three kinds of entry are in that list and only one of them wants a pair:

- **A one-owner rule** — one implementation, called directly. `wrapResult`,
  `toFrameworkError`, `runStartPhases`, `mount`, `watchProxy`, `$setAuth`,
  `accessorCandidates`, `ctx.directives`, `wsSend`. There is no second side to
  drift, so a contract test is a unit test with a longer name.
- **Closed by sharing** — `wrapResult`/`unwrapResult` is the model: the same
  function runs on both sides of the wire, so the browser client *asks* rather
  than carrying a copy. Where this is available it beats a contract test, because
  a passing test still permits drift and a shared function does not.
- **A genuine boundary** — two sides that can be edited independently, where one
  sends a message and the other honours it.

The eleven, ranked by how likely they are to be wrong today rather than by size:

| | Boundary | Why it ranks here |
| --- | --- | --- |
| 1 | `sessionGateLevel()` · `toDataPrincipal()` | **Both are hand copies on both sides**, `CLAUDE.md` says so, and both are security-relevant: the first grades a caller, the second is why every row policy compares against `undefined` when it is missed (FJS-097). Generating one from the other is the whole idea |
| 2 | `buildFieldRules()` ⇄ junction's `autoValidate` | The canonical Rainsberger pair — client validates, server validates, they must agree. The sierra module was deliberately built leaf-shaped *so it could be compared rather than copied*, and the comparison was never written |
| 3 | `authSchemaFragments()` ⇄ `cli/commands/auth/install.md` | Another declared hand copy. A scaffolded app gets the schema the CLI remembers, not the one auth ships |
| 4 | `x-messages` keyword table | One owner, two consumers looking up the keyword they failed. A rename in litestone silently loses a message in junction *and* sierra, and a missing validation message is invisible |
| 5 | `publish()` event names ⇄ subscribers | The only entry with a drift already named in `CLAUDE.md`: jetty hardcodes Feathers-style names, and litestone's `onEvent` has no Junction subscriber |
| 6 | `$checkWhere` / `$checkOrderBy` | A real request/response shape, with a clause easy to get wrong: an unknown accessor answers `[]`, and *I cannot judge this* is not *this is wrong* |
| 7 | `toFieldErrors()` | Three wire shapes reach it because each hop wraps once. Each is a contract with a different producer, and `err.data.data` exists because one of them was found by accident |
| 8 | `IAuth` | Declared by junction, implemented by auth. The stub is trivially generatable from the interface, and there is a live hole to pin: junction calls `verifyApiKey` nowhere |
| 9 | `generateJsonSchema()` → `registerSchemas()` | The `$defs` table must stay whole or an enum `$ref` dangles. A contract with one clause, and the clause is load-bearing |
| 10 | Plugin protocol | Junction ⇄ every plugin package. `register` is sync and `requires` is checked at startup — both cheap to assert against a generated stub plugin |
| 11 | `renderComponent()` slot protocols | Children must be supplied **both** ways because the two protocols do not bridge. A contract that is currently a sentence in a doc |

Two entries are now built (`bridge.toContext()`/`toResponse()`, and the HTTP/WS
pair above). **Everything from 1 to 4 is a hand copy or a lookup table, which is
the cheapest possible pair to generate** — one artefact, two emitted sides — and
that is where the rest of this phase should start.

### Phase 6 — `fli test --since`

Test selection from the declared graph. The differentiated claim is narrower than
"dependency graph": generic file-graph selection is commodity and Vitest already does
it. **The part only FJS can do is schema-to-test mapping** — change `model Order` and
run everything downstream of `Order` across all three realms, because one system knows
that the service, the resource, the form and the migration all derive from it. Blocked
on the dependency graph being declared rather than duck-typed, which is an existing
open question in `CLAUDE.md`.

### Under consideration — a literate test file

**Not decided.** Recorded because the substrate already exists and the cost is
therefore much lower here than the idea usually is.

`.test.md` — frontmatter, prose, and fenced blocks under `## Arrange` / `## Act` /
`## Assert` headings, where **the headings are the phases** and there is no comment
to drift from. `fli` is already a markdown-native command runtime over 197 command
files; `extractSegments()` in `cli/core/compiler.js` already splits a file into
ordered prose and code segments, and its own header says it exists so a GUI can
render one top to bottom. That is the document half and the interactive half,
shipped, for a different reason.

It also closes a named gap rather than adding a surface: Invariant 16 says runnable
examples are verified and a broken one is a bug. A literate test *is* the mechanism
that makes a doc verified, so the doc and the test stop being two artefacts that
can disagree.

**This is not Storybook.** Storybook is a component gallery whose stories are
fixtures, with `play()` bolted on afterwards. The lineage here is doctests — Rust,
Elixir, `mdbook test` — which is a better-evidenced one.

**The constraint, if it happens: compile to the standard runner, do not build a
runner.** `fli`'s own model — markdown-native, own runtime, own execution — is the
wrong half to copy for tests. Emit a real `.test.ts` with source maps and let bun
and Vitest run it. Three reasons, all already paid for in this repo: Invariant 15
says a clean compile is not proof of valid JS, and a broken *test* fails silently
green rather than loudly red; the ejection research above says people leave a
first-party runner over env vars before boot, coverage/HTML reporting and IDE
integration, every one of which a bespoke runtime maximises at once; and `--only`,
watch, breakpoints and per-test rerun are free from the standard runner and months
of work otherwise.

Scope it to the flow/scenario tier if it lands at all. Prose wrapped around a
three-line assertion is overhead, not documentation. The live-embedded-app leg is
a further phase with the islands machinery behind it, not a freebie from
`extractSegments`.

### Side track — `fli check`, arch tests for client apps. **Shipped.**

Ten rules in `packages/cli/core/checks.js`, reached by `fli check` for a client
app and by a new `structure` phase in `scripts/ci.mjs` for this repo.
`packages/cli/CHANGES.md` is the record. They share the engine, imported by
relative path, which was the condition this was written under: two
implementations of one rule is how a framework ends up breaking rules it
publishes.

**The membership test turned out to be sharper than "greppable".** The rule is
whether a violation is SILENT. A greppable rule whose violation already raises
an error belongs in the thing that raises it, and half the candidates from the
first draft failed on that — *no TS in a JS package* is loud the moment anything
runs. What survived splits evenly between invariants no compiler enforces and
hazards with no invariant at all, and the second half is the more valuable one:
`strictPort` absent from a vite config, and the body tag written inside a comment
in an `index.html`.

**Six findings on the first run, four real**, which is the argument for checking
a rule rather than writing it down:

- `FJS-198` — `packages/sierra/example`'s production build shipped **no
  JavaScript and no CSS**. The `index.html` explained in a comment that the theme
  goes on the body tag; vite injects at the first textual match and does not skip
  comments, so both tags landed inside the comment. The hazard is documented in
  the root `CLAUDE.md`, and the repo's own example was the thing violating it.
- `resources/leads.mesa` — lowercase, and three Resources in one file.
- two packages with a fifth markdown file at their root.

**The two false positives became rules**, which is the more useful half of a
first run: a Resource over no model may take its own service noun singularised
(basecamp's `Hub.mesa` is `createResource('hub')` and is correct), and a schema
with neither `api/` nor `web/` beside it is a fixture rather than an app that got
the layout wrong. A check that scolds every fixture in a repo is a check people
turn off.

**One rule is deliberately undecidable and says so.** `model-name-plural` is a
warning, because English is not decidable and the allow-list that would fix it
holds exactly the words a schema uses — `Address`, `Status`, `Progress`,
`Analysis`. Narrow rule, honest severity, and a false positive costs one line.

Also settled: **there is no ignore comment.** An exception is a named entry with
a reason in `scripts/ci-allowances.json` (or `runChecks({ allow })`), keyed
`'<rule>:<path>'`, **and a stale one is reported** — an exception that outlives
the thing it excused is an unenforced rule nobody knows is unenforced. The one
live entry is `packages/css/AGENTS.md`, which is a fifth root markdown file and
is the same *kind* of thing as `CLAUDE.md`; whether Invariant 17 grows to name it
is a ruling nobody has made.

---

## Generator acceptance

Kent Beck's test desiderata are the rubric a generated category has to pass before it
ships. Two properties matter disproportionately, and one is a trap.

**Structure-insensitive is free here, and it is a real architectural claim.** A test
derived from the seed asserts declared intent, not code shape, so refactoring the
implementation cannot break it. That is the property handwritten gate tests lack —
they survive a gate change and keep passing against a rule that no longer exists.

**Predictive is the point.** A passing gate matrix should mean production authorises
correctly. Phase 4 is how that stops being an assertion about the suite and becomes a
measurement of it.

**Specific is where generation fails, and it is a hard design constraint.** Four
hundred assertions failing as one wall of diff is unreadable, and unreadable output is
how FJS-114 stayed green. **A generated failure must be a sentence naming the model,
the operation and the level** — not an assertion dump. The committed access snapshot
from Phase 1 is the other half of this: it is what makes a run-time-derived suite
something a person can read at all.

---

## Not doing, and why

**No runner is exposed, but the escape hatch is real and specific.** AdonisJS is the
strongest counterexample available — the most complete first-party kit in JS, seven
years old, one CLI door — and the ejection pressure it takes is not about assertions.
It is about **controlling environment variables before the app boots** and about
**coverage and HTML reporting**. Those three, plus IDE integration, are the doors
people leave through, so those are what `fli test` must let a caller reach. Nobody
ejects because they wanted a different `expect`.

**Two runners stays**, for the reason already settled: Bun for Data and API, Vitest
for UI, because only a Vite transform speaks `.mesa`. The adapter must not reproduce
this repo's own trap, where `bun test` and `bun run test` are different commands with
different results.

**Playwright is not yet decided, whatever the first draft said.** There is no
Playwright anywhere in this repo and there are at least five hand-rolled CDP drivers
(`example/web/test/verify*.mjs`, `packages/css/test/run.js`, sierra's island
fixture). Adopting it for client apps while the repo keeps CDP means two browser
stacks maintained forever; converting the repo's drives is an uncosted phase. The
narrower move suggested by the SvelteKit migration is **Vitest browser mode** for
component and resource tests, leaving the chain tier's driver a separate question.

**No coverage threshold.** This repo's failures are silent-success, not
uncovered-line. Phase 4 is the coverage answer that actually addresses the failure
mode.

**No jsdom or happy-dom tier**, per § Two research findings.

**Schema extraction is off the critical path.** `@frontierjs/testing` ships as a thin
adapter over `@frontierjs/litestone/testing` plus the `fli` wiring. If a
`@frontierjs/schema` package happens later, one import path changes. Blocking a
security-relevant Phase 1 on a package split that touches Invariant 1 and every
consumer is the wrong order.

---

## The decision gate, restated

The first draft's gate was *demote Testing from realm to domain concern if Suite
declares nothing the schema does not already imply*. That criterion contradicts the
framework's own shape: Release is a named realm with no package and no primitives
(`IDEAS/framework-shape.md` item 3) and nobody proposes demoting it.

**The honest criterion is whether an FJS app's tests look different from a plain
Vitest project's.** If, after Phases 1–3, an app developer is still hand-writing gate
tests and hand-building fixtures, generation is under-reaching and Testing is a domain
concern. If they write only hook logic, actions and flows, the realm is earned. Phase
4 turns that from a vibe into a number.

---

## Open questions

- What is a generated test's escape hatch when a model legitimately violates a
  generated expectation, and how loud is opting out? An escape hatch nobody can find
  gets answered by disabling the whole generated suite in month three.
- Do generated tests get deleted by developers in practice? Researched and **not
  answered** — web search found nothing usable, and the question needs repo
  archaeology rather than search. It matters, because it is the empirical test of
  whether Phase 1's output is trusted or tolerated. The snapshot is the first
  chance to watch this happen here: a stale one that keeps getting regenerated
  without its diff being read is the same failure wearing a smaller diff.
- Does an app want the ladder in the snapshot as well as the required level? Today
  it renders `2 READER` per operation and the ladder is derivable from that.
  Rendering all nine columns would be the same information at nine times the diff.

**Answered by Phase 5:**

- ~~How many of the ~30 entries in `CLAUDE.md` § *Bridge index* are boundaries in
  Rainsberger's sense?~~ **About eleven**, two of them now built. See § The
  triage; the ranking is the useful part, and the top four are hand copies or
  lookup tables, which are the cheapest pairs to generate.

**Answered by Phase 1a:**

- ~~Per app or per model file?~~ **Per app**, beside the schema
  (`db/access.snapshot.md`) — one reviewable artefact, landing in the same PR as
  the schema change that moved it.
- ~~Is `basecamp` the proving ground, ahead of `example`?~~ **Yes**, and it paid
  immediately: 37 models all gated, and the first run surfaced `Volume`
  (`@@gate("2.8.8.5")`) where delete is *easier* than update. `validateGate`
  permits it because 8 is a sentinel that does not advance the non-decreasing
  check, so `delete=5` is compared against `read=2` and passes. Intended or not,
  nothing else in the repo would have said it out loud.

---

## Evidence

Researched 2026-08-11. Grouped by the question it answers.

**Test-database isolation.** Encore's `NewTestDatabase` clones from a template with
migrations pre-applied, isolated per test and sub-test, dropped automatically; it also
ships `EnableServiceInstanceIsolation` for singleton bleed between tests, which is a
problem a mounted Junction app will have too.
[Encore testing](https://encore.dev/docs/ts/develop/testing) ·
[encore.dev/et](https://pkg.go.dev/encore.dev/et).
Laravel's `RefreshDatabase` runs `migrate:fresh` per run; the community package
re-migrates only when migration files change, and the official fast path is in-memory
SQLite.
[laravel-fast-refresh-database](https://github.com/PlannrCrm/laravel-fast-refresh-database) ·
[Laravel suite speedup](https://laracraft.tech/en/blog/final-speed-up-for-your-laravel-test-suite).
Rails' parallel overhead is per-process database setup plus fixture loading; Rails
added an opt-out for creating the databases and a `before_fork` hook.
[This Week in Rails](https://rubyonrails.org/2025/5/2/this-week-in-rails) ·
[Perils of parallel testing](https://blog.appsignal.com/2022/03/16/the-perils-of-parallel-testing-in-ruby-on-rails.html).
Ecto.Sandbox's documented pain is ownership, not rollback: `async: false` → shared
mode is the documented last resort with no guarantee, processes outliving the test
take the connection with them, and `start_owner!/2` is the modern fix.
[Sandbox docs](https://hexdocs.pm/ecto_sql/Ecto.Adapters.SQL.Sandbox.html) ·
[ecto_sql #122](https://github.com/elixir-ecto/ecto_sql/issues/122) ·
[dangling processes](https://www.germanvelasco.com/blog/how-live-view-got-rid-of-dangling-processes-in-tests).

**Auth in tests.** Redwood's `mockCurrentUser` failed in four documented ways.
[redwood #3258](https://github.com/redwoodjs/redwood/issues/3258) ·
[graphql #3367](https://github.com/redwoodjs/graphql/issues/3367).
Supabase needed a third-party helper package before RLS testing was bearable —
`tests.create_supabase_user()`, `tests.authenticate_as()`.
[Basejump pgTAP helpers](https://usebasejump.com/blog/testing-on-supabase-with-pgtap) ·
[Supabase pgTAP](https://supabase.com/docs/guides/local-development/testing/pgtap-extended).

**Does anyone generate authorisation tests from an app schema? No.** Schemathesis
generates negative authorisation cases from OpenAPI scopes; OpenFGA tests a
declarative authorisation model in CI; OPA/Rego ships a policy test framework. All
three test a *policy artefact*, none derives from an application schema.
[Continuous authorisation testing](https://auth0.com/blog/continuous-authorization-testing-fga-github-ci-cd/).
Mutation testing of access-control policies is established research.
[XACML fault model, WWW '07](https://dl.acm.org/doi/10.1145/1242572.1242663) ·
[Testing access-control configuration changes](https://arxiv.org/pdf/2505.12770).

**The universal complaint is silent failure.** Supabase, on the same class of rule as
`@@allow`: blocked updates do not throw, and incorrect RLS creates silent data leaks
"far harder to detect than a broken API endpoint" — which is this repo's own hazard
note in someone else's words.
[RLS best practices](https://makerkit.dev/blog/tutorials/supabase-rls-best-practices).

**Runner ejection is about tooling, not assertions.** Japa — seven years old,
purpose-built, fully first-party — takes pressure over environment variables before
boot and over coverage/HTML reporting.
[AdonisJS testing](https://docs.adonisjs.com/guides/testing/introduction) ·
[env-var discussion](https://github.com/orgs/adonisjs/discussions/4988).

**DOM emulators are being reversed out of.** The SvelteKit migration is jsdom →
real browser under Vitest browser mode, driven by setup files grown to hundreds of
lines of mocks.
[vitest-browser-svelte](https://github.com/vitest-community/vitest-browser-svelte) ·
[migration writeup](https://scottspence.com/posts/migrating-from-testing-library-svelte-to-vitest-browser-svelte).
Rails prices the browser tier: faster Capybara drivers surfaced dozens of new flaky
failures that the slow driver's latency had been masking.
[Selenium → Cuprite](https://janko.io/upgrading-from-selenium-to-cuprite/).

**Wasp offers app developers nothing.** Its testing post covers compiler unit tests,
golden snapshots over generated code, e2e over the compiled app, deployment tests and
docs-sync — all internal. Two things worth taking anyway: golden snapshots of
generated output diffed in git, and the admission that a kitchen-sink app "cannot test
all variations", which is `example/`'s ceiling named by someone who hit it first.
[How we test a web framework](https://wasp.sh/blog/2025/10/07/how-we-test-a-web-framework).

---

## See also

- `testing-and-ci.md` — where this was first framed; its gap A shipped, its gap B is
  superseded here
- `IDEAS/slices.md` — the `suite/` part and `fli slice:doctor` have nowhere to plug in
  until Phase 2 exists
- `IDEAS/framework-shape.md` — Release as the precedent for a realm with no package
- `example/README.md` § *Found by building this* — the defect ledger § Method is
  argued against
- `CLAUDE.md` § *Bridge index* — the seam list Phase 5 has to triage
- `VERIFYING.md` — the manual discipline this automates rather than replaces
