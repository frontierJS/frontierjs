# The FrontierJS Philosophy

---

## I. The core claim

Most of a web application is restatement — the same fact, written five
times in five dialects: an ORM schema, a validation library, a TypeScript
interface, an access-control middleware, an API document. Every restatement
is a place for the versions to disagree, and they always, eventually,
disagree. Drift isn't an accident; it's the compound interest on every
truth stated twice.

FrontierJS is a bet against restatement — one declaration, many
realizations. The reason that bet pays off isn't just correctness:

> **Every duplicated truth eventually becomes a duplicated mental model.**

A developer facing five copies of the same fact doesn't just risk them
disagreeing — they have to hold five pictures of the same thing in their
head at once, and guess which one is authoritative. Protect the truth and
you protect the mind trying to hold it. Everything below is a consequence
of taking that seriously.

---

## II. The three axioms

Three commitments generate the rest of the framework. The first is about
what's true. The other two are that same discipline, applied to the person
trying to hold it in their head — nothing here is independent of them.

### 1. One origin
Every fact has exactly one authoritative declaration. Everything else is
derived.

### 2. One name
Every concept has exactly one name. Vocabulary exists to reduce cognitive
load, not to describe the system after the fact.

### 3. One owner
Every capability has exactly one owner. Boundaries are enforced, not
documented.

---

## III. Implications

*(Each of the following is a consequence of the axioms above, not a fourth
philosophy.)*

### Declaration is a contract
*— from Axiom 1*

If a declaration exists, it binds: enforced from the first request, against
a shipped default, with no further wiring. If it doesn't exist, nothing is
implied — a model without a gate is open, honestly. The framework never
activates machinery no declaration asked for.

### Everything is a projection
*— from Axiom 1*

Database. API. Client types. Forms. Events. All generated views of the same
declaration, not separate truths that happen to agree. The moment one of
them is hand-maintained instead of generated, it has stopped being a
projection and become a second origin in disguise.

Finding two origins is a diagnosis, and the work after it is deciding which
side can become a projection of the other. Where neither can, the fact has no
home yet, and that is the finding.

### A projection must be legible
*— from Axiom 1*

A fact the framework derives and nobody can read is a fact that has already
started drifting. Correctness that cannot be seen is indistinguishable from luck
— it holds until something quietly stops holding it, and the first report is a
user. So a derived fact earns a reader: a committed artefact, a diff, a report
someone reviews. Where that reader is absent, the corollary follows and it is
the sharper half — **a check that can only fail open is not a check.** A rule
that catches an extra and can never catch a missing one is not strict, it is
decorative.

### Predictability
*— from Axioms 2 and 3*

You should know where something lives before you go looking for it. If you
know the three nouns, you should know which package owns a feature and who
to ask — without documentation.

### Boundaries
*— from Axiom 3*

A realm reaches another realm through a named checkpoint — a hook, a
bridge, a typed contract — never by convention. Architecture written in
prose is a wish; architecture written into the dependency graph and the
test suite is a fact. Unclear ownership is the same diagnosis from the other
side: where two places each half-own a capability, what is missing is the
checkpoint between them rather than a rule about who defers.

### Concept economy
*— from Axiom 2*

A new concept costs more than a new feature; reuse the vocabulary you have
before minting a word for a fourth noun. A dependency counts against the
same budget as a concept — each is a page of someone else's mental model
taxed against your own.

### Errors teach
*— from Predictability*

Strictness follows the cost of being wrong: warn when a mistake produces a
wrong answer, refuse when it produces a mis-scoped destructive operation.
Every refusal names the field, lists the options, suggests the fix —
because an error is the framework explaining its own model at the exact
moment someone is listening hardest.

---

## IV. Standing adjudications

**Preservation vs. evolution.** Compatibility is owed to users, never to code.
A spelling that already exists is not a reason to keep it; the reason is
somebody depending on it. Where nobody does, a rename is a rename — no alias,
no deprecation, no migration path, no second name for one thing — because the
cost of carrying the old spelling is paid forever by everyone who then reads two
names for one idea. Where somebody does, the break is announced and the
adjudication below governs how. **Which of those two a project is standing in is
a fact about the project**, recorded in its map and never argued from here.

**Ergonomics vs. strictness.** Strictness follows cost — never resolve this
by temperament ("we're strict" / "we're friendly"); resolve it per-surface
by what a mistake destroys.

**Paved road vs. the workaround.** One blessed path, made excellent, taken
without a second thought — and the escape hatch is instrumentation as much as
relief. One developer leaving the road is an edge case; the same workaround in
the same place, over and over, is a measurement of the road. A config flag
added in answer widens the shoulder and records nothing: either the road
changes, or the reason it does not is written down.

**Batteries vs. smallness.** The core stays readable; the batteries stay
owned. A battery may be large, but it must be *severable* — one owner, one
seam, removable without surgery on the core. A battery that grows tendrils
into the core has become the core, and must be admitted as such or cut
back.

**Familiarity vs. precision.** Steal proven shapes from the ecosystem;
reject their words when the words half-fit. When ecosystem muscle memory
collides with a deliberate difference, fail the muscle memory *loudly and
helpfully* — name the equivalent — rather than silently accepting input the
system will ignore.

