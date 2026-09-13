---
id: intent-recognizer
status: partial
dated: 2026-09-12
---

# Idea — the intent recognizer: a customer's words, resolved against the app's own seed

**Status: PARTIAL.** Dated 2026-09-12. **The resolver is built**: the candidate
shape, the index and the verdicts are `packages/cli/core/intent.js`, and `fli intent`
prints one — no model runs anywhere. Not built: the translator in front of it, the
phraser behind it, and a screen index. § *Home* says where each would go. Do not cite this file as describing
behavior — see `VERIFYING.md`. The nine questions were answered before the first
edit and are § *The nine*, below.

**Run 3 has been made and it priced the agent** (`intent-recognizer-run-3.md`) — run
2's fifteen asks answered by a grounded agent on three models, graded blind against
the code. Opus 5 wrote fifteen sendable replies with no false claim; Sonnet 5 six,
with five misleading; Haiku 4.5 none, with three misleading. **The agent is a
frontier-model job, and the check does not rescue a cheaper one**: none of the false
claims was about something the seed declares, so the check this record keeps would
have passed every one. It also filed eight defects in `example`. The next
measurement is a lean harness pricing Opus per ask; as run it was about $1.14, and
an estimate without the harness's overhead is about $0.59.

**Run 2 has been made and it turned the record** (`intent-recognizer-run-2.md`) — a
hundred messages through the built resolver against a blind key. Words alone answered
18% once a miss stopped counting as an absence; a translator picking off the index's
own menu, 43%; and a right verdict made a sendable reply three times in fifteen. **A
candidate may now carry `pick`** — one id off `menu(index)`, refused otherwise — which
amends *a candidate names nothing* below. **Recognition is a model's job and a verdict
is triage.** What the resolver is still for is a check on a model's draft, and the
next measurement is an agent grounded in the app, graded on whether every claim it
makes is true.

**Run 1 has been made and amended this record** — sixty synthetic requests against
`example`, resolved by hand (`intent-recognizer-run-1.md`). Committed artefacts
alone answered 31; with the UI realm indexed, 45. Seventy-two percent never
reached the Data realm. The verdicts grew from four to six, the Data rung split in
two, and the subtype question closed.

A person who uses an app asks two kinds of question and has nowhere good to put
either. *Does X work like this?* — which is a fact about the app, already true or
already false. And *can we add a big red button that does Y?* — which is a request,
and which arrives in whatever words that person has.

**Both reduce to one operation: take prose, and find where the fact it contains
already lives.** If it lives somewhere, the answer is a citation. If it lives
nowhere, the answer is a ticket, and the shape of the fact is the estimate.

**What is recognized is the INTENT, not the request.** The request is the input — the
words a person typed. The intent is what they resolve to: a realm, a shape, a target
that exists or does not, and a verdict. Most inputs are not requests at all (a
question, an incident, something already built), which is why this record was renamed
from *request recognizer*. It is `PHILOSOPHY.md` § V's test — *shorten the path from a
stated intent to a running truth* — pointed at the person who does not know the model
names.

**Not the chatbot sense of the word.** Intent recognition in Dialogflow or Rasa is a
hand-written list of intents with slots. Here nothing is hand-written: the set of
things a person can mean is derived from the seed and the registers, so a model added
to the schema is a target the next question can resolve to. And `example`'s payment
*intents* are a vendor's noun, unrelated.

## The principles

Two kinds, and they are not one ranked list. **The first three hold at every step**
and a verdict that breaks one is wrong whatever else it got right. **The rest are the
pipeline, in order**, and each names the section below that carries it.

**Always true:**

| Rule | Why | Where |
| --- | --- | --- |
| **The model never decides truth.** It never picks the target; it may only read the prose attached to the target the lookup found | a candidate carrying an identifier is a hallucinated fact; a `///` paragraph on a found node is bounded reading | § *The shape*, § *The index already exists* |
| **A wrong answer is worse than no answer.** Prefer `unhomed` to a confident guess | run 1's one wrong verdict read as a clean refusal and nothing said so | § *Where the lookup is thin*, § *The nine* 9 |
| **Never promise.** No hours; `needs us` is unapproved until a person approves it | a verdict shown to a customer is the cost being priced | § *What this is and is not* |

**In order:**

