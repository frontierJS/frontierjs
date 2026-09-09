---
id: declared-interaction
status: proposed
dated: 2026-09-09
---

# Idea — Four facts about a call that still live in hand-written client glue

**Status: IDEA. Nothing here is built.** Dated 2026-09-09. Every *Where FJS
stands* claim below was read off the tree that day with a path and a line named;
everything else is a proposal. Do not cite this file as describing behavior —
see `VERIFYING.md`. **htmx is cited nowhere else in this repository**: grepped
across `IDEAS/`, `DECISIONS.md` and `ISSUES.md`, zero occurrences, which is why
this is a file rather than four paragraphs folded into existing ones.

---

## Trigger

The htmx 4 documentation (`four.htmx.org/docs`), read for whatever is worth
taking. **The core is not**, and the reason is the whole shape of the framework:
htmx's server sends HTML and the client places it, FJS's server sends JSON and a
schema and the client builds the UI from the seed. `html-over-the-wire.md`
already separated those two bets and this file does not reopen it.

What survives the rejection is narrower and it is not about hypermedia at all.
**htmx declares four things about a request that FJS makes every app write by
hand**: what happens when two of them race, what the page looks like while one is
open, whether the person meant it, and which nodes survive the swap. Each is a
fact the framework already knows and does not carry.

That places all four on the axis `overview.md` named after its own fourth
pass — *strong wherever the compiler or the schema owns a fact, weak wherever
the fact lives in imperative client glue* — and three of the four are the last
mile of something already shipped rather than a new mechanism.

---

## 1. A call that was overtaken — the strongest of the four

htmx declares concurrency on the element: `hx-sync="this:replace"` aborts the
in-flight request, `closest form:queue` serializes against the form's, and
`htmx:abort` cancels programmatically.

**Where FJS stands.** There is one `AbortController` in the whole framework and
it is a timeout, not a supersession —
`packages/junction/src/client/index.ts:1750-1751`. Nothing in
`packages/sierra/src/junction/resource.js` knows that a second `load()` has
started while the first is still awaiting.

**The bug class is already proven here and was fixed once, locally.** Sierra's
router carries the last-to-*finish* hazard as a hardening suite of its own
(`packages/sierra/tests/router-hardening.test.js`; root `CLAUDE.md` §*Which
drive proves a change*), with a slow load that was not superseded still
committing as its negative control. **The router solved it for navigations and
for nothing else.** A typed search box, a filter bar and `resource.more()` are
the same shape — two calls in flight, the answer taken from whichever returns
last — and each app that hits it writes the guard again or does not notice.

**The shape.** A policy word on the call, not a new noun: the last one wins,
they queue, or a second is refused while one is open. It is the one of the four
that **cannot be derived** — nothing in the schema knows whether a stale answer
is harmless or a lost write — so it is declared, and the default has to be the
conservative one.

**What it turns on.** A dropped call is a promise that never settles, and a
resolved-but-ignored one is a promise that lies. Which of those two a superseded
call becomes is the decision; getting it wrong is a hang or a silent overwrite,
neither of which anything reports.

---

## 2. In flight — shipped for a form, absent for everything else

htmx puts an `htmx-request` class on the element for the life of the request and
reveals `.htmx-indicator` from it; `hx-disable` disables during.

**Where FJS stands, and it is further along than it looks.** `<Form>` already
does this: `submitting` is set around the call and published on
`$context.form`, so every control in the form can read it
(`packages/ui/components/forms/Form.mesa:207`, set at 473 and cleared at 494,
`aria-busy` at 646). It is deliberately reported **separately** from `disabled`,
and the file says why — merging them made the two undecidable
(`Form.mesa:187-192`).

**So the paved road exists for exactly one caller.** The flag is Form's own
local. The resource does not expose it, so anything that is not a form submit —
a transition button, a delete, a `load()`, a `more()` — is back to the sequence
`resource.js` describes in its own header: an `around` hook and a signal, per
screen (`packages/sierra/src/junction/resource.js:49`, sketched at 123).

**The shape.** Move the flag down a layer: the call knows it is open, so
`$context.form.submitting` becomes the form's view of something the resource
carries for every call. Nothing new is coined and `<Form>` keeps its spelling.

**What it turns on.** Whether in-flight is per resource, per method or per call.
A screen with two independent buttons on one resource wants the last; a form
wants the middle. That is the question, and Form's own separation of `disabled`
from `submitting` is the evidence that merging is how it goes wrong.

---

## 3. Confirming a destructive move — the mechanism ships, the text is typed

htmx's `hx-confirm="Are you sure?"` is an attribute on the element.

**Where FJS stands.** The same design is already here and already ruled:
`data-confirm` on any element, one capture-phase listener at the document,
degrading to a plain button when nothing is mounted
(`packages/ui/components/overlay/ConfirmProvider.mesa`, `FJS-D115`). Its own
header carries the measurement that justified it — basecamp had 16 destructive
one-click buttons and not one confirmation, so the per-call-site component was
not rejected, it was out-competed by not doing it.

**The remaining half is the text and the necessity, both typed by hand.** The
schema already knows which moves exist and who may make them: `@@transitions`
reaches a control through `transitionsAt()`, and refunds in `example` are the
app's only `@gate(5)` move. Nothing carries *this move cannot be undone* from
the schema to the button, so whether a destructive action confirms is a matter
of whether the person writing the screen remembered.

**The shape.** The schema declares the move irreversible; the control asks
without being told to. This is the one place the htmx spelling must be rejected
rather than borrowed — **the sentence is not typed in markup** (*familiarity vs.
precision*), because two origins for *is this dangerous* is the failure the
whole seed argument exists to avoid.

