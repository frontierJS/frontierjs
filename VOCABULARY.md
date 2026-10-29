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

**This is the root vocabulary and not the only one.** A package that defines its
own terms well enough to CHECK them has named them, and `fli ws:terms` reads
those vocabularies rather than asking anyone to copy them here —
`@frontierjs/css/vocabulary.json` is 56 terms and 8 axes, each graded against
the real CSSOM by that package's own spec. A row here outranks one there, with
one exception that is the point: **`open` is not an answer**, so a word this
file has merely seen does not shadow a package that defined it. Those land in
`ws:terms`'s audit instead of being decided by whichever vocabulary spoke last,
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

## The sign `$`

**`$` is a character the house uses five ways, and only one is on the wire.** A `$`-PREFIXED KEY in a query or a frame is a directive (`$limit`, `$offset`, `$after`, `$orderBy`, `$select`, `$populate`, `$search`, the `$with*`/`$only*` flags, `$asOf`, `$scope`, `$recursive`) or a transport flag (`$first`, `$wrap`), and the table in `@frontierjs/toolbelt/directives` is the whole list — a `$` key it does not name is refused by name (Invariant 10), and `$or`/`$and`/`$not` are the filters written with a `$`. The other four are not that and never travel: litestone's system verbs on a client (`db.$setAuth`, `db.$checkWhere`), Junction's ambient Call `$` (the Call row below), Mesa's `$:` effects and `$context`, and JSON Schema's `$ref`/`$defs`. A name that starts with `$` and is not in the directives table is one of these four or a typo, and the first place to ask is which side of the bridge it is on.

## The sign `@`