| # | Step | Where |
| --- | --- | --- |
| 1 | **Find existing truth first** — the seed and the registers before anything is generated | § *The index already exists* |
| 2 | **Resolve to a canonical target** — words become an identifier through `/inflect`, never through the model | § *The shape* |
| 3 | **Separate an incident from a request** — a wrong row is routed, not designed | § *Six verdicts* |
| 4 | **Separate a UI gap from a capability gap** — the data may already exist with only a screen missing | § *Classification* |
| 5 | **Classify the change by dependency depth** — UI, API, a Data declaration, a migration | § *Cost is the deepest realm the request reaches* |
| 6 | **Explain an intentional no** — the citation and the supported path | § *Six verdicts* |
| 7 | **Correct a wrong assumption** — with the line that contradicts it | § *Six verdicts* |
| 8 | **Dedupe by resolved identity** — never by the text | § *Dedupe by resolved target* |
| 9 | **Turn unresolved demand into modeling feedback** — the model that attracts the most misses is the one modeled wrong | § *Read it backwards* |

---

## The shape

```
prose ──[LLM: translate, name nothing]──▶ structured candidate
                                              │
                                    ┌─────────▼─────────┐
                                    │  resolver (pure)  │
                                    └─────────┬─────────┘
                                              │ verdict + citation
structured verdict ──[LLM: phrase it]──▶ a sentence a person reads
```

**A model sits at each boundary and nothing decides in the middle.** The first call
translates unclear words into a structured candidate. The second renders a verdict
into a sentence. Everything between them is a lookup over artefacts this repo
already commits, which is what makes the same request answer the same way twice.

**The input model may not name anything.** It emits words and a pointer —
`{ words: ['preferred contact time'], about: 'customer', kind: 'property' }` — never
`Customer.preferredContactTime`. The moment it emits an identifier it has invented a
fact, and the resolver is grading a hallucination instead of an utterance. Naming is
`@frontierjs/toolbelt/inflect`'s job and inflect is a lookup. The boundary enforces
this rather than trusting it: a candidate carrying an identifier the resolver did not
produce is refused.

## Two moments, one recognizer

Oracle recognizes nouns from prose when no seed exists yet (`oracle-reasoning.md`).
This record is the same operation at the other end of an app's life.

| Moment | Input | What it resolves against |
| --- | --- | --- |
| **Birth** | a brief, a discovery call | the catalog — 32 canonical entities, 36 patterns |
| **Life** | a request from somebody using the app | **the app's own seed and registers** |

**The life moment is the cheap half and it does not reopen `FJS-D14`.** Oracle's
catalog is what a birth-moment recognizer needs because there is nothing else to
compare against. A running app has something better: a machine-readable statement of
what is true, regenerated and gated. The life moment needs no catalog at all, so
nothing here waits on Oracle leaving V2.

## The index already exists

This is the reason to consider building it now rather than the reason it would be
nice. Every comparable product's first six months is building a knowledge base and
keeping it fresh. An FJS app publishes one and CI fails a stale one.

| Realm | What the resolver reads |
| --- | --- |
| Data | `db/schema.lite`, `access.snapshot.md`, `jsonschema.snapshot.md`, `ddl.snapshot.sql` |
| API | the five registers `describeAppModel` composes — surface, principal, jobs, notifications, errors (`fli app:atlas`, `FJS-D240`) |
| UI | the route table, `src/resources/`, `@label`, registered displays |

**No retrieval, no embedding index, no ingestion step, and no drift**, because the
`snapshots` CI phase reruns each generator with `--check`. What a competitor
approximates with similarity search over documentation is here an exact read of a
file that cannot disagree with the code without failing a build.

**The seed's `///` prose is part of the index, and it is the part a model reads.**
Run 1 leaned on a doc comment for about five of its 31 lookup answers — *staff see
it* on `Product.active`, *a rule about lines would be a different feature* on
`DiscountKind`. Retrieval stays exact: the lookup finds the node, and interpreting
the paragraph attached to that one node is bounded work for the output model. What
it costs is honesty about a weaker seed — structure alone answered about 26 of 60,
and a client schema with no prose is nearer that number than to 31.

**The UI row is the thin one, measured.** Fourteen of sixty requests needed a
`.mesa` file read because nothing indexes what a screen shows, and it is the
difference between 31 answered and 45.

## Classification: realm first, shape second

Placing the fact in a realm before describing it is `oracle-reasoning.md` rule 3, and
it is what stops the taxonomy from being a data-modeling list applied to requests
that have nothing to do with data.

