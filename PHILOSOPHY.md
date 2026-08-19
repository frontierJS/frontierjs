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
test suite is a fact.

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

**Ergonomics vs. strictness.** Strictness follows cost — never resolve this
by temperament ("we're strict" / "we're friendly"); resolve it per-surface
by what a mistake destroys.

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
- Does it reduce predictability?
- Can it be derived instead of restated?
- Does it have exactly one owner?
- Is the boundary explicit — named, typed, tested?
- Is the failure mode proportional to the cost of being wrong?
- Can this be wrong without anything saying so — and if it can, what artefact
  makes it visible?

If it belongs, every answer above will show it.

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

## VII. Coda

Restatement is the disease; one origin is the cure. A schema file is called
a seed because it is small, complete, and utterly committed — everything
downstream is unpacked from it, and nothing is legitimate unless it traces
back. The framework's job is to be soil. The developer's job is to state
what's true.

If a decision shortens that path without making the system harder to
predict, it belongs. If not, it doesn't — however clever it is.