**What it turns on.** Nothing about enforcement: a confirmation is an affordance
and Invariant 6 stands regardless, so a wrong answer costs a dialog and never a
deletion. That is what makes it cheap to be wrong about and therefore worth
deriving.

---

## 4. A node that survives the swap

htmx's `hx-preserve` keeps an element with a stable id alive across a swap of
its ancestor.

**Where FJS stands.** There is no equivalent. Island mounting **replaces** the
prerendered range rather than adopting it, and that is deliberate and stated —
hydration does not exist in Mesa, so there is nothing to adopt with
(`packages/sierra/src/islands/loader.js:16-22`). A route change replaces the
page.

**The gap is narrow and real**: a playing video, a map at a scroll position, an
open combobox, a focused input with an uncommitted value. Each is fine until the
subtree above it is replaced, and then it silently restarts.

**The shape.** A marker read at mount and at navigation, not a general
adoption pass — the point is to keep the escape narrow enough that using it
does not repeal anything, which is the reason `hx-preserve` is a whitelist in
htmx too.

**What it turns on.** It is the only one of the four that adds a concept rather
than finishing one, so it is the one that should wait for a second caller.

---

## What NOT to take

**Response headers that steer the client** — `HX-Retarget`, `HX-Reswap`,
`HX-Trigger`, `HX-Reselect`. They are coherent in htmx because the response *is*
the UI. Here they would put a second owner beside `publish()` and the result
envelope for *what a mutation means to a screen*, which is Invariant 4 directly.
A broadcast is graded per recipient; a header is not graded at all.

**`hx-boost` and the no-JS baseline.** The honest gap it points at is real: a
buying island on a prerendered `site/` page does nothing if the bundle fails.
htmx's answer is a plain form POST answered with HTML, and paying for it here
means junction growing an HTML-response mode — a second owner of `wrapResult`,
for one surface. `form-actions.md` is where that argument already lives and it
is a better place for it than this file.

---

## Where htmx and FJS already agree, arrived at separately

Worth recording because convergence is evidence and because three of these
would otherwise read as gaps:

- **`hx-trigger="revealed"` / `intersect`** is `client:visible` and
  `client:idle` (`packages/sierra/src/islands/loader.js:238-257`), and FJS's
  version fetches the chunk on the directive rather than up front.
- **Out-of-band swaps and `<hx-partial>`** — one response updating several
  places — are `record(id, { composed: true })` and a graded broadcast. htmx
  delivers to whoever asked; FJS grades per recipient, which is strictly more.
- **`htmx.config.mode = "same-origin"`, enforced and not overridable in
  markup**, is Invariant 6 in another vocabulary: markup states an affordance,
  the boundary decides.
- **The 4.x break itself** — attribute inheritance made explicit, `:inherited`
  now required — is the same call this repo makes wherever inheritance is
  named rather than implied.
- **Morphing** is moot: Mesa's reactivity is per value, so there is no swap to
  reconcile.

---

## The nine questions

Answered before the file was written, per `.claude/skills/decision-rules`.

- **Another origin of truth?** No for 1, 2 and 4 — each replaces per-app hand
  code with one owner. Item 3 introduces one **if** the confirmation sentence
  can be both typed and derived; the proposal is schema-only for that reason.
- **Concept budget?** Zero new nouns for 1–3: a policy word on an existing call,
  a field on a context that exists, a fact on `@@transitions`. Item 4 adds one
  marker and is ranked last because of it.
- **Whose complexity?** The problem's. Races, in-flight state, destructive moves
  and preserved nodes are what every app hits; none is invented here.
- **Predictability?** Item 1 reduces it and is the reason to be careful: a
  superseded call changes what a promise does. Named as the thing that has to be
  settled before it is built.
- **Derived rather than restated?** Item 3 yes, and that is its whole content.
  Item 2 partly — the flag exists and is in the wrong layer. Item 1 no, and it
  says so rather than pretending.
- **One owner?** Sierra's resource for 1 and 2, the schema for 3, Mesa's mount
  for 4.
- **Boundary named, typed, tested?** Not yet — that is what the build owes, and
  each item names its likely proof: `verify:revisions` already races two writers
  on one form, which is item 1's shape.
- **Failure proportional?** Item 3 yes by construction (an affordance cannot
  widen access). Item 1 is the expensive one — a dropped save — so its default
  is the conservative policy.
- **Wrong without anything saying so?** All four, which is the argument for
  filing them: an unsuperseded race, a missing spinner, an unconfirmed delete
  and a torn-down video all look exactly like working software.

**Adjudication in tension: familiarity vs. precision.** Steal the proven shapes,
reject the words where they half-fit — so no `hx-*` spelling appears in any of
the four, and item 3 in particular takes htmx's mechanism and refuses its
authoring model.

**Tier: Assessment** (§ VII). Nothing here is behavior and nothing may be cited
as behavior.

---

## Relationship to the other files

- `html-over-the-wire.md` — the bet this file declines, argued properly there.
- `form-actions.md` — where the no-JS baseline belongs, not here.
- `client-data-lifecycle.md` — closed, and item 1 is the axis it did not cover:
  it gave a load an identity, not a rule for two of them at once.
- `forms-from-the-seed.md` — item 2's shipped half, and § *What is still
  hand-written* is the same complaint one layer over.
- `derived-suspense.md` — Mesa already tracks pending per derived value, which
  is a different fact from *a call is open* and does not cover item 2.
- `prior-art.md` — a reading list; htmx belongs on it as evidence of the
  opposite bet made well.

## Prior art — sources

- htmx 4 documentation, `four.htmx.org/docs`, read 2026-09-09.