**A UI gap and a capability gap are different verdicts about one request.** Five of
run 1's sixty wanted something the data already carried — a photograph per variant,
the rate on a payslip, the discount on an order — and only a screen was missing.
Classifying those as Data would price a column that exists; classifying them as UI
without saying the data is there hides the cheapest answer in the run.

| Realm | Shapes |
| --- | --- |
| **UI** | placement · an affordance · wording · a column on a list · a filter · a display or format · navigation · an empty state |
| **API** | a service method · a hook · a job or cron · a threshold or routing rule · a transition guard · an integration target · a notification · an export |
| **Data** | the twelve below |
| **none** | already true · a setting · an `@@extensible` slot · a permission |

The Data shapes are classical entity-relationship modeling, and the vocabulary is
Richard Barker's. Ten of the twelve are already expressible in `.lite`:

| Shape | Where it lives |
| --- | --- |
| entity vs. attribute | `model` vs. field — and Oracle's first rung is this question |
| subtype vs. supertype | **nothing in the language**; `polymorphic-relations.md`, proposed |
| optional vs. mandatory | `?`, and `@required(where:)` |
| cardinality | relations |
| many-to-many | a mutual `Model[]` pair generates the join table |
| association / intersection entity | `modeling.md` § *a Json array of ids, or a join table?* — a join nothing addresses by id takes the free one |
| recursive relationships | self-relation, `recursive: { direction, via, maxDepth }` |
| foreign-key inheritance | `@@id([a, b])`, `@@tenant(via:)` inference |
| exclusive arcs | `@@arc`, exercised by `example`: `verify:collect` |
| logical → physical | `schema.lite` → `ddl.snapshot.sql`, and `litestone import` runs it backwards with every construct graded `changed` / `lost` / `noted` |
| naming conventions | Invariant 2, `/inflect`'s three axes, `fli check` |
| reusable patterns | `trait` + `@@trait` in the language; Oracle's catalog one tier up |

**The classification is the estimate.** Each shape has a different lookup and a
different cost, so nothing is asked to judge difficulty:

| Classified as | Cost |
| --- | --- |
| new optional attribute | one schema line |
| mandatory attribute over existing rows | a line and a backfill |
| cardinality change | a migration and every screen that reads the relation |
| really an intersection entity | a model and a service |
| an exclusive arc that already exists | one line |

## Cost is the deepest realm the request reaches

```
UI only            → one .mesa, one drive, no migration
API                → a method and its tests, no migration
Data, declaration  → one line that moves no column: an edge, a view, @from, @@export, @@createdBy
Data, migration    → a migration, a deploy, a moved access snapshot, and everything downstream
```

**Data is two rungs, not one.** Run 1 priced seventeen requests as Data and five of
them were a single declaration that emits no column change — a missing transition
edge, a `view`, a `@from` sum. Pricing those as a migration overstates a third of
the realm, and *which* declarations move a column is itself a lookup: the release
classifier (`litestone release`) already grades a schema change as an expand or a
contract.

**This is read off the dependency chain rather than estimated**, and `fli proves`
turns realm and shape into the drive that would prove the change, so a ticket leaves
with its proof target attached.

**Most requests decompose into several facts, and the decomposition is the estimate.**
*Add a big red button that cancels an order* is four:

| Fact | Realm | Lookup |
| --- | --- | --- |
| a button, top of the order screen | UI | the route table |
| something must cancel | API | `surface.snapshot.md` — does `orders.cancel` exist? |
| is `shipped → cancelled` a legal move? | Data | `@@transitions` |
| who may make it? | Data | the move's `@gate` |

An answer with five novel elements has failed the test five times
(`oracle-reasoning.md` rule 1). The deepest realm any element reaches sets the class.

## Six verdicts

| Verdict | What it is | What it carries | Run 1 |
| --- | --- | --- | --- |
| **exists** | the fact is already true | a citation and a deep link | common |
| **you can do this** | an `@@extensible` slot, a row a person may create, a move a person may make | a link, and it is done without a developer | 5 |
| **declined by design** | the seed says no, and says why | the citation, and the supported path where there is one | 9 |
| **needs us** | a change, classified | realm, shape, cost class, proof target — and marked unapproved | common |
| **incident** | a live row is wrong; there is no design question | where the truth is kept, and the move that fixes it where one exists — then routed to a person | 7 |
| **unhomed** | nothing matched | the utterance, escalated to a person | 2 |

