---
id: wireframe
status: partial
dated: 2026-09-22
---

# Idea — the wireframe: a screenshot, read in the vocabulary, becomes components and a schema

**Status: PARTIAL.** Dated 2026-09-22. **Built**: `packages/cli/core/wireframe.js`
and `fli make:wireframe`, which take a wireframe — a screen written in
`@frontierjs/css` terms, as JSON — and write the components, the page, a draft
schema and a terminal drawing, graded with the app's own mesa and litestone.
**Not built**: the step in front of it that WRITES a wireframe from a screenshot.
Every wireframe so far was written by hand, so that hop is untested. Do not cite
this file as describing behavior — see `VERIFYING.md`. The nine questions were
answered before the first edit and are § *The nine*, below.

## The shape

A screenshot is pixels and the vocabulary is meaning, so the path cannot be
pixels to HTML. It is pixels to TERMS to markup, and each hop has a different
owner:

```
screenshot ──(vision: not built)──▶ wireframe.json ──▶ analyze ──┬─▶ <Component>.mesa · <Screen>.mesa · tones.js
                                    { term, mods,                ├─▶ <Screen>.draft.lite
                                      text, children,            └─▶ the terminal drawing
                                      unsure }
```

**The wireframe is a tree, never HTML, and that is the whole design.** A model
asked for HTML invents `.hero-card-thing` on its first try; a model asked for a
tree whose `term` is an enum read off `vocabulary.json` cannot. And every output
is a projection of the one tree — the drawing, the `.mesa`, the schema — which is
the argument `mesa-is-every-interface` makes about a surface being a compiler
backend, one layer earlier. HTML would have been a lossy intermediate: to find
components in it you parse it back into a tree, and by then the `?` a person must
answer and the `✗` on a tone that has no term are gone.

**A component is a shape that repeats.** Hash each subtree by its term and its
child terms, text ignored; what repeats is a component, what differs between the
copies is its props. `core/wireframe.js` § *analyze* carries the four passes —
group, merge (a subsequence is the same component with an optional part), fold (a
part found once in every copy of another belongs to it), slots — and is the one
owner of the answer. The prototype split it across two scripts and they
disagreed about the same badge, a list to one and two props to the other.

## What a screen can say and what it cannot

Measured on one real screen — a field-service board: an inbox of calls grouped by
client beside a kanban of tickets in four lanes. The committed fixture is that
screen with every name and number invented.

**Pill against Badge mapped without a single hard case.** Every count on the
screen was a Pill and every status a Badge, which is the distinction the
vocabulary draws. The near-miss pairs in `packages/css/guide/decisions.js` are
where a screenshot misleads, and this is the one that did not.

**Tone followed value, and that is a schema fact.** *New* was always success and
*HIGH* always warning. A tone that is a function of the value is written to
`tones.js` — the shape `example/web/src/status-tone.js` already has — rather than
into the component, because whether a value is good news belongs to the value.
Where tone is fixed by POSITION instead (a card's first badge success, its second
warning), the two are two props, and they turned out to be two enums: status and
priority.

**A kanban lane has no term.** The screen colored an inbox header, each lane's
top edge and each lane's status dot, and none of Pane, Section or Icon takes a
tone. The drawing marks each as `✗`. It is either a missing term or a design that
should say it another way, and one screen is not enough to tell which.

**Seven choices the pixels cannot settle**, carried as `unsure` and written into
the `.mesa` as a comment where they apply: Nav or Tabs for sibling views, Button or
Tabs for a sort toggle, Row or Disclosure for a row with a chevron, Bar or Toolbar
for an action strip holding a search field, Group or Cluster for lanes that
scroll rather than wrap, Kicker or Text for the name above a title, a tone or
`aria-current` for a highlighted card. Five of the css guide's wizard questions
deliberately have no sketch for the same reason — a Button and a Link are the
same shape.

## The data behind the components

**The components' props are a data model wearing a costume.** A card's kicker was
a client name and an age, its title a subject, its two badges two enums, its
avatars an assignee relation, and its optional pill an unread count. The lanes
were a group-by with counts. The draft schema reads that off by rule — a component
holding a list of another is a BUCKET, a listed one is a RECORD, a Badge is an
enum of the values seen, a Pill is a count derived at read, a run of Avatars is a
many-to-many, *name · 6d* is a name and `createdAt`, and a name that is another
bucket's key is a relation. On the board, *the client shown as a card's kicker is
also an inbox group's title* is what produced `Ticket.client`.

**What the structure cannot see is where the draft is most wrong.** *9 unplaced*
on the inbox suggests an inbox item is a ticket with no lane yet — one model with
`lane Lane?` rather than two — and only somebody who knows the domain can say.
And an enum holds only the values somebody happened to be in: one priority value
is not a scale, and the draft says so on the enum.

This is `discovery`'s job entered from a screen instead of a conversation, and the
draft is written beside the wireframe for that reason: nothing loads it, and what
survives moves into `db/schema.lite` by hand.

