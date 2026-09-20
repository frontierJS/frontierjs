---
id: lexicon
status: partial
dated: 2026-09-20
---

# Idea — `lexicon`: the half of i18n the ruling did not reach

**Status: PARTIAL. Two of the four statements below are ruled; nothing is built.** `FJS-D12` ruled i18n on 2026-08-15 —
English for alpha, six constraints holding the seam open, the build deferred to
V2 — and that ruling is not restated here. What this file carries is the delta:
the ruling addresses strings the SCHEMA derives, and says nothing about strings a
person types into a `.mesa` file, which is most of them.

## The half that was not covered

`FJS-D12`'s deferral is safe because every schema-derived string is addressable:
`@label` is a default and the address is `Model.field.label`, so the catalog is
generated rather than excavated. That argument holds exactly as far as the schema
reaches.

It does not reach `Add to basket`, `No orders yet`, `Your session ended`, or the
sentence with a `<Link>` in the middle of it. Those are authored in `.mesa` and
have no address at all. Drupal's three-way split — interface, configuration,
content — is cited in the ruling as the shape; constraint 3 separates
configuration from content, and **the interface tier is the one nothing was said
about**.

The cost of leaving it unstated is asymmetric, which is the whole argument for
writing anything down now. An unmarked string costs nothing while the app is
English. A sentence assembled from pieces cannot be translated at all, and the
day that is discovered is the day a catalog arrives — a year of call sites later.

## What fbtee is worth taking

