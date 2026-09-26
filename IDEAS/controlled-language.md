---
id: controlled-language
status: proposed
dated: 2026-09-26
---

# Idea — a controlled language: the vocabulary, given verbs and sentence shapes, as the thing an app is described in

**Status: IDEA. Nothing built.** Dated 2026-09-26. The prior art in § 1 is
written from outside knowledge and **every citation is a lead to verify, not a
fact**. What the tree has, in § 2, was read off it that day with a path named.
Do not cite this file as describing behavior — see `VERIFYING.md`.

The registers have been growing a lexicon one ruling at a time — `VOCABULARY.md`,
`ARCHITECT.md` § 2, `ontology.md`, `ui-ontology.md`, `api-ontology.md`. The
question this paper asks is what that becomes if it keeps going: **not a
programming language and not open English, but a controlled natural language —
English restricted so every word has one meaning and every sentence shape maps
to one construct.**

## 1. The kind of thing, and which of them worked

- **ASD-STE100, Simplified Technical English** — aircraft maintenance manuals.
  Approved words with one meaning each, unapproved words mapped to the approved
  one. It is `VOCABULARY.md`'s `blessed` / `refused` / `alias` under another
  name. It worked because the domain is narrow and a checker enforces it.
- **Gherkin** — *Given / When / Then*, structured English bound to step
  definitions. It worked because every sentence has an executor behind it.
- **Inform 7** — English sentences that compile to an interactive fiction world.
  It works, in a niche that is itself a closed world.
- **Attempto Controlled English** — English that parses to first-order logic.
  Impressive and rarely used, because it aimed at the whole of meaning.
- Domain-Driven Design's **ubiquitous language** — the team's words, held the
  same in talk and in code. Discipline, with no checker.

**The pattern: a narrow domain with a checker wins; a general language that is
also English loses.** FrontierJS has the narrow domain — three realms seeded by
one schema — and a checker in `fli check`. What it does not have is § 3.

## 2. What the tree already has

1. **A lexicon.** `VOCABULARY.md` holds a status per word, `ARCHITECT.md` § 2
   holds the doctrine, and `DECISIONS.md` § Naming & vocabulary holds the
   rulings (`FJS-D382`–`FJS-D395` in the last two days alone).
2. **A measure.** `fli ws:terms` counts each term's spread. `FJS-1211` is the
   gated `ws:dictionary` it becomes — which is a lexer that fails a build on a
   refused word.
3. **Semantics for part of it.** `ontology.md`'s tree ends every leaf in a
   `.lite` construct, and `ui-ontology.md`'s ends its leaves in `controlFor`, an
   Interaction task or a Container tier. **A word that ends in a construct is a
   word that compiles.**
4. **Evidence it pays.** `intent-recognizer.md` measured that a model choosing
   off a closed menu was right on every question tried, while the same model
   paraphrasing inverted a conditional and turned `directives.js` into
   `directives.ts`. A controlled language is a closed menu of sentence shapes:
   it shrinks what can be said wrong, for a person and for an agent alike.

## 3. What is missing: verbs, then sentences

**Nearly every ruling so far is a noun.** `FJS-D393` is the first verb ruling —
an Event is *announced*. A language needs each noun paired with the verbs it
takes, and most of those verbs already exist in code and prose, unruled:

| Noun | Verb | Where it is spelled |
| --- | --- | --- |
| Service | *answers* a Method | `methods:`, `FJS-D02` |
| Gate | *refuses* / *admits* | `@@gate`, `toolbelt/gate` |
| Hook · Guard · Observer | *halts* · *allows or denies* · *receives* | `FJS-D06` |
| Event | *is announced* | `FJS-D393` |
| Job | *is dispatched* · *is scheduled* | caravan, `FJS-D198` |
| Transition | *moves* a row | `db.x.transition(id, name)` |
| Commitment | *is owed* | `@@commitment`, `FJS-D353` |
| app | *claims* an `app.<thing>` | Invariant 5 |
| Route | *establishes* a session | `FJS-D20` |

