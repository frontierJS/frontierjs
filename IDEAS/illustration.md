---
id: illustration
status: proposed
dated: 2026-10-24
---

# Idea — Illustration: a paragraph and one picture in place of a page

**Status: PROPOSED.** Dated 2026-10-24. Prior art and a proposed shape;
nothing is built. Do not cite this file as describing behavior (`VERIFYING.md`).
Each source below is linked; where a claim comes from a secondary summary
rather than the work itself, the entry says so. The open questions are `Q1`–`Q4`
and a ruling cites one by number.

---

## Trigger

A concept page in this repo runs to 2,000 words. The bet is that for many
concepts a paragraph and one good illustration would carry the same
understanding, and that the hard part is not drawing but getting Claude to
write the *brief* for the picture. `brand/IMAGERY.md` already owns painted
images and lists "diagrams" as still to come (`brand/README.md` § Later). This
file asks what people who explain for a living do before they draw, and what of
it transfers.

---

## 1 · Why a picture can replace a page, and when it cannot

**Larkin & Simon, 1987** — the paper behind the proverb. A diagram and a text
can carry identical information and still cost very different effort: a diagram
indexes facts by *location*, so things that are used together sit together,
search disappears, and the eye makes inferences (adjacency, crossing, a gap)
that the text would make the reader compute. The "sometimes" in the title is
the condition: a picture only beats the prose where the prose would have made
the reader *search or compute*. A diagram of a list is a list.
[PDF](https://mechanism.ucsd.edu/bill/teaching/F12/cs200/Readings/larkin.whyadiagramissometimesworth.1987.pdf)
· [summary](https://www.jimdavies.org/summaries/larkin1987.html)

**Barbara Tversky, *Mind in Motion*** — what the marks mean before anyone
labels them. A line says *related*; an arrow says *asymmetric relation*
(sequence, cause, movement); a box says *contained* or *same kind*; a table
says *like with like*. Two design principles, which conflict: the form of the
picture should match the form of the idea (congruence), and the picture should
make the reader's task easy (apprehension). Every good diagram is a trade
between them. [review](https://www.learningandthebrain.com/blog/mind-in-motion-how-action-shapes-thought-by-barbara-tversky/)
· [arrows paper](https://hci.ucsd.edu/220/TverskyCogtiveDesign.pdf)

**Richard Mayer, multimedia learning** — the measured rules for words beside
pictures. Cut everything decorative (coherence, median effect 0.86 across 23
tests); put a label *on* the part it names rather than in a legend (spatial
contiguity); cue what matters (signaling); do not say the same thing twice in
two channels (redundancy).
[Mayer's chapter](https://ugc.futurelearn.com/uploads/files/7d/d6/7dd6188d-c343-4311-b064-ac98d2c95abc/Multimedia_Principles._R._E._Mayer__2020.pdf)
· [the twelve, listed](https://u.osu.edu/multimedialearning/?p=11)

**Olah & Carter, "Research Debt"** — why the explainer should pay. A poorly
explained idea costs every reader minutes; the explainer pays once. Distill was
founded on this trade. [secondary](https://forum.effectivealtruism.org/posts/EbvJRAvwtKAMBn2td/distillation-and-research-debt)

**Edward Tufte, *Visual Explanations*** — the smallest effective difference
(make distinctions as subtle as still works); layer the figure so there is a
hierarchy; label directly, never by code; small multiples for comparison; the
graphic carries the story. [rules, abridged](https://www.ams.org/publicoutreach/feature-column/visual1.html)

**Scott McCloud, *Understanding Comics*** — *amplification through
simplification*: stripping a drawing to its essentials is not losing detail
but choosing which details get louder. A simple figure is one the reader steps
into. [course handout](https://cowell.ucsc.edu/academics/courses/Understanding%20comics.pdf)

**Robert Horn, *Visual Language*** — words and shapes as one unit; the
working question is *which jobs do words do best and which do pictures do
best*, decided per figure. [Stanford abstract](https://hci.stanford.edu/seminar/abstracts/92-93/930217-horn.html)

What this section settles: the test for "is a paragraph and a picture enough"
is Larkin & Simon's. **A flow, a boundary crossed, a state that changes, two
options compared: yes. A list of facts, a definition, a policy: no.**

---

## 2 · The practitioners, and what each one is evidence of

| Who | Field | The transferable move | Source |
| --- | ----- | --------------------- | ------ |
| **Julia Evans** (Wizard Zines) | systems, networking | Personify the parts and show a *scene* of them talking; paste real output into the drawing; gray out what does not matter; pick the one hard-won insight that fits in a few panels; ask "does this explain or only entertain." Stick figures are enough. | [patterns](https://jvns.ca/teach-tech-with-cartoons/) · [comics for docs](https://jvns.ca/blog/2018/12/09/how-do-you-document-a-tech-project-with-comics/) |
| **Maggie Appleton** (egghead) | programming concepts | The layered cake: a **meaningful metaphor** at the base, then clear drawing, then composition, then light and color. Name the *source* and the *target*; a metaphor highlights some qualities and hides others, so pick it for what it hides. Research the metaphors already embedded in how people *talk* about the concept before inventing one. | [part 1](https://maggieappleton.com/drawinginvisibles1/) (parts 2–4 not fetched) · [React in five metaphors](https://beta.egghead.io/talks/javascript-drawing-the-invisible-react-explained-in-five-visual-metaphors) |
| **Lin Clark** (Code Cartoons) | engines, Wasm, Rust | Runtime parts as recurring characters across a series; the same character means the same thing in every article. No process writeup found. | [Mozilla Hacks](https://hacks.mozilla.org/2018/03/making-webassembly-better-for-rust-for-all-languages/) |
| **Jay Alammar** | ML | Trace one object's journey through a system, step by step, re-coloring the same object in every frame so the eye follows it. | *The Illustrated Transformer* (not fetched) |
| **Simon Brown** (C4) | software architecture | One level of abstraction per diagram, four levels. A review checklist a cold reader can run: title, type, scope, key; every element named and typed; every arrow labeled with its intent, direction matching the label; every color, shape, line style and size with one stated meaning. | [checklist](https://c4model.com/diagrams/checklist) |
| **Gregor Hohpe** | enterprise architecture | Pick the *viewpoint* first (dependencies, run-time calls, deployment); one abstraction level; a consistent visual vocabulary; a sketch style for a discussion and a precise style for a settled decision; and the sharpest test: **if the system cannot be drawn clearly, the design is suspect.** | [Diagram-driven design](https://www.enterpriseintegrationpatterns.com/ramblings/75_ddd.html) |
| **Google, Technical Writing Two** | docs | No more than one paragraph's worth of information in a diagram; if it takes more than five bullets to explain, split it; **write the caption first**; use a shape that breaks the pattern as the callout. | [Illustrating](https://developers.google.com/tech-writing/two/illustrations) |
| **Gene Zelazny** (McKinsey) | charts | Message first, then the comparison it rests on (component, item, time, frequency, correlation), then the form. **The title states the takeaway**, not the subject. | [summary](https://www.antoinebuteau.com/lessons-from-gene-zelazny/) |
| **Dan Roam**, *Back of the Napkin* | business | The 6×6: the question the reader has picks the picture. Who/what → portrait, how much → chart, where → map, when → timeline, how → flowchart, why → multi-variable plot. (First two verified in the sources; the rest from the book.) | [review](https://www.designersreviewofbooks.com/2009/01/the-back-of-the-napkin/) |
| **Jonathan Corum** (NYT) | science graphics | Design for one named reader and the one second they will give it. A graphic made for the wrong reader causes confusion rather than nothing. | [Design for an Audience](https://style.org/ku/) |
| **Bret Victor, Nicky Case** | explorables | The next tier: a reactive document the reader can poke. Relevant because an FJS page is Mesa and can do this. Not the first step. | [essay](https://worrydream.com/ExplorableExplanations/) · [explorabl.es](https://explorabl.es) |

Two things recur in every row. **Every one of them decides the message, the
reader and the viewpoint before any mark is made**, and most of them have a
written check they run on the result. The brief is the craft; the drawing is
execution.

---

## 3 · The 2026 tooling, so the brief picks a renderer it can trust

- **Image models and text.** GPT Image 2 and Gemini's Nano Banana 2 / Pro
  render short labels legibly in informal tests; Recraft V4 is the pick for
  vector and illustration; Ideogram for text-heavy images. No source tests any
  of them as a *diagram compiler*, and the one FAQ that addresses architecture
  diagrams says: generate the structure with a diagramming tool, use the model
  for the surrounding visuals, and check every label and arrow.
  [comparison](https://aireiter.com/blog/best-ai-image-model-text-rendering-2026)
  · [Zilliz FAQ](https://zilliz.com/ai-faq/how-does-the-reasoning-layer-in-nano-banana-2-improve-diagram-accuracy)
  · [science-comms test](https://thesciencetalk.com/news/nano-banana-pro-science-communication-infographic-tool/).
  `brand/IMAGERY.md` § 5 already rules the consequence: no lettering in a
  painted image; the page sets the type.
- **LLMs writing SVG.** SVGenius (ACM MM 2025, 2,377 queries): frontier
  models reach 70–80% on *understanding* SVG and rarely above 20 on
  *structural synthesis*, and every model degrades with complexity.
  [paper](https://arxiv.org/abs/2506.03139). Read: hand-written SVG is fine for
  a figure of a few boxes; past that, write a *source* (D2, Mermaid, Graphviz)
  and let a layout engine place things.
- **Diagram-as-code.** Mermaid has the most LLM familiarity and renders on
  GitHub, with little layout control; D2 lays out better, its best engine is
  paid. Render-and-check loops exist as agent skills. No measured quality
  benchmark; this is community consensus.
  [survey](https://nimbalyst.com/blog/best-ai-diagram-tools-2026/)
- **What Claude already holds.** The `artifact-diagramming` skill: depict the
  mechanism not its name, label every arrow, match complexity to the stakes,
  one figure one claim, `<figcaption>` and `aria-label` carry the claim,
  `currentColor` for both themes. The `dataviz` skill owns charts. Neither
  owns the *brief*.

---

## 4 · What transfers to FrontierJS

**The prompt is the brief.** Getting Claude to "write good prompts" is getting
it to fill a short brief before it draws or asks a model to. Every field below
is a move one of the practitioners above makes, with the citation beside it.

**Three kinds of picture, two of them already owned.** A figure here is one of:

| Kind | What it answers | Renderer | Owner today |
| ---- | --------------- | -------- | ----------- |
| **Illustration** | *what a thing is* — a Gate, a Surface, a Stressor | an image model, painted, no lettering | `brand/IMAGERY.md` |
| **Mechanism** | *how it works* — a call crossing the bridge, a hook pipeline, a write announced | hand SVG or diagram-as-code, labeled | nobody; `brand/README.md` says "still to come" |
| **Chart** | *how much* | SVG from data | `dataviz` skill |

Roam's question list picks the kind: *what/who* is an illustration, *how*
and *where* and *when* are a mechanism, *how much* is a chart.

**The vocabulary already did the metaphor work.** Appleton's second step is to
mine how people talk about a concept for the metaphors it already carries.
`VOCABULARY.md` and `brand/README.md` § 1 are that mining, finished: three
realms as three terrains, the surveyor, the bridge, the gate ladder, a
directive that travels. An illustration draws the vocabulary's metaphor; it does
not coin one. `brand/README.md` already says the frontier metaphor goes in
images and headings and never in feature names, so images are exactly where it
is allowed to be literal.

**The paragraph and the picture divide the work Horn's way.** The figure
carries the structure; the caption states the claim in one sentence; the
paragraph says what it costs and where it breaks, which is the house style
already (`brand/README.md` § Voice: *state the claim in bold, then say what it
cost*). The long page stays, linked, for the reader who wants the fourth
paragraph.

**Hohpe's test is a design review.** If a mechanism in this repo cannot be
drawn at one level of abstraction with every arrow labeled, that is a finding
about the mechanism, filed in `ISSUES.md`, not a drawing problem.

---

## 5 · The brief (proposed)

What Claude fills, in order, before a line is drawn or a prompt sent. One line
each; a field that cannot be filled in one line says the figure is not ready.

1. **Claim** — one sentence; becomes the caption and the `aria-label`. Written
   first (Google; Zelazny's title-is-the-takeaway).
2. **Reader** — one named reader and what they already hold (Corum).
3. **Question** — which of who/what, how, where, when, how much the reader is
   asking (Roam). This picks the kind.
4. **Kind and renderer** — illustration / mechanism / chart, and the tool.
5. **Viewpoint and level** — one abstraction level; which realm or realms;
   what is deliberately off the page (Hohpe, C4).
6. **Parts and relations** — at most seven named parts; every arrow with its
   verb: `writes`, `refuses`, `announces` (C4, Tversky).
7. **The difference** — when comparing, the one edge that each option adds or
   removes (`artifact-diagramming`).
8. **Metaphor** — source → target, taken from `VOCABULARY.md`; what it
   highlights, what it hides (Appleton). Illustration only.
9. **Encoding** — what each color, line style and size means; one hue for the
   thing under discussion and `currentColor` for the rest (Tufte, C4).
10. **Cut** — what was left out and why (Mayer's coherence).
11. **Check** — the C4 checklist answered yes; the output parsed (Invariant 15
    applies to SVG as it does to JS); labels legible at the size used.

A mechanism figure then renders by the `artifact-diagramming` mechanics; an
illustration appends the brief's subject line to `brand/IMAGERY.md` § 3 and
passes § 8; a chart goes through `dataviz`.

**The proof a figure replaces a page is a cold reader.** Hand a fresh session
the paragraph and the figure only, and ask it the questions the long page
answers. Where it answers them, the page can shrink to a link. Where it cannot,
the brief missed a part. This is the measurement; word count is the result.

---

## 6 · The five, measured (1.1)

`ARCHITECT.md` is 3,342 words, and § 2 Vocabulary is 1,940 of them, so section
length alone names one section. This departs from the letter of `FJS-D1501`
("measured by section length") to keep its substance — the five mechanisms the
file spends most words on. The count is by **mechanism**: the words of every
§ 1–§ 4 item that describes it, summed (awk over the file, fences skipped).
Larkin & Simon's test (§ 1) drops what is a list or a definition before counting —
the § 4 Domain Map table (313), the § 2 vocabulary table, the Queue's verb tiers,
Policy's two meanings.

| # | Mechanism | Words | Items counted |
| - | --------- | ----- | ------------- |
| 1 | Three realms grown from one schema | ~425 | § 1, § 3.1, Schema/Seed, Projection |
| 2 | The Warden grading a Call | ~356 | Warden, Principal/Actor, § 3.6, Policy, Gate, gate ladder |
| 3 | A Call down the pipeline and its Envelope back | ~350 | Call/Route, Method, § 3.3, Hook tiers, § 3.2, § 3.4 |
| 4 | A Run, its pivot, and a Release as the deploy instance | ~313 | Flow/Run, Release/Environment, Release/Pivot |
| 5 | A write announced: origin → event → channel → binding | ~300 | Signal/Event, Component/Binding, § 3.7, § 3.8, Channel |

Against Q4's guess: **1 and 3 confirmed.** The `$`-directive crossing the bridge
folds into 3 as its down leg, since `ARCHITECT.md` states directives only inside
the Call bullet. The gate ladder widens to 2: a 0–9 scale on its own is a list,
and the mechanism is where the Call is graded. **The surfaces beside `db/` are
replaced**: `ARCHITECT.md` never uses *surface* in Invariant 3's sense, which
lives in `VOCABULARY.md` (Surface, blessed), `CLAUDE.md` and `README.md` §
Project Structure. **4 and 5 are new.**

---

## Open questions

- ~~**Q1 — Where the brief lives.**~~ **Answered 2026-10-24 (`FJS-D1498`): A — a skill `illustrate` in `.claude/skills/`, owning § 5 and pointing at `brand/IMAGERY.md`, `artifact-diagramming` and `dataviz` by kind.**
  - **A** — a skill `illustrate` in `.claude/skills/`, owning § 5 and pointing at
    `brand/IMAGERY.md`, `artifact-diagramming` and `dataviz` by kind.
  - **B** — a section in `brand/IMAGERY.md`.
  - **Recommend A** — IMAGERY.md is a kit for one kind of picture and is read by
    a person pasting prompts; the brief is run by an agent on every kind. The
    precedent is `decision-rules` and `doc-hygiene`: a check an agent runs
    before an act lives in a skill. Confidence 3.
- ~~**Q2 — Renderer for a mechanism figure in committed docs.**~~ **Answered 2026-10-24 (`FJS-D1499`): A — hand SVG up to about eight parts, D2-to-SVG above that, committed as `.svg` beside the doc; Mermaid only where the reader is GitHub's renderer (a `README.md`).**
  - **A** — hand SVG up to about eight parts, D2-to-SVG above that, committed
    as `.svg` beside the doc; Mermaid only where the reader is GitHub's
    renderer (a `README.md`).
  - **B** — Mermaid fences everywhere, rendered by GitHub.
  - **C** — D2 source at every size, SVG committed.
  - **Recommend A** — an `.svg` takes the brand's graphic language and
    `currentColor`, and SVGenius says hand-authoring holds only at small sizes.
    No `.svg` or Mermaid fence exists in this repo's markdown yet, so there is
    no caller to move; B is the reopen path if GitHub readers come to dominate.
    Confidence 2.
- ~~**Q3 — A brand graphic language for diagrams now.**~~ **Answered 2026-10-24 (`FJS-D1500`): B — draw five figures, then write the section from what held.**
  - **A** — write `brand/README.md` § Diagrams before the first figure.
  - **B** — draw five figures, then write the section from what held.
  - **Recommend B** — it is `brand/README.md` § Later's own rule: a section
    only once there is a real asset to show. Confidence 3.
- ~~**Q4 — The first five.**~~ **Answered 2026-10-24 (`FJS-D1501`): A — the five mechanisms `ARCHITECT.md` spends the most words on, measured by section length; expected: the three realms from one schema, a `$`-directive crossing the bridge (Invariant 10), the gate ladder, the hook pipeline around a service call, the surfaces beside `db/` (Invariant 3).**
  - **A** — the five mechanisms `ARCHITECT.md` spends the most words on,
    measured by section length; expected: the three realms from one schema, a
    `$`-directive crossing the bridge (Invariant 10), the gate ladder, the hook
    pipeline around a service call, the surfaces beside `db/` (Invariant 3).
  - **B** — one figure end to end, cold-reader proof included, before five.
  - **Recommend A** — 1.1 measures, so a wrong guess costs one line; five is
    the smallest set a § Diagrams section can be written from (Q3). Confidence 2.

---

## Plan

### Phase 0 — The brief

- [x] 0.1 Run `decision-rules` on Q1–Q4; rulings `FJS-D1498`–`FJS-D1501` in `DECISIONS.md`.
- [x] 0.2 Write the brief of § 5 as the `illustrate` skill (Q1, `FJS-D1498`), with the table of kinds in § 4
      and the cold-reader proof.

### Phase 1 — Five figures

- [x] 1.1 Measure `ARCHITECT.md` section lengths; confirm or replace the
      five of Q4. Result § 6: two confirmed, two widened or folded, surfaces
      replaced by a Run's pivot and a write announced.
- [ ] 1.2 Brief each of the five; a brief that cannot fill a line in § 5 is
      filed as a finding on the mechanism (§ 4, Hohpe's test).
- [ ] 1.3 Render each by its kind; parse every SVG.
- [ ] 1.4 Cold-reader proof on each: paragraph and figure to a fresh
      session, the long page's questions asked; record pass or the missing
      part.
- [ ] 1.5 Shrink each passing page to claim, figure, cost paragraph and a
      link; keep the long page where it is.

### Phase 2 — Fold back

- [ ] 2.1 Write `brand/README.md` § Diagrams from what the five share
      (Q3 B): line weight, marker shape, the one accent hue, how a realm is
      marked.
- [ ] 2.2 Add the brief's check to `doc-hygiene` as the rule for a figure
      in a document an agent reads. Until then nothing enforces
      "a committed figure carries its claim and parses": no CI phase reads an
      `.svg`, and 1.4 is a hand drive. This step is the first place that does.