**`@` is a character the house uses four ways, and only one is a VALUE.** The day token `@today`, `@today-6`, `@today+7` is a filter value a relative preset writes into the URL (`FJS-D1601`): days only, `readDayToken`/`dayToken` in `@frontierjs/toolbelt/query` are the spelling's one owner, and `resolveDayTokens` turns it into days or instants on the client before the request, against date and instant columns only — so a text filter on the literal `@today` is text. The server never sees a token; one that leaks to a date column is refused by name in litestone (`FJS-3583`). The other three are names, never values: a `.lite` attribute (`@date`, `@encrypted`, `@@allow`), the npm scope (`@frontierjs/…`), and Mesa's template blocks (`{@html}`, `{@render}`, `{@const}`, `{@attach}`).

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
| Driver | blessed | Data | | which kind of database a declaration is — `database x { driver sqlite }`, `jsonl` or `trail` | [`FJS-D1259`](DECISIONS.md#fjs-d1259). Laravel's word for this idea; Prisma's `provider` is a third party here, and Drizzle's `dialect` names SQL, which `jsonl` and `trail` are not. Never a third party: that is a Provider |
| Engine | blessed | Data | | what runs the SQL — `#sql-engine`'s `bun:sqlite` on a server, SQLite's wasm over `opfs-sahpool` in a worker | [`FJS-D1259`](DECISIONS.md#fjs-d1259). A `sqlite` Driver runs on either Engine, so the two are layers and each needs its word |
| Move | alias | Data | Transition | Transition | Prose's second name for a transition, folded by [`FJS-D353`](DECISIONS.md#fjs-d353) |
| Observer | blessed | Shared | Hook | | |
| Release | blessed | Deployment | | | |
| Hook | blessed | Shared | | | |
| Service | blessed | API | | | |
| Plugin | blessed | API | | what extends the thing it is installed into — Junction's app, Litestone's client, Vite's build | `FJS-D06`, `FJS-D631`. Name the host where it is unclear: *a Vite plugin* |
| Provider | blessed | Integrations | | a third party the app integrates with, declared once, holding the credentials both ends spend — a Target is where we send, a Receiver where it calls us | `FJS-D681`. Not *integration*, *adapter* or *driver* |
| Event | blessed | API | | what Junction announces — after a write, or by `announce()` — carried on a Channel to whoever may read it | `FJS-D44`, `FJS-D393`. *Announce* is its verb, and it has no second noun: *Announcement* and *Mutation* are not terms, and *a write* is the plain phrase |
| Channel | blessed | API | | | |
| Job | blessed | Automation | | | |
| Component | blessed | UI | | a `.mesa` file — a page, a layout and a Button alike; what kind is said by its parent | `FJS-D382` |
| Data realm | open | Framework | Realm | | the first of the three — where `data` alone is too generic to be a term |
| Writable derived | blessed | UI | Signal | a derived Signal that may also be written, the write passing back to its sources | mesa `$: name = expr` — `Writable` alone means nothing. The prior-art name is a lens (Foster et al. 2007), cited and not used. `FJS-D384` |
| Empty state | open | UI | Block tier | | the condition a screen is in with nothing to show; `EmptyState` is the component that renders it |
| Data boundary | open | Data | Boundary | | where access is enforced; the widest phrase in the tree |
| Warden | blessed | Data | | the whole access system: everything that decides whether a call may touch a row or a column — principal and claims, gate, capabilities, row policies, field protection, a transition's authority half. `asSystem()` lifts it and holds the integrity rules | `FJS-D546`. The Data boundary is where it enforces. Prior art is the *reference monitor* (Anderson 1972): cited, not used, because it names the mediator and not the declarations, and reads as an OS kernel |
| Capability | blessed | Data | Warden | a reference to a transition the seed already declares, held by a principal per tenant — `auth().capabilities`, `@@capabilities` | `FJS-D139`, `FJS-D149`, `FJS-D151`. Never what a Plugin adds: that is *extends* (`FJS-D631`) |
| Invariant | blessed | Framework | | a rule the framework does not break without a ruling — numbered in `CLAUDE.md` § Invariants and graded by `fli ws:invariants` | a CONTRIBUTOR word: cited by number in comments and registers, where the reader has the list. An app developer does not have it, so nothing an app sees cites one by number ([`FJS-1282`](ISSUES.md#fjs-1282)) — it states the rule |
| Owner | blessed | Framework | | the one place with authority over a capability's definition and lifecycle — many may take part, one decides | PHILOSOPHY axiom 3, Invariants 4 and 5. An app's `ownerId` column is not this; who owns a row is an Actor role |
| Register | blessed | Framework | | a document kind — dated, cited, append-only: `DECISIONS.md`, `ISSUES.md` | PHILOSOPHY § document kinds. Not a list of terms: this file and `css/vocabulary.json` are vocabularies. The verb `register` (the Plugin protocol, `app.registerX`) is a different word |
| Ruling | blessed | Framework | Register | one `FJS-D##` entry in `DECISIONS.md`, binding until marked `superseded-by`, `amended-by` or `withdrawn` | Precedence: invariant, then ruling, then map (PHILOSOPHY). A defect is an `FJS-###` row in `ISSUES.md`, not a ruling |
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
| Host | blessed | Operations | Server | the Server Basecamp itself runs on (`basecamp-host`, `domain/host/`); a sub-word of Server, as Machine is for the vendor's spec (`MachineSpec`) | [`FJS-D1612`](DECISIONS.md#fjs-d1612) |
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
| Page | blessed | UI | Component | a Component under `src/routes/` that sierra renders at a URL; its URL binding is a *page route* | [`FJS-D693`](DECISIONS.md#fjs-d693). Not css's Page tier, which keeps its qualifier |
| Journey | refused | UI | | say which of four: navigation (sierra's router), a row's progress (`@@transitions`), a checklist (a projection), or a wizard (one form over several panes, the screen's own state) | [`FJS-D693`](DECISIONS.md#fjs-d693). UX research's word for a narrative someone draws. Not a Flow, and not *Pipeline* (junction's hook pipeline; the CRM sense is a row's stages) |
| Checklist | open | UI | | reserved: a declared, ordered list of checks over the data, each naming the page that satisfies it, progress derived and never stored | [`FJS-D693`](DECISIONS.md#fjs-d693). Coined when `IDEAS/in-app-guide.md` tier 2 reads it and a second app writes an onboarding |
| Row | open | Data | Model | | |
| Block | open | | | | |
| Question | open | | | | |
| Domain | blessed | Framework | | never bare: *business domain* (what an app models), *DNS domain* (cloudflare-edge's `Domain` model), or ARCHITECT § 4's domain map, named as that section names it | [`FJS-D678`](DECISIONS.md#fjs-d678). Three live senses and none owns the word, so each use says which |
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
| Layout | blessed | UI | Component | a `_module.mesa` that wraps every page beneath it; layouts nest | [`FJS-D693`](DECISIONS.md#fjs-d693). Not css's Layout tier (Stack, Cluster), which keeps its qualifier |
| Select | open | UI | Select task | | |
| Server | blessed | Operations | | one machine, at a cloud or made by hand — Basecamp's `Server` row, every `--server` flag, `fli server:*`'s noun. Host and Machine are its sub-words, never a second name for the box | [`FJS-D1612`](DECISIONS.md#fjs-d1612) |
| CommandPalette | open | UI | Overlay tier | | |
| Pagination | open | UI | | | |
| RadioGroup | open | UI | Select task | | |
| Save | open | UI | Resource | | |
| Cloud | open | Operations | | | |
| Form | open | UI | Resource | | |
| Search | open | | | | |
| Model | blessed | Data | | a data structure and the semantics that govern it — what it relates to, who may reach it, how it may change — the Data realm's noun | ARCHITECT.md § 1 · `FJS-D1044` |
| Gate | blessed | Data | | the ordinal per-operation level check, `@@gate` | ARCHITECT.md § 2 |
| Gate ladder | blessed | Data | Gate | the 0–9 scale, STRANGER…LOCKED | `@frontierjs/toolbelt/gate`. A principal's *ceiling* is the highest rung its standing reaches; inside an Episode it is the subject's, which bounds the operator with nothing to check ([`FJS-D865`](DECISIONS.md#fjs-d865)) |
| Standing | blessed | Data | Gate ladder | the rung a principal is graded at for one Call — what the app's principal resolver answers, claims included, never the session alone | [`FJS-D865`](DECISIONS.md#fjs-d865). The Principal row's word and mcp's (`standingOf`: which tools a standing sees). Not an alias of *level*: a level is a rung, a standing is a principal's place on it |
| Policy | blessed | Data | Gate | `@@allow`/`@@deny` row and field predicates — never the gate | `FJS-D45` |
| Trait | blessed | Data | Model | a reusable fragment of a Model's structure — fields and model attributes, never a `@@gate` — declared `trait T { }`, spliced into a model by `@@trait(T)` and erased at parse | `FJS-D1044` · litestone `docs/traits.md`. The test Factory's named presets are `states`, not traits |
| Signal | blessed | UI | | Mesa's reactive cell — never crosses a Boundary | `FJS-D44` |
| Binding | blessed | UI | | a place in the compiled output that re-runs when a Signal it reads changes; `bind:` is the two-way case | `FJS-D383`. Deployment's sense is *configuration*; litestone's `@values` binding is unruled |
| Gesture | blessed | UI | | what a person does on the screen — a click, a key, a drop — named for the person and not the DOM | `FJS-D385`. *Event* is Junction's (`FJS-D44`) and *Action* is orion's |
| Effect | blessed | UI | Signal | `$: deps, handler` — work that runs when a Signal it names changes and returns nothing anyone reads | `FJS-D386`. RULE 61 runs effects last, after derivations and DOM building |
| Guard | blessed | Shared | Hook | a hook tier that only answers allow/deny | `FJS-D06` |
| Boundary | blessed | Shared | | qualified at every use — the Data boundary, the app↔world boundary | `FJS-D06` |
| Seam | blessed | Shared | Boundary | one owned translation across a boundary — the one place a thrown value becomes a status, the envelope is wrapped, `$`-params are parsed, a write is announced; Invariant 4 counts them | [`FJS-D869`](DECISIONS.md#fjs-d869). `fli check seam-owner` and `seam-listed` grade it; the list is root `CLAUDE.md` § Bridge index and the `bridge-index` skill. *Handoff* stays the plain phrase and *bridge* is not a term |
| Entry | blessed | API | Resource | the browser client's one copy of a row, keyed by MODEL and id — the synced truth every view of that row points at; it holds no draft and no optimistic value of its own, and it lingers a TTL after the last view lets go | [`FJS-D867`](DECISIONS.md#fjs-d867), [`FJS-D138`](DECISIONS.md#fjs-d138). `client.entries`, `EntryRegistry` in `junction/src/client/entries.ts`, `entryTtlMs`. *Node* stays orion's flow node and mesa's IR node; Relay's word for this is *record* and Apollo's is *cache entry*, and *record* is `resource.record(id)` here — the view of one entry, not the entry |
| Tether | blessed | API | Resource | the rows one query answers, kept in sync by pushes: bounded by the query its last `load()` ran with, a VIEW over Entries once bound, and the one thing a list screen subscribes to | [`FJS-D866`](DECISIONS.md#fjs-d866), [`FJS-D1318`](DECISIONS.md#fjs-d1318). The class in `junction/src/client/index.ts`, `TetherBinding`, and sierra's `resource.tethered()` — the one door a screen lists rows through, and the one *tether* word on a Resource. *Store* is refused for it (ARCHITECT § 2) and stays the word for an unsynced holder — a module's own state; *live store* in prose is this |
| Context | blessed | Shared | | plural by realm; each package documents its own by lifetime | `FJS-D03` |
| Chain of Responsibility | blessed | API | Hook | the hook pipeline | ARCHITECT.md § 2 |
| Queue | blessed | Automation | Job | what a Job runs on | `FJS-D198` |
| Run | blessed | Automation | | one bounded execution that finishes and can be interrupted and resumed — an orion run, a backfill, a deploy's journal. Not a Job: its host may or may not run its steps as Jobs | [`FJS-D634`](DECISIONS.md#fjs-d634). The noun is shared and the engine is not ([`FJS-D503`](DECISIONS.md#fjs-d503)). *Saga* is refused (a Run whose steps compensate), and the cli's *runnable* is a launch target, never a Run |
| Flow | blessed | Automation | Run | a declared sequence of steps a Run executes, declared in code or stored as data (orion's) | [`FJS-D634`](DECISIONS.md#fjs-d634). *Workflow* is refused because it half-fits three different things in the ecosystem |
| Target | blessed | Integrations | Provider | a place this app sends to or subscribes to — an address, or a `broker` (`FJS-D235`) | ARCHITECT.md § 2, `FJS-D681` |
| Receiver | blessed | Integrations | Provider | a Conduit declaration of a route a Provider calls us on — its path, which credential verifies a delivery, the Provider's Dialect, whose tenant an event is about, and what to do with it. Conduit runs the order and keeps the receipt; it never mints a principal | `FJS-D681`, record per `FJS-D899`. A raw route that calls `verifyRequest` by hand is a route, not a Receiver. Not *listener* (a socket), *source* (a broker is a Target), *webhook handler* (Hook is pipeline code) or *endpoint* |
| Dialect | blessed | Integrations | Receiver | how one Provider signs, what its envelope is and what names one delivery — `verify · parse · dedupeKey`, pure functions a connector exports and a Receiver names | `FJS-D899`. The vendor's half of receiving (`FJS-D153`); conduit's half is the order |
| Transport | blessed | API | Channel | the delivery medium — not the broadcast set | `FJS-D06` |
| Pivot | blessed | Automation | Run | the step past which a Run only goes forward; a step before it may be compensable. A Release's pivot is the transition at which N-1 compatibility ends | [`FJS-D634`](DECISIONS.md#fjs-d634), generalizing `FJS-D06`'s Deployment sense into one definition with the release as its instance. *Pivot transaction* is the saga literature's word |
| Contract | blessed | Deployment | Release | the verdict on a change that narrows what N-1 relies on — a drop, a field made required, a narrowing. `classifyPivot` answers expand · contract · unknown, and unknown counts as contract | [`FJS-D678`](DECISIONS.md#fjs-d678). The expand/contract of Fowler's parallel change. Never the promise itself: what a published interface guarantees is a Promise, and a contract is the change that ends it at a Pivot |
| Realm | blessed | Framework | | Data, API, UI, Deployment, Testing | ARCHITECT.md § 1 |
| Surface | blessed | Framework | | a directory beside `db/` with its own config, tests and release — `api/`, `web/`, `site/`, `widgets/`, `extension/`, `desktop/` | CLAUDE.md Invariant 3; [`FJS-D678`](DECISIONS.md#fjs-d678). An interface that is not a directory is not a surface: mcp's tool set is a Projection (`FJS-D632`), and the control page and the command line are named for what they are. What an app answers — its services, routes and plugins — is `AppDescription` (`describeApp`, `junction app`, `app.snapshot.md`), beside the existing `ServiceDescription` ([`FJS-D868`](DECISIONS.md#fjs-d868)). `@frontierjs/css` spells its base block shape the same way (`.surface`); that sense is the css vocabulary's and is written `.surface` where the two could meet |
| Rig | blessed | Framework | | a package assembled from realm parts — `model/`, `service/`, `resource/`, `suite/` — any subset of which an app installs; its `service/` part is a Plugin. Notifications, orion, auth | `FJS-D630` |
| Kit | blessed | Framework | | a package of parts one realm composes, taken as a dependency — email-kit, print-kit, site-kit, the ui component kit | [`FJS-D1257`](DECISIONS.md#fjs-d1257). A package installed across realms is a Rig, and *kit* is refused for it |
| Schema | blessed | Data | | `db/schema.lite` — the declaration of what is true about the data over its whole life, and the app's one origin | `FJS-D632`. *The schema is the seed* is the thesis's metaphor (PHILOSOPHY § VIII); no sentence that means the file calls it *the seed* |
| Seed | blessed | Data | | rows written into a database before anyone uses it — development, test or reference data | `litestone seed`, litestone's `Seeder`, `FJS-D632`. The ecosystem's word, and it fits whole, so the schema gave it back. A seeded PRNG is ordinary English |
| Migration | blessed | Data | Schema | a change to a database's structure that litestone's differ derives from the Schema, or a data migration written beside it | `FJS-D148`: a rename emits a data migration. Never an upgrade path for the framework's own past — pre-alpha owes none (CLAUDE.md § Evolution policy) |
| Declaration | blessed | Framework | | what an app states for the framework to enforce or derive from — a model, a gate, a policy, a `view`, a `tenancy { }` block, a Conduit Target, a service's `methods:` | `FJS-D632`, `FJS-D45`. A Hook is code that runs. One binds from the first request, and its absence implies nothing (PHILOSOPHY § III) |
| Projection | blessed | Framework | | a second shape of a truth, derived from its origin and never written — so never writable | `FJS-D632`. A `view` projects rows; the DDL, JSON Schema, client types, a default form and mcp's tool set project the Schema. A column subset is a `select`, and a component's computed value is *derived* |
| Principal | blessed | Data | Warden | whose standing a Call is graded at — what the Warden reads a gate level and claims off | `FJS-D633`. A session, an API key and a Bearer are its kinds; an agent over MCP is one of those. `asSystem()` has none |
| Claim | blessed | Data | Warden | a fact a principal carries for one Call — what a resolver adds and a gate reads as `auth().<claim>`; `$claimsFor`, `bearerClaim` | [`FJS-D1255`](DECISIONS.md#fjs-d1255). JWT's and OIDC's word. Taking an `app.<thing>` is `app.own`, not a claim (Invariant 5). Two other things are spelled *claim* and are not this one: `claimIdempotency` (junction) takes a SLOT — it holds a key for the length of one Call, so a second arrives and is refused; and `fli check` grades a *claim* — a statement in a document, true only when an authority in the tree says so. Neither is a fact a principal carries, so each is written with its noun (*an idempotency claim*, *a check claim*) wherever it could meet the principal's |
| Actor | blessed | Data | | who answers for an act — the audit trail's `actorId` | `FJS-D633`. Usually the principal; in support mode the operator (the principal is `subjectId`), and for a Bearer the grant row. Oracle's owner, performer and the rest are actors a row names. Never whose standing is graded |
| Tenant | blessed | Data | | the unit of data isolation a `tenancy { }` block declares — a database file, or a tenant column's value | `FJS-D633`. A Call resolves at most one. Not a customer: an app's `Account` or `Workspace` may be one, or not |
| Method | blessed | API | Service | a custom service method — never an Action | `FJS-D02` |
| Call | blessed | API | Service | one run of a service method through the pipeline — what `$` is inside, from the first hook to the announcement | `FJS-D391`. Not a Request: one request can make several Calls, and a Job makes one with none |
| Envelope | blessed | API | Call | the result shape `{ kind, object, data, errors, total?, limit?, offset? }` a Call answers in | `FJS-D391`. One owner, `junction/src/core/envelope.ts` (Invariant 4) |
| Directive | blessed | API | Call | a per-call instruction about the answer rather than a filter on it — `limit`, `offset`, `orderBy`, `select`, read into `ctx.directives` | `FJS-D391`. `$limit` is how one travels, and the `$` is transport syntax only (Invariant 10). The table is `@frontierjs/toolbelt/directives` |
| Route | blessed | API | | an HTTP handler registered with `app.get`/`app.post`/…, outside the pipeline — no hooks, no gate, no Envelope | `FJS-D391`. A Route establishes a session and everything after is a Service (`FJS-D20`). Sierra's URL-to-page binding is a *page route* wherever the two could meet, unchecked ([`FJS-D693`](DECISIONS.md#fjs-d693)) |
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
| session-changed | blessed | UI | | the `fjs:session-changed` event Sierra dispatches on `document` when the person at the browser changes (a token change, a support episode starting or ending) — what the kit's toast, alert and palette stores clear on | [`FJS-D905`](DECISIONS.md#fjs-d905). The one owner is `_identityChanged` in sierra's `resource/index.js` |
| Portal | open | | | | |
| Session | blessed | Auth | | a sign-in — what `/auth/*` establishes and a row of auth's `Session` model stores | [`FJS-D680`](DECISIONS.md#fjs-d680), [`FJS-D20`](DECISIONS.md#fjs-d20). The browser's `sessionStorage` is the ecosystem's word |
| Episode | blessed | Auth | Session | one support-mode excursion: an operator's session resolving to a subject until it ends or `endsAt` passes — the principal is the subject's, so the subject's standing bounds it, and the trail files the operator as actor, the subject as `subjectId` | [`FJS-D865`](DECISIONS.md#fjs-d865), [`FJS-D835`](DECISIONS.md#fjs-d835). `episodeId` is the operator's own session id, derived rather than minted (`junction/src/auth/types.ts`). *Support mode* is the feature and an episode one use of it; *impersonation* is not a noun here |
| Account | blessed | Auth | | auth's `account` service — the signed-in user's own settings | [`FJS-D680`](DECISIONS.md#fjs-d680). An app's own `Account` model is its business-domain word, not this one |
| Reference | open | | | | |
| Secret | open | | | | |
| BigInt | open | | | | |
| Undo | open | | | | |
| Slider | open | | | | |
| Toaster | open | | | | |
| Pass | open | | | | |
| Origin | blessed | Shared | | never bare: *origin of truth* (PHILOSOPHY axiom 1, the Schema row) or *HTTP origin* (scheme+host+port — csrf, `FJS-D345`) | [`FJS-D678`](DECISIONS.md#fjs-d678), settling what `FJS-D656` left open. litestone's cross-process `origin` column names a writer, and SQLite's index `origin` is SQLite's word |
| Start | open | | | | |
| Ring | open | Framework | | one band of the order a newcomer reads the workspace in, center out — a package's is the `Ring` column of the root `CLAUDE.md` table | `fli ws:atlas --as=rings`. Not a dependency layer: the spine imports the substrate one ring out, and is read first anyway |
| Environment | blessed | Deployment | | a named place a Release serves from — it supplies configuration only, and is mutable but generational: serving state is (Release, generation). Qualified at every use: a *deploy environment*, a *test environment* | [`FJS-D636`](DECISIONS.md#fjs-d636). `createTestEnv` stands up the test sense. The port schema's ENV digit and environment variables are ordinary English; basecamp's `model Environment` is an app's |
| Promote | blessed | Deployment | Release | deploy a digest that already served in another deploy environment — a deploy the journal recognizes, never a kind of its own | [`FJS-D636`](DECISIONS.md#fjs-d636). The digest moves and a new Release is minted, since a Release's id hashes its configuration. A *promoted key* (tenant-declared fields) is the Data realm's; widening an Audience is not a promotion |
| Promotion | refused | Deployment | | Promote — a deploy, not a noun | [`FJS-D636`](DECISIONS.md#fjs-d636) |
| Audience | open | | | | [`FJS-D636`](DECISIONS.md#fjs-d636). Four senses live: litestone's `audience: 'client' \| 'system'` (`FJS-D454`), a credential's audience (sierra fetch, the JWT `aud`), an app's own column (`example`'s `Discount.audience`), and Deployment's proposed set of principals a Release is served to (`IDEAS/release-transitions.md`, unbuilt). A webhook's is a *subscriber*. Ruled when Phase 4 builds the routing |
| Entitlement | refused | Data | Warden | Capability, or a claim (`FJS-D514`) | [`FJS-D637`](DECISIONS.md#fjs-d637). Nothing is a tenant-held grant yet; what a tenant has paid for is ruled when an app first gates a feature on its plan |
| Drive | blessed | Testing | | a script that runs an app or a package end to end — a real server and database, usually a real browser — and asserts on what a person or a caller would see | [`FJS-D638`](DECISIONS.md#fjs-d638). Listed in `DRIVES.md`; `fli proves` names the ones a diff needs. `@frontierjs/mesa/drive` is the CDP harness one steers Chrome with |
| Stressor | blessed | Testing | | a real product built on FrontierJS to find its seams, listed in `IDEAS/stressors.md` | [`FJS-D680`](DECISIONS.md#fjs-d680). An exercise, not something the framework runs |
| Snapshot | blessed | Testing | | a committed `*.snapshot.*` file that names the command that generated it — the `snapshots` CI phase reruns it with `--check` | [`FJS-D638`](DECISIONS.md#fjs-d638). The trail's `before`/`after` values are a *before-image* and an *after-image*, never snapshots ([`FJS-D678`](DECISIONS.md#fjs-d678)) |
| Vector | blessed | Testing | | conformance data — an input and its expected output, runnable against any implementation, each set pairing a positive case with its negative control | [`FJS-D638`](DECISIONS.md#fjs-d638), `FJS-D631`. `IDEAS/specifications.md` |
| Fixture | blessed | Testing | | a file a test reads | [`FJS-D638`](DECISIONS.md#fjs-d638). Not a Seed, which is rows written (`FJS-D632`) |
| Stand-in | blessed | Testing | | a local fake of a Provider that a drive starts, resets or breaks on purpose — SeaweedFS for a bucket, the in-app mail and payment sinks | [`FJS-D1509`](DECISIONS.md#fjs-d1509). A *sink* is a stand-in that only receives. Listed in `IDEAS/third-party.md` § Stand-ins |
| Sidecar | refused | Deployment | | self-hosted third-party software, an open noun in `packages/basecamp/docs/VISION.md` | [`FJS-D1509`](DECISIONS.md#fjs-d1509). Already two senses: a dev listener the app started (a stand-in, `FJS-D460`) and a file beside a database (litestone) |
| Person | blessed | Data | Model | a model whose every row is a person — `@@person`; `@@person(child)` when every row is a child in the legal sense | [`FJS-D657`](DECISIONS.md#fjs-d657). An `@@auth` model is one by derivation. Where erase and export walks start. Not *subject*, which is the role |
| Personal | blessed | Data | Field | a column about a person — `@personal(category?)`; the trail does not keep it | [`FJS-D657`](DECISIONS.md#fjs-d657). Not *PII*, the narrower US sense. The category is one of thirteen, closed |
| Subject | blessed | Shared | | the person something is about — a ROLE, never a kind of model | [`FJS-D657`](DECISIONS.md#fjs-d657). The claim grammar's `<subject>` column (`FJS-D359`), `membershipClaim({ subject })`, support mode (`FJS-D574`), a bearer link (`FJS-D342`), oracle's link actor. A mail `subject` is unrelated |
| Sensitivity | refused | Data | Personal | a category of `@personal` | [`FJS-D657`](DECISIONS.md#fjs-d657). A graded ladder whose levels no consumer interprets |
| Adversary | blessed | Shared | | one named class of attacker, a row key in `THREATS.md` | [`FJS-D656`](DECISIONS.md#fjs-d656). The operator is a trusted row |
| Promise | blessed | Shared | Boundary | what holds on the far side of a boundary whatever an adversary sends; it cites the ruling that holds it | [`FJS-D656`](DECISIONS.md#fjs-d656). Not a Commitment, which is a schema-level obligation on a row |
| Fault | blessed | API | | a classified failure — a kind from `FAULT_KINDS`, with `retryable` and `indeterminate` derived from it | [`FJS-D655`](DECISIONS.md#fjs-d655), building `FJS-D201`. Whoever sees the failure classifies it. Every layer that may try again reads it |
| Dead | blessed | API | Fault | the state of a durable retrier's row once it has given up; `retry(id)` is the way back | [`FJS-D655`](DECISIONS.md#fjs-d655). Caravan and webhooks store it. The outbox derives it from `attempts`. Webhooks' `failed` is an attempt that will be retried, not a terminal state |
| Peer | blessed | Data | Principal | an FJS app whose calls another FJS app grades as that app — a principal of its own, not a borrowed person; *peering* is the relationship between two | [`FJS-D1188`](DECISIONS.md#fjs-d1188). Proposed, not built (`IDEAS/app-peering.md`). Not *network*: reachability is an overlay's, and trust never comes from it. Not *federation*: the caller is the app, not its users relayed |
| Backup destination | blessed | Operations | | a bucket an archive is sent to — basecamp's `BackupDestination`: an address (`endpoint`, `region`, `bucket`, `prefix`) whose key is a `Secret` the row points at and never carries; null on a `Backup` or on `HubConfig` means the local disk | [`FJS-D1488`](DECISIONS.md#fjs-d1488), [`FJS-D1491`](DECISIONS.md#fjs-d1491) (workspace-owned, because its key is a Secret and a Secret has a workspace). Registered as the Conduit target `storage:s3:<id>` by `providers/storage/` (`FJS-D1490`). Velero's *backup storage location* and Coolify's *S3 storage* are the ecosystem's names; *destination* is the row's own column name on `Backup` |
| Harbor | blessed | UI | Surface | jetty's service worker — `src/harbor/index.js`, `defineHarbor`. It holds the Junction connection and the token, and every Dock, Pier and Island call relays through it | [`FJS-D1245`](DECISIONS.md#fjs-d1245). More than the platform's *background*: `harborApp()` is the handle `createResource` takes, and sign-in is Harbor's because the token is |
| Dock | blessed | UI | Surface | jetty's popup — the page the toolbar button opens, `src/dock/`, `defineDock` | [`FJS-D1245`](DECISIONS.md#fjs-d1245). The manifest's `action.default_popup` |
| Pier | blessed | UI | Surface | a jetty extension page with no manifest key — `src/piers/<name>/`, `definePier`, opened with `openPier(id)` in a tab or a window | [`FJS-D1245`](DECISIONS.md#fjs-d1245). The platform's *unlisted page*. Options keeps the platform's word and is not a Pier |
| Island | blessed | UI | | never bare: *a Sierra island* (a `client:*` component in a prerendered static page, the only JavaScript it runs) or *a jetty island* (a content script — `src/islands/<name>.js`, `defineIsland` — mounted in a shadow root on another site's page) | [`FJS-D1245`](DECISIONS.md#fjs-d1245). The same idea — a live part inside a page you did not otherwise run — and no shared mechanism. Sierra's travels in `mesa-island` comment markers; jetty's is registered by Harbor and built in lib mode |
| Node | blessed | Automation | | never bare: *a flow node* (one step of an orion Flow — `NodeDefinition`, `src/engine/nodes/`, run by the executor with retry, timeout and cache) or *a DOM node* (what mesa's compiled output creates, and the tree its runtime mounts and tears down) | The two share a graph shape and nothing else — a flow node never touches the DOM and mesa knows no Flow. Junction's third use, the browser client's one copy of a row, is an Entry, not a node |
| Frame | blessed | API | | never bare: *a wire frame* — one message on the WebSocket (`WSMessage`: `type`, `event`, `data`, `id`, `channel`), and one chunk of a streaming method's answer, which a transport without streaming buffers into one ordinary Envelope ([`FJS-D853`](DECISIONS.md#fjs-d853)) | Not the Frame tier, which is UI's application shell and keeps its qualifier, and not a stack frame (mesa's component stack is a stack of components). A broadcast frame is graded per recipient before it leaves; `wsSend()` is the one owner of a frame going out |