**Then sentence shapes, each with one construct.** A sketch — each is a claim
to test in § 4, not a design:

1. *A ‹Model› is read at ‹n›, created at ‹n›, updated at ‹n›, deleted at ‹n›.* → `@@gate("r.c.u.d")`
2. *A ‹Model› moves from ‹state› to ‹state› by ‹name›.* → `@@transitions`
3. *A ‹Model› is owed ‹transition› at ‹time derived from a field›.* → `@@commitment`
4. *A ‹Model›'s ‹field› is guarded / encrypted / secret.* → `@guarded` / `@encrypted` / `@secret`
5. *‹Service› answers ‹method›.* → the `methods:` list
6. *Before ‹Service›.‹method›, ‹name› may halt it.* → a `before` Hook
7. *A write to ‹Model› is announced to whoever may read it.* → the write tap
8. *‹Job› runs at ‹cron›.* → `handle({ cron })`
9. *‹Notification› is sent to a ‹Recipient› by ‹transport›.* → `defineNotification`, `via`
10. *A ‹field› is edited as a ‹task›.* → `controlFor`, `INTERACTION_TASKS`

**One sentence, three uses.** A **generator** scaffolds the construct; a
**checker** asks whether the code still says what the sentence says; a
**reader** — the intent resolver — maps a customer's words onto a sentence
rather than onto free text.

## 4. The first measurement

Before any of the three uses, a coverage table over `example/`: **every seed
construct in `db/`, `api/` and `web/` — does a sentence shape name it; and every
sentence shape — does a construct answer it?** Both directions, the way
`@frontierjs/css`'s spec grades `vocabulary.js` against the CSSOM. The gaps are
the finding, as the one empty cell was in `ontology.md`: a construct with no
sentence is a thing the framework can do and nobody can say, and a sentence with
no construct is a promise.

## 5. Where it stops

- **Not Turing-complete, ever.** A condition no shape expresses falls through to
  a Hook, and a Hook is TypeScript. That escape is what keeps the language
  honest — Attempto had none.
- **A small grammar and a growing lexicon.** The concept budget
  `ui-ontology.md` § 6 caps at three per tree caps sentence shapes too: a new
  shape is a ruling, and a new word under an existing shape is not.
- **Prose stays prose.** `PHILOSOPHY.md`, the rulings, and every *why* are
  English. Only claims about what EXISTS take the controlled form.

## Open questions

- **Where do verbs live?**
  - **A** — a *Verbs* column on `VOCABULARY.md`'s existing rows, so a noun and
    its verbs are one row
  - **B** — a separate verb register beside `VOCABULARY.md`
  - **Recommend A** — a verb only makes sense under its noun, which is what
    **Under** already models, and a second register is a second place to look
- **What is built first?**
  - **A** — the coverage table of § 4, over `example/`, measured and not gated
  - **B** — a checker: `fli check` grading code against written sentences
  - **C** — a generator: `fli make` taking a sentence
  - **Recommend A** — it is the only one that can say whether the shapes in § 3
    are the right ones, and B and C both build on shapes nobody has measured
- **Does an app ever hold sentences of its own?**
  - **A** — not yet. The language is for the framework's docs, for agents and
    for the intent resolver; an app's truth stays its seed and its code
  - **B** — yes, a sentences file per app that `fli check` grades
  - **Recommend A** — a second source of truth beside the seed breaks the one
    mental model (everything traces back to `db/schema.lite`) until the coverage
    table shows the sentences carry something the seed cannot

## See also

- `ontology.md`, `ui-ontology.md`, `api-ontology.md` — the noun trees this gives verbs to
- `intent-recognizer.md` — the reader, and the menu-versus-paraphrase measurement
- `FJS-1211` — the gated dictionary this needs as its lexer