## Home

| Piece | Where | State |
| --- | --- | --- |
| The analysis, the outputs | `packages/cli/core/wireframe.js` | built, pure |
| The command | `fli make:wireframe <file>` | built; grades with the app's mesa and litestone |
| The fixture | `packages/cli/test/fixtures/wireframe/tasks.wireframe.json` | one screen, names invented |
| Screenshot → wireframe | — | **not built** — § *Open questions* 1 |

## The nine

Answered before the first edit, 2026-09-22.

1. **Origin.** Terms and classes are read from `@frontierjs/css/vocabulary.json`,
   never copied. Two facts are not in it and are copies: the terms that take a
   tone (from `tones.spec.js`) and the props passed to kit components (from each
   component's `export let`). Each has a test that fails when its source moves.
2. **Concept.** One noun, **wireframe** — the JSON. *Term tree* and a separate
   names file were dropped: names and model names live in the wireframe, one file
   per screen.
3. **Complexity.** The heuristics — optional parts, positional slots, folding —
   are the problem's, because screens vary. The complexity the design added was
   the analysis in two places, and it is one module now.
4. **Predictability.** A `make:` sibling: refuses to overwrite, honors `--dry`,
   writes under `context.paths.webComponents`, no flags of its own.
5. **Derived.** Which kit components exist is asked of the app's installed
   `@frontierjs/ui`, so an app on an older kit gets class markup rather than an
   import that fails.
6. **Owner.** No owner of *screen → code* existed; `crud-templates.js` runs the
   other direction, model to page. Compiling is mesa's and parsing is litestone's,
   both loaded from the app the way `project:intent` does.
7. **Boundary.** An unknown term or an unknown key is refused by name, never
   dropped.
8. **Failure.** Proportional to a draft: it never writes over a directory, and the
   draft schema never goes near `db/schema.lite`.
9. **Silence.** What must stay true: every `.mesa` written compiles and parses, and
   the draft parses. Enforced by the command grading its own output (non-zero
   exit) and by `test/wireframe.test.js`, which also asserts every class the
   output names is one `vocabulary.json` names. **The drawing's list of terms that
   lay out in a row is `none`** — nothing grades it, and a wrong entry draws a
   column where the page has a row.

**Batteries vs. smallness** is the adjudication in tension, and it passes: one
module and one command, removable without touching anything else.

## Open questions

1. **Who writes the wireframe from a screenshot?**
   - **A** — a vision call inside `fli`, with a JSON schema whose `term` is the
     vocabulary's enum, so an invented term cannot be emitted at all.
   - **B** — out of band: a skill or an agent writes the JSON and `fli` only reads
     it, as `fli intent` reads a candidate a translator wrote.
   - **Recommend B** — it keeps `fli` model-free, the same line
     `intent-recognizer.md` holds, and the schema that would constrain A is
     `readWireframe`'s refusal already. A is a later convenience over B, not a
     different design.
2. **A colored region with no term — the kanban lane.**
   - **A** — coin a term in `vocabulary.js` (a Lane or a Board).
   - **B** — let Section or Pane take a tone.
   - **C** — nothing yet; the `✗` is the answer until a second screen shows it.
   - **Recommend C** — one screen is an edge case and the same workaround in the
     same place is a measurement of the road (`PHILOSOPHY.md` § IV). Coining from
     one sample is how a vocabulary grows a term per client.
3. **A repeated card over a model is a Resource view (Invariant 18), not a free component.**
   - **A** — write every component to `components/<Screen>/`, as now.
   - **B** — where the draft's record matches a model already in
     `db/schema.lite`, write that component beside its Resource instead.
   - **Recommend A** — until the schema half is adopted: B needs a model to match
     against, and on a new app the model is the draft this same run wrote.
4. **Two near-shapes** — the board's call row and its reminder row differ in one
   leading slot (an icon against an avatar).
   - **A** — merge them into one component with a variable slot.
   - **B** — keep them apart and say so, as now.
   - **Recommend B** — the note costs a line and a wrong merge costs a component
     whose props lie about half its copies.
5. **The verb.** Every other `make:` makes the thing it names; this one makes FROM
   a wireframe.
   - **A** — keep `make:wireframe`; `make:scaffold` already makes from a model.
   - **B** — `wireframe:build`, a namespace of its own.
   - **Recommend A** — the one sibling that reads an input is the precedent, and a
     namespace of one command is a concept for nothing.

## See also

- `packages/css/vocabulary.js` — `VOCAB` and `ANATOMY`, what a term is and which
  parts it expects; `packages/css/guide/decisions.js` — the near-miss pairs
- `IDEAS/intent-recognizer.md` — the same division of labor for words: a
  candidate in, a verdict out, no model in `fli`
- `IDEAS/page-composition.md` — the tier the vocabulary does not have, which is
  where the lane question may end up
- `.claude/skills/discovery` — the schema half, entered from a conversation
