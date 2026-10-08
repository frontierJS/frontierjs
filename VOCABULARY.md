# Vocabulary

**The words this framework defines, and what each one is.** Authored — this is
the half no scan can produce. `fli ws:terms` reads it and joins each row to
what the tree actually does with the word, so a term is defined in exactly one
place and measured somewhere else.

**Only real vocabulary belongs here.** A word that is not a term of this
framework — a tool, a place, ordinary English — is not labelled here; it is
excluded in `packages/cli/core/terms.js`, where the classifier can act on it.
A row saying *this is not a term* would be a second way of saying what a list
over there already says, and nothing would read it.

## Status

| Status | Means |
| --- | --- |
| `blessed` | use this word. The definition column is the definition |
| `refused` | never use it — **Means** names the word to use instead |
| `alias` | the same thing as another term — **Means** names it |
| `open` | seen and not yet decided. The seeded default |

`ARCHITECT.md` § 2 is the doctrine and stays prose; a term ruled there carries
`blessed` here with the same meaning. Where the two disagree, § 2 is right and
this file is stale.

**This is the root register and not the only one.** A package that defines its
own terms well enough to CHECK them has named them, and `fli ws:terms` reads
those registers rather than asking anyone to copy them here —
`@frontierjs/css/vocabulary.json` is 56 terms and 8 axes, each graded against
the real CSSOM by that package's own spec. A row here outranks one there, with
one exception that is the point: **`open` is not an answer**, so a word this
file has merely seen does not shadow a package that defined it. Those land in
`ws:terms`'s audit instead of being decided by whichever register spoke last,
because most of them are one spelling over two realms — a Table is a `<table>`
in css and a database table in litestone — and what is owed is which sense this
file is naming, not a copy of the other one.

## Placement

**Home** is where a term lives. A machinery word takes its domain from
`ARCHITECT.md` § 4, by name — `Developer`, `Config`, `Integrations`,
`Automation`, `Auth`, `Operations`. The application domain contains the realms,
so a word there takes its realm instead — `API`, `UI`, `Deployment`, `Testing` —
and `Data` is both the realm and the database domain, since Litestone owns
both. `Shared` is a word with no
single owner, not one used widely; `Framework` is a word about the framework
itself. A blank Home is unplaced, which is a question and not a bucket.

**Under** names the umbrella a term only makes sense inside — the test is
whether it can be defined without naming the parent. One parent, and a word
merely contrasted with another (Signal and Event, Channel and Transport) is not
under it.

A UI row that leaves **Under** blank takes its tier from
`packages/css/vocabulary.json`, which `fli ws:terms` reads, so `Card` is under
`Block tier` without this file saying so. State one here only where it differs
from css's, as Switch does by sitting under its task.

## Terms

Seeded from `fli ws:terms` at spread ≥ 4 — a term used in four or more
packages. Ordered by spread, which is how much of the tree you have to read
before you meet it.