[fbtee](https://fbtee.dev) is Facebook's `fbt` rebuilt for TypeScript, ESM and
Oxc — a decade of production behind the model. Six things in it answer questions
this repo has not asked yet.

**The source string is the address; no key is ever authored.** fbtee hashes the
text together with a mandatory description. This is `FJS-D12` constraint 1's
argument — derive the address, never author it — applied to the tier the ruling
did not reach, and it means the interface tier needs no new syntax in `.lite`
either.

**A description is mandatory, and that is the cheapest thing here.** A string with
no translator context is untranslatable, and the absence is invisible until
somebody is being paid to translate it. English-only it costs an author one
attribute and buys the register a column.

**A sentence is never assembled.** A component nested inside a marked string
becomes an implicit parameter, so `You have <Link>3 orders</Link> pending` stays
ONE unit rather than three fragments a translator cannot reorder. Every `t()`
library gets this wrong and the damage is unrecoverable — word order is not the
same in every language, so a concatenation is a sentence that can only ever be
English.

**Grammar is declared rather than concatenated** — plural, enum, list, pronoun.
Two land on things this repo already owns: `list` is `Intl.ListFormat`, which is
constraint 6's single formatting owner arriving with something to own; and `enum`
is a fixed set of translatable values, which is what a litestone `valueset`
already is — declared, ordered, and already crossing from the browser to the Data
boundary.

**The middle CLI verb is the gem.** Three verbs — collect, prepare-translations,
translate — and the middle one preserves existing translations and marks new
entries `"status": "new"`. That marking is the same instinct as `litestone
import`'s `changed` / `lost` / `noted`: the tool states what it could not carry,
on the line where it could not carry it. `FJS-D12` reserves a seed-derived
`strings.snapshot.md`; this says the snapshot should carry a status per row, or
*a new string* and *a string nobody has translated* read identically.

**One intermediate representation feeds both extraction and runtime.** The
extractor and the renderer cannot then disagree about what a string is — Axiom 1,
in a place it is easy to end up with two parsers. It is also where the bundle win
comes from, and per-locale prerender on the `static` target is a loop sierra
already runs.

## The browser is not the question — the recipient is

**`Intl` is a runtime API rather than a browser one, and the two runtimes agree on
every answer that matters.** Measured 2026-09-20 against Bun 1.3.11 and Node
22.21: full ICU on both, `pl` resolving `one, few, many, other` and `ar` six
categories, `de-DE` formatting JPY with no decimal places, `sv` collating
`a z ä`, `ja` segmenting words, and an unknown locale falling back to `en-US`. So
there is no separate server tier to design, and a layer diagram naming its bottom
layer *browser Intl* is drawing a boundary that is not there. A prerender pass, a
notification formatter and an `email-kit` render reach the same API the page does.

What is there instead is the split the whole design turns on. **A page has one
locale; an email has one per recipient.** A notification job renders ten messages
for ten people in one loop, so the locale cannot be ambient — not a signal, not a
context, not a module-level `setLocale()`. It is an ARGUMENT, and the renderer is
a factory that takes it: `createLexicon({ locale, catalog })`, which is
`createDatetime({ timeZone, now })`'s shape and exists for the same reason — the
kit holds no clock and no locale, so a caller holding one can hold ten. Sierra
then keeps one instance per page and a mail job one per recipient, and
`page.locale` is a convenience over the argument rather than the mechanism. Built
ambient-first, the email tier cannot be added afterwards without changing every
signature.

**Three runtime traps, each owed an artefact rather than a paragraph.**

- **`Intl.DurationFormat` is Bun-only**, absent from Node 22. Jetty's suite is
  plain node, sierra, mesa and email-kit run vitest on node, and every
  `scripts/*.mjs` is plain node — so a kit reaching for it compiles clean and dies
  in half the suites. The allowed surface is named and asserted in both runtimes,
  never *all of `Intl`*.
- **`supportedValuesOf` differs by runtime** — 306 currencies on Bun against 162
  on Node, 445 time zones against 418. A validity verdict read off the host is a
  code refused on one runtime and accepted on the other. `toolbelt/units` already
  ships ISO 4217 rather than asking, which is the pattern to copy;
  `declared-semantics.md` and `time-and-recurrence.md` both propose refusing
  against the host list and inherit this.
- **`pluralCategories` is a set, not a sequence** — Bun answers
  `one, few, many, other` for `pl` and Node `few, many, one, other`. A catalog
  validator or a snapshot comparing the joined string passes on one runtime and
  fails on the other.

## `lexicon` is a codename, never a package

`FJS-D12` reserved it as a package for V2. **It is not one and will not be.** The
four owners below are the argument: syntax is mesa's, `Intl` is a toolbelt kit's,
the active locale is sierra's, and the words are the app's — which leaves a
package nothing to own. The word stays as the name of the WORK, the way
`IDEAS/package-map.md` already lists it, so that *lexicon* names a topic in a
conversation and never an install.

## Four owners, not one word

A proposal that says *the framework* owns i18n cannot be built, because two of
the four pieces cannot live where the word points. Mesa owns the `.mesa` compiler
and runtime and is the leaf; a locale store cannot live in toolbelt, where
`FJS-D111` already ruled state out.

| What | Owner | Why there |
| ---- | ----- | --------- |
| the marking, rich-text units, declared grammar | **mesa** | it is language syntax, and the compiler is the only thing holding the AST |
| plural categories, number, date, money, list, collation | a **toolbelt** kit | pure and zero-dep, reached from both realms with no import license to invent |
| active locale, negotiation, routing, catalog loading, per-locale prerender | **sierra** | it owns the theme switch for these same reasons |
| the words | the app's catalog | — |

**Formatting already has its owners, and they are not new syntax.** `FJS-D12`
constraint 6 reserved one owner for the day formatting arrived; it arrived as
`toolbelt/units` (`roundMinor`, `allocate`, shipped ISO 4217) and
`toolbelt/datetime` (`createDatetime({ timeZone, now })`), which is why `Intl`
appears in exactly three files today. A call-site formatting filter would breach
that constraint rather than serve it — and currency is the proof, since the code
comes off the row and not off the locale, so a filter taking only a locale has
nowhere to say JPY and formats money wrong in the one place wrong is expensive.

## What is not worth taking

**The `fbt` spelling.** Ecosystem muscle memory is worth failing loudly here
rather than importing: `fbt` is an initialism for a company that is not this one.
Mesa already has a namespace with a closed vocabulary and an unknown name is an
error, so the shape has a home and the word does not.

**Pronoun and gender.** They need a gender value on a row, which is content —
constraint 3's line, and a different mechanism.

**The React locale context.** Sierra owns the theme switch for the same reasons
it would own this one, and `db.$setLocale()` is already reserved as the Data-side
flavor.

**A second mechanism beside `@label`.** Whatever the interface tier ends up
being, it is not `@label` with a second argument and it is not `@label` at all.
Two ways to say one thing is the failure this whole file is trying to avoid.

**Translate-by-default** — *largely reversed by § The switch below, which is the
later argument and wins; what survives of this is the reason the reversal needs a
committed, reviewable artifact to stand on.* Marking every text node and opting out
per exception inverts the cost: a brand name, an identifier, a URL or a user-generated string
leaks into the catalog by omission, and nothing says so while the app is English.
It also leaves the description nowhere to live, which loses the cheapest thing in
this file. Marking is explicit; *ergonomics vs. strictness* resolves per-surface
by what a mistake destroys, and here it destroys the translator's only context.

**A second attribute namespace.** An `i18n-*` prefix is Angular's habit arriving
with a spelling. Mesa already has a namespace with a closed vocabulary where an
unknown name is an error, so the shape has a home and the prefix does not — the
same adjudication that rejects `fbt` above, one layer out.

**A formatting filter at the call site** — `{price | currency}`, `{createdAt |
date}`. Three separate refusals: it is a new Mesa expression feature bought for
i18n alone, it is a second owner for formatting that already has one, and it
gets money wrong because a locale cannot name a currency.

**A reactive locale switch.** Making every text node a derivation so a signal can
flip the language is the costliest unexamined promise available here: mesa settles
derivations outside-in by DOM depth, prerendered HTML and islands cannot
re-render, and the compiled-string bundle win disappears. A locale change is a
NAVIGATION, which per-locale prerender already makes cheap.

## The switch, and the generator that primes it

**i18n is off by default and one switch turns it on.** Off, an app owes nothing:
no marking, no catalog, no runtime, no bytes. That keeps the whole of `FJS-D12`'s
shape — the seam reserved rather than built — and it is what makes the feature
adoptable at all.

**One rule lives outside the switch, and it is constraint 7.** A sentence
assembled from pieces is the one failure a switch cannot rescue, because the
damage is a thousand call sites written before anybody flipped it. So *no
assembled sentence* grades with i18n off; everything else waits for the switch.

### The generator does three jobs, and the first two were the blockers

The expensive half of i18n has always been human labor, and a model does three
parts of it. **Marking** — which strings are user-facing — is what
translate-by-default was attempting with a heuristic, and a model is better at it
than a heuristic can be: it knows a brand name from a button label and a hex color
from copy. **Writing the description** is the real unlock, because the mandatory
description is the thing an author skips or writes badly, and a model reading the
file has more context than an author bothers to type — the surrounding markup, the
component, the route, the model behind it. **Translating** is the third and the
least interesting; it is the commoditized part.

The model is the app's own. `app.ai` already takes an `AIRegistry` through
`createApp({ ai })`, and `FJS-D153` already rules that a connector to a named
vendor is not in the framework, so *an LLM of your choosing* needs no new
mechanism.

### It is a generator somebody runs, and never a build step

Four reasons, and the first is an invariant rather than a preference.

- **Invariant 12 — mesa compiler output is reproducible.** Output depending on a
  model version, a temperature and a network call means two builds of one tree
  produce two different apps.
- **Offline.** A build that cannot run without a network is a build that fails
  without one, and this tree has already paid for that lesson once.
- **Unreviewable.** A wrong translation looks exactly like a right one to everyone
  who does not read the language. At build time nothing ever says so, which is
  § V's last question in its worst form.
- **Cost and latency**, on every build, over every string.

So the shape is the one this repo already has in three places:

```text
fli lexicon      →  the catalog, committed        ← the model runs here, once, by a person
vite build       →  reads the committed catalog   ← reproducible, offline, free
snapshots (CI)   →  fails when source drifted     ← grades with no network
```

`fli ws:exports` writes a committed `exports.snapshot.md` that the `snapshots`
phase gates. `litestone import` grades what its reading could not carry —
`changed`, `lost`, `noted` — on the line where it could not carry it. fbtee's
middle CLI verb preserves existing translations and marks new entries
`"status": "new"`. None of this is new machinery; it is the same discipline
pointed at strings.

**The build reads and never writes, and that is the load-bearing half.** One verb
owns source → catalog, which is what keeps the catalog a projection rather than a
second origin of truth.

**One file as the source, many as the output.** A single committed catalog is one
place to review and one thing to gate, and the per-locale chunks a browser loads
are derived from it at build — Paraglide's bundle win out of a loop sierra already
runs.

### What a committed artifact changes about translate-by-default

Marking by default is rejected above because the failure is invisible — a brand
name, an identifier or a user-generated string entering the catalog with nothing
saying so. **A committed catalog turns that failure into a diff line**, which
largely dissolves the objection: the generator marks, a person reviews, and an
override is visible in the same review. So `i18n-ignore`, rejected above for
having no job once marking was explicit, has one again — the default flipped back,
and this time the default's cost is paid where somebody looks.

It also makes the marking question smaller than the one this paper opened with. It
is no longer *what syntax does an author write for every string*. It is **what
does the generator write into the source, and what does a person write to override
it** — and the common case is now nothing.

### Four things the generator may not decide

The layer split is where a model does real damage, so it is a table rather than a
principle.

| Question | Decided by | Why not the model |
| -------- | ---------- | ----------------- |
| the plural categories of a locale | `Intl.PluralRules` | a model guessing Slavic grammar is wrong occasionally and silently |
| how many decimals a currency has | shipped ISO 4217 in `toolbelt/units` | measured, and the host disagrees with itself across runtimes |
| which parts of a sentence are parameters | the compiler's AST | it is a parse, and there is already one parser |
| **the words, and the judgment about context** | **the model** | this is the job |

## What the answer looks like

Four statements, which is what `FJS-D254` needs to rule and the most this file can
propose.

1. *(V2 — needs the marking, and the generator.)* **A string's marking and its
   description are GENERATED and overridden, never hand-authored, and its address
   is derived** from the text and the description together. This is `FJS-D12`
   constraint 1 — derive the address, never author it — extended to the tier the
   ruling did not reach, and it means no `.lite` syntax changes. It supersedes the
   earlier form of this statement, where the description was an author's
   obligation: the obligation was right and the author was the wrong party to
   carry it.
2. **Ruled 2026-09-20 as `FJS-D12` constraint 7 (`FJS-D254`).** A marked string is
   one unit, a nested element inside it is an implicit parameter, and no
   user-facing sentence is assembled from pieces. It is first among the four
   because it is the only one that cannot be retrofitted: a
   concatenation is a sentence that can only ever be English, and the call sites
   are already written by the time a catalog arrives.
3. *(V2 — needs the same marking plus a kit.)* **Grammar is declared and its
   semantics come from `Intl`** — plural, ordinal, select, list. Mesa owns the
   block, a toolbelt kit owns the `Intl` call and the
   category list, the catalog owns the words. Money and dates stay with the owners
   they already have, and gain no call-site syntax.
4. **Ruled 2026-09-20 as `FJS-D12` constraint 8 (`FJS-D254`).** Locale is an
   argument, and sierra holds it like the theme. The renderer is
   `createLexicon({ locale, catalog })`; `page.locale` is sierra's per-page
   instance and `db.$setLocale()` the Data-side flavor already reserved. This is
   what keeps the package severable, and it is the only one of the four that the
   email tier decides rather than the browser.

## What could land before the build

Two rules, both `fli check` over `.mesa`, both English-only, no runtime and no
package:

- **a user-facing sentence is not assembled from pieces** — **authorized**, as
  `FJS-D12` constraint 7. Gradeable against source today, since concatenation and
  interpolation into prose are both visible in the file and nothing has to be
  marked first. Warn-tier, on `check-baseline.json`'s ratchet. **Not written yet**
- ~~**a marked string carries a description**~~ — still waits on the syntax,
  which is V2. Nothing to enforce until a marking exists

**The order was: rule the interface tier, then the rules follow from it.** `fli
check` may only grade a claim with an authority in the tree, and when this was
written `FJS-D12` said neither of these. It now says the first.

**One thing does not wait on the ruling**, because it is a defect in two other
proposals rather than a rule about this one: `declared-semantics.md` and
`time-and-recurrence.md` both refuse an unknown code against
`Intl.supportedValuesOf`, and that list is the host's. Either correct them to
refuse against a shipped list, the way `toolbelt/units` already does, or record
that a currency valid under Bun and refused under Node is acceptable.

Filed as `FJS-D254`; **ruled 2026-09-20**, which added constraints 7 and 8 to
`FJS-D12` and left the rest with the original deferral.

## Sources

- `DECISIONS.md` § `FJS-D12` — the ruling and its six constraints
- `IDEAS/ecosystem-gaps.md` § 4 — where the gap was first argued
- `IDEAS/package-map.md` § Still proposed, and NOT a package — `lexicon` is the name
  of the WORK, decomposed across litestone, mesa and sierra, not a module
- `Intl` surface measured on Bun 1.3.11 and Node 22.21, 2026-09-20 — the three
  traps above
- [fbtee.dev](https://fbtee.dev) · [nkzw-tech/fbtee](https://github.com/nkzw-tech/fbtee)
