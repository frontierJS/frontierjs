---
id: enum-member-tone
status: withdrawn
dated: 2026-10-05
---

# Proposal — a tone on an enum member, so a status badge is derived rather than mapped

**Status: PROPOSAL. Nothing here is built.** The counts were read off the `.mesa`
corpus (`example`, `packages/basecamp`, `../fjs-prototypes`) with `rg` on the date
above. They are regex counts, so read them as sizes rather than totals. Never cite this
file as behavior; see `VERIFYING.md`.

## Trigger

Every app maps a status enum to a `@frontierjs/css` tone by hand, in the template:

- 81 `tone={…}` attributes hold a ternary. Some are nested on a status:
  `tone={invoice.status === 'void' ? 'muted' : invoice.status === 'paid' ? 'success' : ''}`.
- 54 lookups go through a hand-written map (`const tones = { sent: 'success', … }`).
- `../fjs-prototypes/transit/web/src/routes/sources/index.mesa:33` and
  `sources/[id].mesa:57` carry **the same map twice**.
- `example/web/src/routes/invoices/[id].mesa` carries a map at `:56`
  (`issued: 'warning'`) and a ternary at `:185` that gives `issued` no tone.
  That is two origins in one file, and they already disagree.

Nothing reports either drift. A wrong tone is a badge in the wrong color.

## Where FJS stands

The seam this needs is already there, one attribute wide:

- An enum member already takes attributes through the field-attribute parser and
  refuses every one except `@label("…")`, naming the member (`parseEnum` in
  `packages/litestone/src/core/parser.js`).
- `@label` emits `x-labels`, a **partial** map that holds stated labels only
  (`packages/litestone/src/jsonschema.js`, the enum loop). The partial map is how a
  reader tells "the schema says" from "nobody said".
- `buildFieldRules()` folds `x-labels` into `rule.options`
  (`packages/sierra/src/resource/field-rules.js:215`).
- The tone vocabulary is closed and has one owner: the `tone` list in
  `packages/css/vocabulary.js`.

## The idea

```lite
enum InvoiceStatus {
  draft
  issued @tone(warning)
  paid   @tone(success)
  void   @tone(muted)
}
```

- The parser admits `@tone(<ident>)` beside `@label` on a member and still refuses
  everything else.
- `jsonschema.js` emits `x-tones` as a partial map, the same way and in the same loop as
  `x-labels`.
- `buildFieldRules()` puts the tone on each `rule.options` entry, beside the label.
- A display component takes the field and the value and renders label + tone. One
  candidate is `<Badge field="status" value={invoice.status}>`, or one exported reader
  `toneOf(rule, value)`. Neither the app nor the template names a tone.

A member with no `@tone` gets no tone attribute, which is today's `''` branch said once.

## What this does not do

It does not add a general `match` expression. Of the status ternaries the corpus holds
(27 `.status === 'x' ?` sites), the ones that are not tones are copy, and copy is
`@label`'s job. Whatever is left is app logic, and a plain object or `switch` already
expresses it. Revisit `match` only if a corpus count after this lands still shows
nested status ternaries that are neither tone nor label.

## The nine

1. **Origin.** It removes origins: one per file per status becomes one per enum.
2. **Concept.** No new noun. *Tone* is css's word and *enum member attribute* is
   `@label`'s seam.
3. **Complexity.** The problem's own. A status already has a meaning, and the color
   follows from that meaning, not from the page.
4. **Predictability.** `@tone` goes where `@label` already goes and travels as its
   sibling `x-tones`. Knowing one teaches the other.
5. **Derived.** That is the point of it: the template derives the tone instead of
   restating it.
6. **Owner.** Existing owners only: the parser's member-attribute branch, the enum loop
   in `jsonschema.js`, `buildFieldRules()`. The tone list stays in
   `vocabulary.js`.
7. **Boundary.** `x-tones` is a named, typed JSON Schema keyword, tested where
   `x-labels` is.
8. **Failure.** A tone css does not name should be a **parse error**, not a warning: a
   misspelled tone renders as no tone, which nobody notices. See open question 1.
9. **Silence.** Must stay true: every stated tone is in css's vocabulary. Artefact: the
   parse error in 8, plus a spec in `vocabulary.spec.js`'s style that checks it. Until
   question 1 is answered, this row is `none`.

**Adjudication in tension:** *Batteries vs. smallness* is not at stake. *Coherence vs.
convention* is: a Data-realm file naming a UI word. `@label` set that precedent, and
Invariant 6's affordance rule covers it, because a tone only changes how a value looks
and is never enforced.

**Tier:** Assessment until built. Building it changes the `.lite` language reference
(Map) and adds a `bridge-index` entry beside `@label`.

## Open questions

1. ~~**Who validates the tone name.**~~ **Moot 2026-10-09 (`FJS-D817`): the proposal is refused.** Litestone cannot import `@frontierjs/css`.
   **A**: litestone accepts any identifier and sierra's `buildFieldRules()` refuses an
   unknown one at build time. **B**: the tone list moves into `@frontierjs/toolbelt`,
   which both litestone and css may import, and the parser refuses an unknown tone.
   **Recommend B.** It is the "one fact that must have one answer" that toolbelt's
   import license exists for, and the error then lands in the `.lite` file where the
   typo is.
   - **A** — Litestone accepts any identifier, and sierra's `buildFieldRules()` refuses an unknown tone at build time.
   - **B** — The tone list moves from `packages/css/vocabulary.js` into `@frontierjs/toolbelt`, which both litestone and css may import, and the parser refuses an unknown tone.
   - **Recommend B** — It is the "one fact that must have one answer" that toolbelt's import license exists for (`FJS-D26`), and the error lands in the `.lite` file where the typo is. Under A, a schema that never passes through a sierra build is never checked.
2. ~~**Treatment as well as tone?**~~ **Answered 2026-10-09 (`FJS-D817`): refused — no `@tone` at all; a `.lite` file names no UI word.** No call site in the corpus asked for one. Leave it out
   until one does.
   - **A** — Tone only: `@tone(danger)`, and a treatment stays the template's choice.
   - **B** — Both: `@tone(danger, outlined)`, carried as a second keyword beside `x-tones`.
   - **Recommend A** — No call site in the corpus asks for a treatment, and a treatment is how a badge is drawn rather than what the value means, so it does not belong in the Data realm. Add B only when a corpus count shows status treatments mapped by hand.