**`declined by design` is not `exists`.** Both cite a fact that is already true,
and they are opposite answers to the person reading them. A customer told *exists*
goes looking for the feature; a customer told *no, because a payslip is a document,
and this is how a correction is made* stops asking. Nine of sixty was too many to
leave inside another verdict.

**`incident` is routed, never answered.** Seven of sixty were not about the app's
design at all — a charge taken twice, a count that disagrees with the shelf. The
lookup still earned its place on five of them by saying where the truth lives, and
on two it corrected the premise outright: *holds count against what is available,
never toward what is on hand* is the answer to B2 before anybody opens the database.

**Correcting the premise is the most valuable thing a verdict carries.** Seven
requests in run 1 rested on a belief the seed contradicts, and the cheapest
resolution of each was to say so with the line that says so.

**`unhomed` is not grouped with the ones that resolved.** *Nothing matched* and *a
rule answered* are different facts and only one is evidence — the same separation
`@frontierjs/mcp` makes between `ungraded` and a verdict that cleared a number.

**The second verdict is the one nothing else can offer.** A pool declared
`@@extensible` has slots, and slots are data, so *you already have room for this* is
a lookup rather than a policy decision. The person gets the thing they asked for in
the time it takes to read the answer, inside an envelope that needs no migration and
no deploy.

## Dedupe by resolved target

Every comparable product runs similarity search over the text of requests. Resolving
first makes it an identity check: *add a notes field*, *somewhere to jot client
stuff* and *a comments box on the customer page* all resolve to `Customer.notes`, and
grouping is by that identifier.

**Exact, free to compute, and explainable to the person who filed the duplicate.**
It costs nothing extra because the resolution has already happened.

**The negative case is the one text similarity gets wrong.** Run 1 had two requests
for dark mode — one about the console, one about the storefront — which read alike
and resolve to different surfaces: `web/` has sierra's theme switch and `site/` does
not. Grouping by identifier keeps them apart, which is correct, because one is
*exists* and the other is *needs us*.

## Read it backwards

Requests resolve to targets, targets accumulate, and the reverse question is
available for free: **which model attracts the most requests that did not resolve?**

That model is the one that was modeled wrong. A request register keyed by identifier
is a measurement pointed at the seed, and nothing else here produces one.

## Where the lookup is thin

**A service method is an affordance no committed artefact grades.** Run 1's one
wrong answer: `Invoice`'s `settle` move is `@system`, so the seed says a person
cannot mark an invoice paid — and `invoices.settle` is the staff button for a
hand-reconciled bank transfer, running that move through `asSystem()`.
`surface.snapshot.md` lists the method and not who may call it. `@frontierjs/mcp`'s
`move-system` verdict reads the same two facts the same wrong way, so this is one
gap with two readers waiting on it rather than a resolver bug.

**Subtype and supertype have no expression in the language — and it did not
matter.** One request in sixty classified as a subtype (a candle-making class as a
product with a date). `polymorphic-relations.md` is not a dependency of this record.

**What a screen shows has no index, and it is the gap run 1 measured.** Fourteen
requests needed a `.mesa` file read, and **none of the fourteen was about wording**:
they asked which columns a list has, which filters and actions it offers, what a
component does, whether a control exists. `routes.snapshot.md` already maps a URL to
a file; what is missing is the file to what it renders — the resources and models it
reads, the fields and moves it shows, a widget's props.

**This record once named `lexicon.md` as that index, and run 1 disproved it.** An
interface-tier string catalog answers *change 'Submit' to 'Place order'*, which is a
real request that a synthetic set probably under-represents — but it would have
answered none of the fourteen. The two records are neighbors, not dependencies.

## What this is and is not

**The resolver is framework-shaped; the intake is an app.** The resolver reads a
seed and a set of registers and answers a question about them, which is what `fli`
already does several times over. A customer-facing conversation, a request register,
notification and approval are an application built on the framework, and `FJS-D14`
already ruled that shape for `oracle` and `orion` — an app built on FrontierJS is not
a gap in FrontierJS.

**No framework noun is coined here.** V1 is a verdict and the verdict is enough; what
the customer-facing thing is called is a decision for the app that ships it.

## Home