| Term | Status | Home | Under | Means | Note |
| --- | --- | --- | --- | --- | --- |
| Resource | blessed | UI | | | |
| Relator | blessed | Data | Model | a relationship that is a ROW — existentially dependent on the two or more things it relates, so it cannot outlive one of them | `.lite`'s `@@relator`, [`FJS-D350`](DECISIONS.md#fjs-d350). Exact and from ontology work (UFO, Guizzardi 2005); *join table* half-fits and implies the absence of identity, which is the one thing being denied. A row whose foreign keys are OWNERSHIP rather than mediation is not one — `ApiKey` |
| Commitment | blessed | Data | Transition | a transition the system owes a row at a time derived from that row — the clock causing a WRITE, where a window is the clock changing what counts | `.lite`'s `@@commitment`, [`FJS-D353`](DECISIONS.md#fjs-d353) / [`FJS-D354`](DECISIONS.md#fjs-d354). REA's word (McCarthy 1982), whose commitment is fulfilled by an event; here it is fulfilled by a transition. Work a PERSON owes is a transition with a declared owed-by party, and its breach is a commitment ([`FJS-D634`](DECISIONS.md#fjs-d634)) |
| Transition | blessed | Data | Model | a named edge of a `@@transitions` state machine — what `db.x.transition(id, name)` makes | The word the code types; see *Move* |
| Trail | blessed | Data | Model | the record the Data boundary owes of who wrote what — declared with `@@trail` / `@trail`, held in a `driver trail` database, read through `db.<database>Trail`, redacted by Invariant 7 | [`FJS-D661`](DECISIONS.md#fjs-d661). Never *log*: the log is what the process says, disposable; the trail is retained and backed up. They share the correlation id and nothing else |
| Move | alias | Data | Transition | Transition | Prose's second name for a transition, folded by [`FJS-D353`](DECISIONS.md#fjs-d353) |
| Observer | blessed | Shared | Hook | | |
| Release | blessed | Deployment | | | |
| Hook | blessed | Shared | | | |
| Service | blessed | API | | | |
| Plugin | blessed | API | | what extends the thing it is installed into — Junction's app, Litestone's client, Vite's build | `FJS-D06`, `FJS-D631`. Name the host where it is unclear: *a Vite plugin* |
| Provider | blessed | Integrations | | | |
| Event | blessed | API | | what Junction announces — after a write, or by `announce()` — carried on a Channel to whoever may read it | `FJS-D44`, `FJS-D393`. *Announce* is its verb, and it has no second noun: *Announcement* and *Mutation* are not terms, and *a write* is the plain phrase |
| Channel | blessed | API | | | |
| Job | blessed | Automation | | | |
| Component | blessed | UI | | a `.mesa` file — a page, a layout and a Button alike; what kind is said by its parent | `FJS-D382` |
| Data realm | open | Framework | Realm | | the first of the three — where `data` alone is too generic to be a term |
| Writable derived | blessed | UI | Signal | a derived Signal that may also be written, the write passing back to its sources | mesa `$: name = expr` — `Writable` alone means nothing. The prior-art name is a lens (Foster et al. 2007), cited and not used. `FJS-D384` |
| Empty state | open | UI | Block tier | | the condition a screen is in with nothing to show; `EmptyState` is the component that renders it |
| Data boundary | open | Data | Boundary | | where access is enforced; the widest phrase in the tree |
| Warden | blessed | Data | | the whole access system: everything that decides whether a call may touch a row or a column — principal and claims, gate, capabilities, row policies, field protection, a transition's authority half. `asSystem()` lifts it and holds the integrity rules | `FJS-D546`. The Data boundary is where it enforces. Prior art is the *reference monitor* (Anderson 1972): cited, not used, because it names the mediator and not the declarations, and reads as an OS kernel |
| Capability | blessed | Data | Warden | a reference to a move the seed already declares, held by a principal per tenant — `auth().capabilities`, `@@capabilities` | `FJS-D139`, `FJS-D149`, `FJS-D151`. Never what a Plugin adds: that is *extends* (`FJS-D631`) |
| Invariant | blessed | Framework | | a rule the framework does not break without a ruling — numbered in `CLAUDE.md` § Invariants and graded by `fli ws:invariants` | a CONTRIBUTOR word: cited by number in comments and registers, where the reader has the list. An app developer does not have it, so nothing an app sees cites one by number ([`FJS-1282`](ISSUES.md#fjs-1282)) — it states the rule |
| State | open | Data | Transition | | |
| PascalCase | open | | | | |
| Phase | blessed | Shared | | a named step of an ordered list something runs — qualified at every use, *startup phase* or *CI phase*, never bare | `FJS-D395`. Junction's startup phases are one list both entry points run (Invariant 4); CI's are `scripts/ci.mjs`'s table. A Plugin's `register`/`boot`/`ready`/`shutdown` are not phases — `boot-plugins` and `ready-hooks` are the phases that call them |
| User | blessed | Auth | | the model auth resolves a principal from — one row per person who signs in | `model User` in auth's fragment, `authUserModel(db)`. `FJS-D633`. *Account* is not its second name: in apps that word is usually an organization, and it is excluded in `terms.js` |
| Table | open | Data | Model | | |
| File | open | Data | Field | | |
| Step | open | Automation | Run | | |
| Card | open | UI | | | |
| Bearer | blessed | Auth | Principal | a principal with no session, admitted by a token that names a grant row — it carries claims and no id | `bearerClaim()`, `FJS-D633`. The grant row is its Actor |
| Web | open | Framework | Surface | | |
| Litestone Studio | blessed | Data | | The browser UI `litestone studio` serves — the Data realm read and edited by hand | |
| Studio | alias | Data | Litestone Studio | `Litestone Studio`. The bare word is shorthand once a page has named it in full | |
| Popover | open | UI | | | |
| Tab | open | UI | | | |
| Homestead | open | | | | |
| Field | open | Data | Model | | |
| Host | open | Operations | | | |
| Pill | open | UI | | | |
| ServiceContext | alias | API | Context | Context — a Call's | `FJS-D391`. The type's name; in prose it is the Call's Context |
| Cancel | open | | | | |
| App | open | Framework | | | |
| Deployment | open | Deployment | Release | | |
| Item | open | | | | |
| Group | open | | | | |
| Int | open | Data | Field | | |
| GatePlugin | open | Data | Gate | | litestone's export, not Junction's |
| DateTime | open | Data | Field | | |
| Pane | open | UI | | | |
| Badge | open | UI | | | |
| Drawer | open | UI | | | |
| Window | open | Data | Model | | |
| Alert | open | UI | | | |
| Structure | open | Developer | | | |
| Switch | open | UI | Select task | | |
| Combobox | open | UI | Select task | | |
| Customer | open | | | | |
| Prose | open | UI | | | |
| DropdownMenu | open | UI | Overlay tier | | |
| Hub | open | Operations | | | |
| Product | open | | | | |
| Tooltip | open | UI | | | |
| Order | open | | | | |
| Button | open | UI | | | |
| Code | open | | | | |
| Access | open | Data | Gate | | |
| Page | open | UI | | | |
| Row | open | Data | Model | | |
| Block | open | | | | |
| Question | open | | | | |
| Domain | open | Framework | | | |
| Home | open | | | | |
| Lead | open | | | | |
| Rule | open | Developer | | | |
| Suite | blessed | Testing | | a package's `test/`, run by that package's own script — `*.test.*` collected, `*.spec.*` driven | [`FJS-D638`](DECISIONS.md#fjs-d638). A suite proves one package; a Drive proves a change end to end |
| Float | open | Data | Field | | |
| Modal | open | UI | Overlay tier | | |
| Sidebar | open | UI | | | |
| Text | open | UI | | | |
| Tier | open | Shared | Hook | | |
| DatePicker | open | UI | Quantify task | | |
| Input | open | UI | Text task | | |
| Progress | open | UI | | | |
| Layout | open | UI | | | |
| Select | open | UI | Select task | | |
| Server | open | Operations | | | |
| CommandPalette | open | UI | Overlay tier | | |
| Pagination | open | UI | | | |
| RadioGroup | open | UI | Select task | | |
| Save | open | UI | Resource | | |
| Cloud | open | Operations | | | |
| Form | open | UI | Resource | | |
| Search | open | | | | |
| Model | blessed | Data | | what exists and what rules govern it — the Data realm's noun | ARCHITECT.md § 1 |
| Gate | blessed | Data | | the ordinal per-operation level check, `@@gate` | ARCHITECT.md § 2 |
| Gate ladder | blessed | Data | Gate | the 0–9 scale, STRANGER…LOCKED | `@frontierjs/toolbelt/gate` |
| Policy | blessed | Data | Gate | `@@allow`/`@@deny` row and field predicates — never the gate | `FJS-D45` |
| Signal | blessed | UI | | Mesa's reactive cell — never crosses a Boundary | `FJS-D44` |
| Binding | blessed | UI | | a place in the compiled output that re-runs when a Signal it reads changes; `bind:` is the two-way case | `FJS-D383`. Deployment's sense is *configuration*; litestone's `@values` binding is unruled |
| Gesture | blessed | UI | | what a person does on the screen — a click, a key, a drop — named for the person and not the DOM | `FJS-D385`. *Event* is Junction's (`FJS-D44`) and *Action* is orion's |
| Effect | blessed | UI | Signal | `$: deps, handler` — work that runs when a Signal it names changes and returns nothing anyone reads | `FJS-D386`. RULE 61 runs effects last, after derivations and DOM building |
| Guard | blessed | Shared | Hook | a hook tier that only answers allow/deny | `FJS-D06` |
| Boundary | blessed | Shared | | qualified at every use — the Data boundary, the app↔world boundary | `FJS-D06` |
| Context | blessed | Shared | | plural by realm; each package documents its own by lifetime | `FJS-D03` |
| Chain of Responsibility | blessed | API | Hook | the hook pipeline | ARCHITECT.md § 2 |
| Queue | blessed | Automation | Job | what a Job runs on | `FJS-D198` |
| Run | blessed | Automation | | one bounded execution that finishes and can be interrupted and resumed — an orion run, a backfill, a deploy's journal. Not a Job: its host may or may not run its steps as Jobs | [`FJS-D634`](DECISIONS.md#fjs-d634). The noun is shared and the engine is not ([`FJS-D503`](DECISIONS.md#fjs-d503)). *Saga* is refused (a Run whose steps compensate), and the cli's *runnable* is a launch target, never a Run |
| Flow | blessed | Automation | Run | a declared sequence of steps a Run executes, declared in code or stored as data (orion's) | [`FJS-D634`](DECISIONS.md#fjs-d634). *Workflow* is refused because it half-fits three different things in the ecosystem |
| Target | blessed | Integrations | Provider | a Conduit declaration of a third party | ARCHITECT.md § 2 |
| Transport | blessed | API | Channel | the delivery medium — not the broadcast set | `FJS-D06` |
| Pivot | blessed | Automation | Run | the step past which a Run only goes forward; a step before it may be compensable. A Release's pivot is the transition at which N-1 compatibility ends | [`FJS-D634`](DECISIONS.md#fjs-d634), generalizing `FJS-D06`'s Deployment sense into one definition with the release as its instance. *Pivot transaction* is the saga literature's word |
| Realm | blessed | Framework | | Data, API, UI, Deployment, Testing | ARCHITECT.md § 1 |
| Surface | blessed | Framework | | a directory beside `db/` with its own config, tests and release — `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/` | CLAUDE.md Invariant 3. `@frontierjs/css` spells its base block shape the same way (`.surface`, the lineage of Card, Alert and Dialog); that sense is the css register's and is written `.surface` where the two could meet |
| Rig | blessed | Framework | | a package assembled from realm parts — `model/`, `service/`, `resource/`, `suite/` — any subset of which an app installs; its `service/` part is a Plugin. Notifications, orion, auth | `FJS-D630` |
| Schema | blessed | Data | | `db/schema.lite` — the declaration of what is true about the data over its whole life, and the app's one origin | `FJS-D632`. *The schema is the seed* is the thesis's metaphor (PHILOSOPHY § VIII); no sentence that means the file calls it *the seed* |
| Seed | blessed | Data | | rows written into a database before anyone uses it — development, test or reference data | `litestone seed`, litestone's `Seeder`, `FJS-D632`. The ecosystem's word, and it fits whole, so the schema gave it back. A seeded PRNG is ordinary English |
| Declaration | blessed | Framework | | what an app states for the framework to enforce or derive from — a model, a gate, a policy, a `view`, a `tenancy { }` block, a Conduit Target, a service's `methods:` | `FJS-D632`, `FJS-D45`. A Hook is code that runs. One binds from the first request, and its absence implies nothing (PHILOSOPHY § III) |
| Projection | blessed | Framework | | a second shape of a truth, derived from its origin and never written — so never writable | `FJS-D632`. A `view` projects rows; the DDL, JSON Schema, client types, a default form and mcp's tool set project the Schema. A column subset is a `select`, and a component's computed value is *derived* |
| Principal | blessed | Data | Warden | whose standing a Call is graded at — what the Warden reads a gate level and claims off | `FJS-D633`. A session, an API key and a Bearer are its kinds; an agent over MCP is one of those. `asSystem()` has none |
| Actor | blessed | Data | | who answers for an act — the audit trail's `actorId` | `FJS-D633`. Usually the principal; in support mode the operator (the principal is `subjectId`), and for a Bearer the grant row. Oracle's owner, performer and the rest are actors a row names. Never whose standing is graded |
| Tenant | blessed | Data | | the unit of data isolation a `tenancy { }` block declares — a database file, or a tenant column's value | `FJS-D633`. A Call resolves at most one. Not a customer: an app's `Account` or `Workspace` may be one, or not |
| Method | blessed | API | Service | a custom service method — never an Action | `FJS-D02` |
| Call | blessed | API | Service | one run of a service method through the pipeline — what `$` is inside, from the first hook to the announcement | `FJS-D391`. Not a Request: one request can make several Calls, and a Job makes one with none |
| Envelope | blessed | API | Call | the result shape `{ kind, object, data, errors, total?, limit?, offset? }` a Call answers in | `FJS-D391`. One owner, `junction/src/core/envelope.ts` (Invariant 4) |
| Directive | blessed | API | Call | a per-call instruction about the answer rather than a filter on it — `limit`, `offset`, `orderBy`, `select`, read into `ctx.directives` | `FJS-D391`. `$limit` is how one travels, and the `$` is transport syntax only (Invariant 10). The table is `@frontierjs/toolbelt/directives` |
| Route | blessed | API | | an HTTP handler registered with `app.get`/`app.post`/…, outside the pipeline — no hooks, no gate, no Envelope | `FJS-D391`. A Route establishes a session and everything after is a Service (`FJS-D20`) |
| Interaction task | blessed | UI | | what a control is FOR — a control is a technique for one task, and one task has many techniques | Foley, Wallace & Chan 1984: select · position · orient · path · quantify · text. `controlFor` answers four of them as `task` (sierra `INTERACTION_TASKS`), plus `bytes`, which is not Foley's and which a `File` column answers; path and orient have no column. `FJS-D384`, `FJS-D387` |
| Select task | open | UI | Interaction task | choose among values the field already knows — an enum, `x-values`, a relation, a boolean | Placement from `IDEAS/ui-ontology.md` |
| Quantify task | open | UI | Interaction task | enter an amount on a scale — a number, a date, `@money`, `@scale` | `@money` and `@scale` have no built-in technique. Placement from `IDEAS/ui-ontology.md` |
| Text task | open | UI | Interaction task | enter a string the field does not enumerate | Placement from `IDEAS/ui-ontology.md` |
| Position task | open | UI | Interaction task | place a point — `x-geo` | Placement from `IDEAS/ui-ontology.md` |
| Container tier | blessed | UI | | where a thing sits in `@frontierjs/css`'s containment ladder | The Under of a css term comes from `packages/css/vocabulary.json`'s tier, read by `fli ws:terms`; a root row states one only where it differs. `FJS-D384` |
| Frame tier | open | UI | Container tier | the application shell, persistent across navigation — App, Topbar, Sidebar, Shell | Placement from `IDEAS/ui-ontology.md` |
| Page tier | open | UI | Container tier | one screen and its panes — Screen, Pane, View, Tabs | Placement from `IDEAS/ui-ontology.md` |
| Region tier | open | UI | Container tier | a section of a page — Section, Prose, Toolbar, Nav, Pagination | Placement from `IDEAS/ui-ontology.md` |
| Block tier | open | UI | Container tier | a self-contained unit — Card, Alert, Table, Empty | Placement from `IDEAS/ui-ontology.md` |
| Inline tier | open | UI | Container tier | runs in a line of text — Button, Pill, Badge, Text, Progress | Placement from `IDEAS/ui-ontology.md` |
| Overlay tier | open | UI | Container tier | floats above the page, beside the ladder — Dialog, Drawer, Popover, Tooltip, Toast | Placement from `IDEAS/ui-ontology.md` |
| Base tier | open | UI | | the two shapes every Block and Inline term is built from — Chip, Surface. css says it is not a containment tier | Read from `packages/css/vocabulary.json` |
| Layout tier | open | UI | | one arrangement each and no skin, composable onto any tier — Stack, Cluster, Center, Split, Container | Read from `packages/css/vocabulary.json`; across the ladder, not on it |
| Detail | open | | | | |
| Portal | open | | | | |
| Session | open | | | | |
| Reference | open | | | | |
| Secret | open | | | | |
| BigInt | open | | | | |
| Undo | open | | | | |
| Slider | open | | | | |
| Toaster | open | | | | |
| Pass | open | | | | |
| Origin | open | Shared | | | Two live senses, neither ruled ([`FJS-D656`](DECISIONS.md#fjs-d656)): the doctrine's *one origin* of truth (PHILOSOPHY axiom 1, the Schema row) and the browser's scheme+host+port (csrf, `FJS-D345`). litestone's cross-process `origin` column names a writer, and SQLite's index `origin` is SQLite's word |
| Start | open | | | | |
| Ring | open | Framework | | one band of the order a newcomer reads the workspace in, center out — a package's is the `Ring` column of the root `CLAUDE.md` table | `fli ws:atlas --as=rings`. Not a dependency layer: the spine imports the substrate one ring out, and is read first anyway |
| Environment | blessed | Deployment | | a named place a Release serves from — it supplies configuration only, and is mutable but generational: serving state is (Release, generation). Qualified at every use: a *deploy environment*, a *test environment* | [`FJS-D636`](DECISIONS.md#fjs-d636). `createTestEnv` stands up the test sense. The port schema's ENV digit and environment variables are ordinary English; basecamp's `model Environment` is an app's |
| Promote | blessed | Deployment | Release | deploy a digest that already served in another deploy environment — a deploy the journal recognizes, never a kind of its own | [`FJS-D636`](DECISIONS.md#fjs-d636). The digest moves and a new Release is minted, since a Release's id hashes its configuration. A *promoted key* (tenant-declared fields) is the Data realm's; widening an Audience is not a promotion |
| Promotion | refused | Deployment | | Promote — a deploy, not a noun | [`FJS-D636`](DECISIONS.md#fjs-d636) |
| Audience | open | | | | [`FJS-D636`](DECISIONS.md#fjs-d636). Four senses live: litestone's `audience: 'client' \| 'system'` (`FJS-D454`), a credential's audience (sierra fetch, the JWT `aud`), an app's own column (`example`'s `Discount.audience`), and Deployment's proposed set of principals a Release is served to (`IDEAS/release-transitions.md`, unbuilt). A webhook's is a *subscriber*. Ruled when Phase 4 builds the routing |
| Entitlement | refused | Data | Warden | Capability, or a claim (`FJS-D514`) | [`FJS-D637`](DECISIONS.md#fjs-d637). Nothing is a tenant-held grant yet; what a tenant has paid for is ruled when an app first gates a feature on its plan |
| Drive | blessed | Testing | | a script that runs an app or a package end to end — a real server and database, usually a real browser — and asserts on what a person or a caller would see | [`FJS-D638`](DECISIONS.md#fjs-d638). Listed in `DRIVES.md`; `fli proves` names the ones a diff needs. `@frontierjs/mesa/drive` is the CDP harness one steers Chrome with |
| Stressor | open | Testing | | | [`FJS-D638`](DECISIONS.md#fjs-d638) left it open: a product built to find seams, listed in `IDEAS/stressors.md` — an exercise, not something the framework runs |
| Snapshot | blessed | Testing | | a committed `*.snapshot.*` file that names the command that generated it — the `snapshots` CI phase reruns it with `--check` | [`FJS-D638`](DECISIONS.md#fjs-d638). The audit trail's before/after copies are an *audit snapshot* |
| Vector | blessed | Testing | | conformance data — an input and its expected output, runnable against any implementation, each set pairing a positive case with its negative control | [`FJS-D638`](DECISIONS.md#fjs-d638), `FJS-D631`. `IDEAS/specifications.md` |
| Fixture | blessed | Testing | | a file a test reads | [`FJS-D638`](DECISIONS.md#fjs-d638). Not a Seed, which is rows written (`FJS-D632`) |
| Person | blessed | Data | Model | a model whose every row is a person — `@@person`; `@@person(child)` when every row is a child in the legal sense | [`FJS-D657`](DECISIONS.md#fjs-d657). An `@@auth` model is one by derivation. Where erase and export walks start. Not *subject*, which is the role |
| Personal | blessed | Data | Field | a column about a person — `@personal(category?)`; the trail does not keep it | [`FJS-D657`](DECISIONS.md#fjs-d657). Not *PII*, the narrower US sense. The category is one of thirteen, closed |
| Subject | blessed | Shared | | the person something is about — a ROLE, never a kind of model | [`FJS-D657`](DECISIONS.md#fjs-d657). The claim grammar's `<subject>` column (`FJS-D359`), `membershipClaim({ subject })`, support mode (`FJS-D574`), a bearer link (`FJS-D342`), oracle's link actor. A mail `subject` is unrelated |
| Sensitivity | refused | Data | Personal | a category of `@personal` | [`FJS-D657`](DECISIONS.md#fjs-d657). A graded ladder whose levels no consumer interprets |
| Adversary | blessed | Shared | | one named class of attacker, a row key in `THREATS.md` | [`FJS-D656`](DECISIONS.md#fjs-d656). The operator is a trusted row |
| Promise | blessed | Shared | Boundary | what holds on the far side of a boundary whatever an adversary sends; it cites the ruling that holds it | [`FJS-D656`](DECISIONS.md#fjs-d656). Not a Commitment, which is a schema-level obligation on a row |
| Fault | blessed | API | | a classified failure — a kind from `FAULT_KINDS`, with `retryable` and `indeterminate` derived from it | [`FJS-D655`](DECISIONS.md#fjs-d655), building `FJS-D201`. Whoever sees the failure classifies it. Every layer that may try again reads it |
| Dead | blessed | API | Fault | the state of a durable retrier's row once it has given up; `retry(id)` is the way back | [`FJS-D655`](DECISIONS.md#fjs-d655). Caravan and webhooks store it. The outbox derives it from `attempts`. Webhooks' `failed` is an attempt that will be retried, not a terminal state |
