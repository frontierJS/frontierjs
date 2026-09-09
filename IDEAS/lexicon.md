---
id: lexicon
status: proposed
dated: 2026-09-09
---

# Idea — `lexicon`: the half of i18n the ruling did not reach

**Status: PROPOSED. Nothing is built.** `FJS-D12` ruled i18n on 2026-08-15 —
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

## What could land before the build

Two rules, both `fli check` over `.mesa`, both English-only, no runtime and no
package:

- **a marked string carries a description** — nothing to enforce until a marking
  exists, so this one waits on the syntax
- **a user-facing sentence is not assembled from pieces** — gradeable against
  source today, since concatenation and interpolation into prose are both visible
  in the file

**Neither can land as written.** `fli check` may only grade a claim with an
authority in the tree, and `FJS-D12` does not say either of these. A rule ahead
of its ruling is a rule arguing a paragraph, which is the thing the check surface
exists not to do. So the order is: rule the interface tier, then the rules follow
from it.

Filed as `FJS-D254`.

## Sources

- `DECISIONS.md` § `FJS-D12` — the ruling and its six constraints
- `IDEAS/ecosystem-gaps.md` § 4 — where the gap was first argued
- `IDEAS/package-map.md` § `lexicon` — the reserved package
- [fbtee.dev](https://fbtee.dev) · [nkzw-tech/fbtee](https://github.com/nkzw-tech/fbtee)