**Not a package.** V1 is a verdict, and a verdict is a lookup over artefacts the
repo already produces — the seed, the committed snapshots, `describeAppModel`. A
package earns a directory when its configuration, its tests and its release are all
different answers (Invariant 3's test for a surface), and a lookup has none of that.
The half that would — a model dependency, a conversation, *send to developers* — is
not designed, and a boundary drawn before it is designed is a guess.

**V1 lives beside the index, in the CLI, as a module with a command over it.** The
resolution and the verdict are one module, `packages/cli/core/intent.js`; `fli intent
--candidate <json>` is its first caller and prints what it answers. It takes a
CANDIDATE today rather than prose, because the translator is not built — and because a
resolver graded on hand-written candidates is graded alone. The same shape as
`fli proves`, which also reads committed files and answers a question about them.
**The logic is never in the command**, because the command is not the last caller: a
customer asks a running app, not a terminal, and a second surface re-deriving the
verdict is two answers to one question. The first audience is the developer. Run 2 moved the
module's job from recognizing to CHECKING: a model reads the message and the app, and
`intent.js` holds a draft's claims to the seed.

**If it becomes its own thing, it is Oracle's first piece.** The moment a customer
surface exists the module moves to it, the CLI keeps calling it, and that surface is
an app built on the framework — `packages/oracle`, under `FJS-D14`, which rules
nothing is owed there until core leaves alpha. § *Two moments* is why it belongs
there rather than beside it: Oracle is the birth moment and this is the life moment of
one recognizer. **No further name is coined** until there is a thing to name.

## What it is not

**No hours, ever.** A cost class is derived and defensible. A number of hours is a
promise made by a machine on somebody else's behalf, and the `needs us` verdict is
marked unapproved for the same reason.

## The nine

Answered against the proposal, before the first edit. The record itself is
Assessment (`PHILOSOPHY.md` § VII) and binds nothing.

1. **Another origin of truth?** No. Every answer cites a committed artefact and the
   register stores a resolved identifier plus the original utterance — never a
   restatement of what the app does.
2. **Concept budget?** Only if it mints a noun, and it does not. The split above
   keeps the framework half inside `fli`'s existing vocabulary.
3. **Whose complexity?** The problem's. Ambiguous prose is inherent; the added part
   is a finite hand-written table of realms and shapes.
4. **Predictability?** Raised. The deciding half is deterministic — one request
   resolves the same way twice — and the two model calls name nothing.
5. **Derived rather than restated?** The index, the cost class, the proof target and
   the dedupe key all derive. **The realm-and-shape table does not**, and that is the
   weak point of the design: it is hand-kept and can fall behind the language.
6. **One owner?** One resolver, several renderers — a chat, a command, a dashboard —
   which is the shape `describeAppModel` and `core/repo-atlas.js` already take. Three
   callers each growing their own resolution is the failure to refuse.
7. **Explicit boundary?** The structured candidate is the boundary and it is typed.
   Its contract is *the model names nothing*, enforced by refusing a candidate that
   contains an identifier.
8. **Failure proportional?** `exists` and `you can do this` are citation-backed and
   safe. `needs us` is an opinion and is marked as one. A verdict shown to a customer
   is the cost being priced, which is why no answer carries hours.
9. **Wrong without anything saying so?** Yes, in one place: a resolver that failed to
   look properly reports `unhomed`, which is indistinguishable from a genuinely new
   concept. **The artefact is the resolution rate** — the fraction of requests that
   resolved, tracked over time, where a drop means the index went stale or the
   classifier drifted. The second silent failure is the hand-kept shape table falling
   behind a new schema attribute, which wants a check comparing the shapes to the
   parser's own keyword list. **Run 1 found a third, and it answered wrongly rather
   than emptily**: a custom method wrapping a `@system` move reads as *nobody may*,
   because the surface register does not carry who may call a method (§ *Where the
   lookup is thin*).

**Amended after run 1, late by definition.** Two verdicts were added and the Data
rung split. Neither coins a framework noun — both are names for answers, and live in
the app that renders them. The addition that matters for question 8 is `incident`:
a verdict that routes rather than answers is the one a customer-facing surface can
least afford to get wrong, which is why it carries no estimate at all.

**Adjudication in tension: batteries vs. smallness** (`PHILOSOPHY.md` § IV). Resolved
by the split — the resolver is a battery, the intake is an app, and `FJS-D14` is the
precedent. **Familiarity vs. precision** is in tension over the words shown to a
customer: *feature request* is the ecosystem's term and is wrong for most inputs, so
the customer-facing word can be loose while the verdict stays precise.

## Open questions

- **Verdict only, or does it write?** V1 is the verdict. Whether the recognizer then
  drafts the schema line is what separates an architect from a builder, and they are
  different machines.
- ~~**What fraction never reaches Data?**~~ **72%**, synthetic (run 1): 25 of 60
  needed no change at all, 12 UI, 6 API, 17 Data — five of those a single
  declaration. A screen index moves ahead of the Data work.
- ~~**How often does a request classify as a subtype?**~~ **1 in 60.** Not a
  dependency.
- **Who may call a custom method?** The surface register names a method and not its
  grade, and run 1's one wrong answer lived there. Whether that belongs in
  `surface.snapshot.md` or in what `@frontierjs/mcp` projects is the same question
  for both readers.
- **Where does the request register live?** An app's own model, or a hosted thing one
  tier up that reads many apps' registers. The second is a product; the first is a
  weekend.

**The falsification run was set a bar before it ran**: seven in ten answered by
lookup alone keeps the shape, four in ten changes it. **Run 1 landed at 5.2 — 31 of
60 — and 7.5 with the UI realm indexed**, so the design survives on a condition, and
the condition is an index of what each screen shows (`intent-recognizer-run-1.md`).

**Run 1 was synthetic and resolved by a person who had just read the seed.** It can
disprove the design and cannot confirm it. The next run that counts is real mail
against a schema with less prose in it — `maid.tech` once it has users — and it
should be resolved by a mechanical first pass, so the number measures the resolver
rather than whoever held the pen.

## Prior art

Surveyed 2026-09-12. **Three markets exist and none of them is joined.**

**Answering** — Intercom Fin, Help Scout, Pylon, Inkeep, Quickhunt. Retrieval over
documentation. Mature, and blind to the code.

**Capturing** — [Canny](https://www.featurebase.app/blog/canny-vs-productboard),
[Featurebase](https://www.featurebase.app/blog/feature-request-tools), Productboard.
Boards, votes, and duplicate detection by text similarity. Mature.

**Building** — [Agent Smith](https://github.com/holgerleichsenring/agent-smith), which
is the closest single thing to the back half: a ticket sized into a token budget at
admission, a plan ratified before code changes, a pause when the run reaches a
decision it should not make alone. GitHub's agentic workflows are the same shape as
an Action.

**Spec-driven development** — [Kiro, GitHub Spec Kit, OpenSpec,
BMAD](https://www.marktechpost.com/2026/05/08/9-best-ai-tools-for-spec-driven-development-in-2026-kiro-bmad-gsd-and-more-compare/)
and [Tessl](https://codemyspec.com/blog/tessl-review), which raised roughly $125M on
the position that the spec is the source and code is regenerable output. **Their
specs are freeform prose and carry no catalog**, so they transcribe the noun a person
typed rather than recognizing the one that already exists. They cannot refuse.

**Ontology platforms** — [Palantir, Fabric,
Atlan](https://atlan.com/know/ai-agent/ontology/ontology-design-for-ai/). The only
family that reasons against a durable model rather than from a prompt. Integration
layers over data that already exists, enterprise-priced, and they generate no app.

**The catalog itself is forty years old and was never made executable.** Barker's
entity-relationship notation is where this record's Data shapes come from;
Silverston's *Data Model Resource Book* volumes 1–3 and Fowler's *Analysis Patterns*
are the reusable-pattern tier. Every 2026 tool above lacks exactly this content.

**Why the join is missing.** A recognizer must be able to refuse — *that is not an
entity, it is a column* — and a standalone product that tells a paying user they are
wrong loses to one that says yes. **Refusal only pays when something downstream
cashes it**: a migration nobody had to write, a gate that already covered the case, a
form that comes out for free. That is a framework, which is why the gap is where it
is.

## See also

`intent-recognizer-run-1.md` (sixty synthetic requests, resolved by hand) ·
`oracle-reasoning.md` (the birth moment, and rules 1–3 used throughout) ·
`fli app:atlas` (`FJS-D240`, the API-realm index) · `lexicon.md` (the string catalog,
a neighbor rather than the index this needs) · `polymorphic-relations.md` (the one Data shape the language cannot
express) · `tenant-declared-fields.md` (the `you can do this` verdict) ·
`packages/mcp` (`ungraded` kept apart from a verdict) · `DECISIONS.md` `FJS-D14`
(an app built on the framework is not a gap in it)