**Coherence vs. convention.** This framework is one mind's coherent design,
and that coherence is its advantage — but coherence only transfers through
vocabulary, documents, and enforcement. A rule that lives only in the
author's head is already broken for everyone else. Write it down or lose
it.

**Doctrine vs. discovery.** Sometimes the code is smarter than the
principle. When code and doctrine disagree, don't automatically side with
the doctrine. Hold a hearing. Then either fix the code or amend the
doctrine — in writing.

---

## V. Frontier decision rules

Every proposal reduces to one test: does this shorten the path from a
stated intent to a running truth, without making the world harder to
predict? In review, that breaks down into:

- Does it introduce another origin of truth?
- Does it enlarge the concept budget?
- Is the complexity the problem's, or did we add it?
- Does it reduce predictability?
- Can it be derived instead of restated?
- Does it have exactly one owner?
- Is the boundary explicit — named, typed, tested?
- Is the failure mode proportional to the cost of being wrong?
- Can this be wrong without anything saying so — and if it can, what artefact
  makes it visible?

If it belongs, every answer above will show it. Where two proposals both
pass, the tiebreak is six months out: the one that lets a developer predict
more from less knowledge.

---

## VI. What FrontierJS is not

- **Not a platform.** Your application remains a file tree, a binary, and a
  database you own.
- **Not vocabulary-neutral.** The framework defines its own language and
  enforces it.
- **Not infinitely configurable.** One blessed path, plus an escape hatch.
- **Not a wrapper.** It commits instead of abstracting over every backend.
- **Not dependent on its author.** The written doctrine outlives any
  individual.

---

## VII. How the documents govern

*(Axiom 1 pointed at the prose. `VERIFYING.md` records why: every hand-maintained
restatement drifted, and the documents drifted most.)*

**Every document is one of four kinds, and the kind decides what a sentence may
say.**

- **Guiding** — `PHILOSOPHY.md`, `ARCHITECT.md`, the Invariants. Principles and
  vocabulary. No counts, no dates, no maturity words, no defect ids — a ruling
  may be cited, since it is what settles a principle; a defect is what the
  principle is not yet true about, and belongs in the register. A principle
  is true on the day it is written and on the day the code catches up; a number
  is true for an afternoon.
- **Register** — `DECISIONS.md`, `ISSUES.md`, `CHANGES.md`. Dated, cited,
  append-only. History lives here and nowhere else.
- **Map** — the root and package `CLAUDE.md`, a package `README.md`, the committed
  snapshots. Live facts, each one backed by a generator or a check that fails when
  it stops being true. A README is here rather than one tier down because a
  consumer acts on it without reading anything else.
  A map sentence beginning *until*, *used to*, *before FJS-* is history that
  escaped its register.
- **Assessment** — `IDEAS/` (`pros-and-cons.md` among them), a package's design notes. Carries
  a `status` and a date in its frontmatter and is never cited as behavior.

**Precedence is stated once.** Invariant, then ruling, then map, then package
document, then assessment. A ruling that must override an invariant amends the
invariant in the same commit or does not land. Where two documents of one kind
disagree, the one with the later date wins and the earlier is struck in place.

**Status is a closed vocabulary, and what carries it differs by kind.** A ruling
in force says nothing: being in the register is the statement that it was
decided, so a word is written only where that has stopped being the whole answer
— `superseded-by`, `amended-by` or `withdrawn`, under the heading, naming what
replaced it (`FJS-D196`). A proposal is on a lifecycle and carries one word in
its frontmatter: `proposed`, `partial`, `shipped`, `superseded-by` or
`withdrawn` — the two build states between a decision and a fact, which a ruling
does not need and a roadmap cannot do without. A document that READS the tree
rather than proposing anything is `assessment`: it is on no lifecycle, it carries
a date, and it is never cited as behavior. A file derived from the others and
authoritative over none of them is `index`. *Parked*, *under review*, *not yet
adopted*, *argued* and *idea* each meant one of these, and each let a settled
question read as open. *Accepted* is retired for the opposite reason: it was true
of nearly every ruling, and a word that is almost always the same word cannot
mark the one that is not.

**A number in prose is generated or absent.** Components, tests, rules, models,
drives. A count that nothing regenerates is wrong by the next commit and reads as
authoritative until then.

**The delete test, for the sentence that is in the right kind of file and may
still not belong**: if it vanished, could someone acting on this file make a
mistake it would have prevented? *A `@@gate` refuses, a `@@allow` filters, so a
wrong policy is an empty screen and not an error* stays — the mistake is
concrete and the sentence is the only thing between a reader and it. *The kit
ships seventy components over the design system* goes — nobody does anything
differently for knowing it, and it was 65 the week before. The test is asked per
sentence and answered out loud, and a cut with no answer does not happen.

---

## VIII. Coda

Restatement is the disease; one origin is the cure. A schema file is called
a seed because it is small, complete, and utterly committed — everything
downstream is unpacked from it, and nothing is legitimate unless it traces
back. The framework's job is to be soil. The developer's job is to state
what's true.

If a decision shortens that path without making the system harder to
predict, it belongs. If not, it doesn't — however clever it is.