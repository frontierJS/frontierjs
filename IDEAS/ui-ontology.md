---
id: ui-ontology
status: proposed
dated: 2026-09-24
---

# Idea — the UI realm's primitives: what a screen is made of, read against fifty years of naming it

**Status: IDEA. Steps 1–5 of § 7 are done; Component and Binding are ruled (`FJS-D382`, `FJS-D383`); Interaction task, Container tier and Writable derived are blessed (`FJS-D384`); every open question is answered (`FJS-D385`–`FJS-D390`), and the one code change among them — `bytes` as a fifth task — is built.** Dated 2026-09-24. The *what
the tree has* claims in § 2 were read off the source that day with a path named;
the prior art in § 1 is written from outside knowledge and **every citation is a
lead to verify, not a fact** — the same confidence `review-prior-art.md` states
for its Ash section. What IS measured is the absence: each name in § 1 was grepped
across `IDEAS/`, `DECISIONS.md`, `ISSUES.md`, `ARCHITECT.md`, `PHILOSOPHY.md` and
the mesa, sierra, ui and css docs, and returned zero. Do not cite this file as
describing behavior — see `VERIFYING.md`.

It is the Data realm's `ontology.md` asked of the UI realm. That paper found that
*what kind of thing is this* had an old name, that every leaf of its tree already
ended in a `.lite` construct, and that the one empty cell was the finding. This
one asks the same of the realm whose noun is Resource.

---

## Trigger

`VOCABULARY.md` grew a `Home` and an `Under` column on 2026-09-24, and the first
placement pass put **33 terms in the UI realm and 25 of them under one umbrella,
Component** — Card, Popover, Combobox, Modal, Pill, Switch, DatePicker and
eighteen more as siblings. An umbrella holding four fifths of a realm is not a hierarchy;
it is a list with a heading. And `ARCHITECT.md` § 2 *Not yet named* has carried
**Component** and **Binding** as unruled since `FJS-D06` §3. Both say the same
thing: the UI realm has one ruled noun, Resource, for what the UI *gets*, and
nothing ruled for what the UI *is*.

---

## 1. The question has a name, and the name is old

**How does a person perceive state and act on it — and what between the model
and the pixel is the framework's to own?** Ranked best first by how much of the
answer each one carries for a framework that derives its screens from a schema.

| Tradition | The words | Worth reading for |
| --- | --- | --- |
| **CAMELEON reference framework** (Calvary et al., *Interacting with Computers* 2003) | Tasks & Concepts → **Abstract UI** → **Concrete UI** → **Final UI** | **The one to actually read.** Four levels of reification from a domain model to pixels, built for one UI over many targets. It is the prior art for a schema-seeded screen and for `FJS-D38`'s *a surface is a compiler backend* in the same diagram |
| **IFML**, Interaction Flow Modeling Language (OMG, adopted 2013, 1.0 2015) | ViewContainer · ViewComponent · Event · Action · NavigationFlow · DataBinding · ParameterBinding | A standard metamodel for exactly *resource + form + navigation*. Its **DataBinding** is the nearest outside answer to the Binding § 2 left open |
| **Foley, Wallace & Chan**, *The Human Factors of Computer Graphics Interaction Techniques* (1984) | Six **interaction tasks** — select · position · orient · path · quantify · text — each met by many **techniques** | The BFO of form controls. A control is a technique for a task, and the task is the umbrella the Component list is missing |
| **Elliott & Hudak**, *Functional Reactive Animation* (1997) | **Behavior** (a value at every moment) against **Event** (a value at a moment) | The pedigree of `FJS-D44`'s Signal/Event split, which the ruling makes without citing it |
| **Mokhov, Mitchell & Peyton Jones**, *Build Systems à la Carte* (2018); Acar's self-adjusting computation; Hammer et al., Adapton (2014) | scheduler × rebuilder; source · derived · effect; demand-driven vs push | A precise vocabulary for what Mesa's flush IS — *outside-in, one DOM depth at a time* is a scheduler choice with a name somewhere in this table |
| **Foster, Greenwald, Moore, Pierce & Schmitt**, *Combinators for Bidirectional Tree Transformations* (2007) | **Lens** — get and put, with round-trip laws | The one prior art for Mesa's **writable derived** (`$: name = expr`), which FRP has no word for |
| **Harel**, *Statecharts* (1987) | hierarchical state · transition · guard | Screen-local state, and the bridge to `@@transitions` — which reaches the browser as `x-transitions` for ROWS and has no counterpart for a drawer, a wizard or a tab |
| **Pawson**, *Naked Objects* (2002; thesis 2004) | a UI derived entirely from the domain model | `<Order />` as the default form is this idea, and the thesis records where it broke — which is worth more than where it worked |
| **Norman**, gulfs of execution and evaluation (1986, 1988); **Shneiderman**, *The Eyes Have It* (1996) | evaluation vs execution; overview · zoom · filter · details-on-demand | The top fork of the tree in § 3, and the four things a list screen does |
| **Reenskaug**, MVC (1979) → **DCI** with Coplien (2009) | Model · View · Controller; Data · Context · Interaction | Historical grounding. DCI's *Context* is a different thing from every Context here, so read it and do not borrow it |

**The same risk `ontology.md` named for Commitment applies twice here, and more
sharply.** A borrowed word brings its meaning with it. IFML's **Event** is a user
gesture, and `FJS-D44` gave Event to Junction's announcement; FRP's Event is
discrete-in-time and would sit on the Signal side of that ruling. Hohpe & Woolf's
Channel already cost `FJS-D06` a ruling in the API realm. **Borrow the structure,
check every noun against § 2 before taking it.**

---

## 2. What the tree already has, read against them

**Every CAMELEON level exists here, and each was built without the others being
named.** Read off the tree on 2026-09-24.

| Level | In FrontierJS | Where |
| --- | --- | --- |
| Tasks & Concepts | the seed, and the JSON Schema derived from it — `x-values`, `x-transitions`, `@label` | `db/schema.lite` → `generateJsonSchema` |
| Abstract UI | **Resource**, and two functions that are one idea: `controlFor` answers *what may WRITE this field*, `displayFor` answers *what may SHOW it* | `packages/sierra/src/resource/field-rules.js:483` and `:796` |
| Concrete UI | the kit's components, and css's vocabulary of 56 terms in eight tiers | `packages/ui/components/`, `packages/css/vocabulary.json` |
| Final UI | a Mesa compiler backend — the DOM today, terminal and native by ruling | `FJS-D38` |

**The input/output pair already knows it is a pair.** `Cell.mesa`'s header calls
itself `FormField.mesa`'s twin, answering a name `displayFor` gives as
`FormField` answers one `controlFor` gives. CAMELEON calls both *abstract
interactors*, IFML calls both *ViewComponents*; here they are two function names
and no noun. (`controlFor`'s own comment still says a read-only value *wants the
surface that does not exist yet* — `displayFor` is that surface, three hundred
lines below it.)

**`controlFor` skips Foley's middle level.** It maps a schema type straight to a
technique. Reading its return values back into tasks:

| Task | What `controlFor` answers | Notes |
| --- | --- | --- |
| select | `select` (enum) · `combobox` / `picker` (`x-values`, references) · `multiselect` · `checkbox` (boolean — select one of two) | The kit's RadioGroup and Switch are techniques for the same task that `controlFor` never chooses |
| quantify | `input` with `step` · `datetime` | **`@money` and `@scale` return no control** and a reason saying to register one — a quantify task with no built-in technique. The kit's Slider is never chosen |
| text | `input` · `textarea` · `json` | |
| position | `geo` | |
| path | — | no instance |
| orient | — | no instance |
| *(bytes)* | `file` | **The task 1984 did not have** — file input postdates the list |

**`@frontierjs/css` is the one part of the realm that already has a hierarchy.**
Its vocabulary is tiered by containment — Base (Surface, Chip), Frame (App,
Topbar, Sidebar, Shell), Page (Screen, Pane, View, Tabs), Region, Block, Inline,
with Overlay beside the ladder and Layout across it. **Fifteen of the 25 terms
placed under Component have a tier there already**, and `VOCABULARY.md` did not
read it, which is why they landed flat. Of the other ten, five are inputs —
Combobox, DatePicker, Input, Select, RadioGroup — and belong under a task rather
than a tier; four are the kit's spelling of a css term (Tab for Tabs, Modal and
CommandPalette for Dialog, Empty state for Empty); one, DropdownMenu, is an
Overlay css does not name. **The two hierarchies together place all 25.**

**Mesa's variable kinds are FRP's with one addition.** `let` is a source
behavior; `const` and `$: name = expr` are derived; `var` is a **sample** —
reading a behavior at a moment without tracking it, which is the exact FRP
operation; `$: deps, handler` is an effect; a DOM or component event is an
Event in Elliott and Hudak's sense. The addition is the writable derived, which
is a lens and nothing in FRP.

---

## 3. The tree

The top fork is Norman's: **does it show something, or take something?** —
evaluation against execution. Every leaf ends in a construct the tree has, or is
marked where it has none.

```
does it SHOW something, or TAKE something?
│
├─ shows — output
│  ├─ one value of one row          → displayFor → Cell
│  ├─ many rows                     → a list: overview · filter · zoom · details
│  │                                   page.query · page.directives · resource.list()
│  ├─ where the person is           → a route — IFML's ViewContainer; sierra's file tree
│  ├─ what is happening now         → feedback: Progress · Spinner · Skeleton · Toast · Alert
│  └─ the frame holding the rest    → css containment: Frame › Page › Region › Block › Inline
│                                      Overlay beside it · Layout across it
│
└─ takes — input
   ├─ which interaction task?          (Foley 1984)
   │  ├─ select     → Select · Combobox · picker · MultiSelect · Checkbox · RadioGroup · Switch
   │  ├─ quantify   → NumberInput · Slider · DateTimeInput · @money / @scale → NO DEFAULT
   │  ├─ text       → Input · Textarea · CodeInput · JsonInput
   │  ├─ position   → GeoField
   │  ├─ path       → no instance
   │  └─ bytes      → FileField · FileUpload
   ├─ what does it change?
   │  ├─ a Signal on this screen       → screen-local; never crosses a Boundary
   │  ├─ a row                         → Resource: save · a named transition (x-transitions)
   │  └─ where the person is           → navigation
   └─ when does it commit?
      ├─ on submit                     → <Form>
      ├─ when typing stops             → <Form autosave> (FJS-D257)
      └─ at once                       → a control bound straight to a Signal
```

And the reactive branch, which sits under every leaf above rather than beside
them:

```
what is this value over TIME?                       (Elliott & Hudak 1997)
│
├─ it has a value at every moment → a Signal
│  ├─ someone sets it              → source      let
│  ├─ it is computed from others   → derived     const · $: name = expr
│  │  └─ and may be written back   → a lens      writable derived (Foster et al. 2007)
│  └─ read it without tracking     → a sample    var
│
└─ it happens at a moment          → an event — DOM or component; Junction's Event once it crosses the Boundary
   └─ what it causes               → an effect   $: deps, handler
```

**Four of these leaves are other papers' and are cited, not restated** — the
list's four verbs (`list-controller.md`), the frame tiers (`page-composition.md`),
the four facts about a call (`declared-interaction.md`), and the async boundary
(`derived-suspense.md`). What the tree adds is the ORDER, the top fork, and the
task level between a field and its control.

---

## 4. Candidate primitives

The words the tree needs, each already a leaf. **Proposed, not ruled.**

| Primitive | CAMELEON level | Prior art | In the tree as | Status in `VOCABULARY.md` |
| --- | --- | --- | --- | --- |
| **Resource** | abstract | IFML DataBinding | `createResource` | blessed |
| **Interactor** — input or output | abstract | CAMELEON abstract interactor; IFML ViewComponent | `controlFor` / `displayFor` — no noun | none, by ruling (`FJS-D388`) |
| **Interaction task** | abstract | Foley 1984 | `controlFor` answers `task` | blessed (`FJS-D384`) |
| **Component** | concrete | IFML ViewComponent; CAMELEON concrete interactor | a `.mesa` file; the kit | open |
| **Container tier** | concrete | IFML ViewContainer | css's eight tiers | blessed (`FJS-D384`) |
| **Signal** — source, derived, sample | — | FRP behavior | `let` · `const` · `var` | blessed (§ 2) |
| **Effect** | — | FRP; build systems | `$: deps, handler` | blessed (`FJS-D386`) |
| **Lens** | — | Foster et al. 2007 | writable derived | blessed as *Writable derived* (`FJS-D384`) |
| **Commit point** | abstract | — | submit · autosave · at once | the paper's word only; three spellings stay (`FJS-D389`) |

**Binding, § 2's other unnamed word, falls out rather than needing a name.** It
is the step from the abstract level to the concrete one — `controlFor` handing a
name to the registry and a component claiming it (`FJS-D17`'s two registrations).
Whether that step needs a noun of its own, or *binding* stays Mesa's `bind:`, is
§ Open questions.

---

## 5. What is actually missing

- **The task level is not in the code.** `controlFor` returns a control and no
  task, so a registered control (a money input) cannot say it answers *quantify*,
  and the kit cannot be asked *which techniques exist for select*.
- **`@money` and `@scale` have no default technique.** Deliberate per the reason
  string, and it is still the one task-with-a-type that a scaffolded form cannot
  render without app code.
- **Twenty-five UI terms sat under one umbrella** (moved by § 7 step 1) when a containment hierarchy
  for most of them is already written, checked against the CSSOM, and read by
  `fli ws:terms` for status but not for placement.
- **Screen-local state has no statechart.** A row's states reach the browser as
  `x-transitions`; a wizard's or a drawer's are ad hoc booleans in each file.
- **Path and orient have no instance.** Recorded as absent, not owed — a
  signature pad and a rotation handle are what they would be.

---

## 6. The nine, answered before the first edit

- **Another origin?** No. The leaves cite `list-controller.md`,
  `page-composition.md`, `declared-interaction.md`, `derived-suspense.md` and css's
  vocabulary, and restate none of them.
- **Concept budget?** At most three nouns — interactor, interaction task, and one
  for commit point — and each names a thing the code already does.
- **Whose complexity?** The problem's. Every UI toolkit that derives a form from a
  type makes the task choice; this one makes it silently.
- **Predictability?** Improves — which control a field gets becomes a two-step
  answer a reader can follow (type → task → technique) rather than a switch.
- **Derived, not restated?** The UI rows' `Under` can be READ from
  `packages/css/vocabulary.json`'s tiers rather than authored a second time.
- **One owner, and does it exist?** `controlFor` owns the field→control step and
  stays the owner; the task is a field on its answer, not a second function.
- **Boundary explicit?** Unchanged. Everything here is on the UI side of the Data
  boundary, and `x-gate` stays an affordance only (Invariant 6).
- **Failure proportional?** A wrong task is a worse control, not a wrong write.
  Nothing here refuses.
- **Wrong without anything saying so — what artefact?** For this paper, none.
  The task level becomes checkable when `controlFor`'s answer carries it and a
  test asserts every built-in control names one.

**Adjudication in tension** (§ IV): *familiarity vs. precision*, over every noun —
IFML's Event and DCI's Context arrive with meanings this framework already gave
elsewhere.

**Tier** (§ VII): Assessment. Dated, statused, never cited as behavior.

---

## 7. Build order

Each step lands on its own and is visible on `fli ws:terms`'s map before the
next is argued.

1. **Done 2026-09-25. UI rows take an `Under`** from the tree: a css tier for a
   container, a task for a control. Twelve `open` umbrella rows were added —
   `Interaction task` over Select, Quantify, Text and Position, and `Container
   tier` over Frame, Page, Region, Block, Inline and Overlay — and the 25 terms
   under Component moved beneath them, which leaves Component with no children.
   A control that css also tiers (Switch, Inline) goes under its task.
2. **Done 2026-09-25. `fli ws:terms` reads css's tiers as `Under`** for the
   terms css owns, so the first step's container half stops being authored. A
   UI row with a blank Under takes css's tier; a stated Under or another Home
   keeps its own. Fifteen tier cells left the file, `Base tier` and `Layout
   tier` were added, and 48 css-only terms now land on the tree.
3. **Done 2026-09-25. `controlFor` answers a `task`** beside `control`, and the
   registry lets a contributed control claim one. One field, one test over every
   built-in. The task is read off the column, so a registered control that
   states none inherits the table's. `@money` and `@scale` answer `quantify`
   with no control. `file` answers `select` for now, which leaves *is bytes a
   seventh task* open, since it can be changed in one line.
4. **Done 2026-09-25. A ruling for Component and Binding** in `ARCHITECT.md`
   § 2. Component is every `.mesa` file (`FJS-D382`), and the concrete level
   is said by placement rather than by a noun. Binding is Mesa's template
   binding (`FJS-D383`), and Deployment's `bindings` became *configuration*.
5. **Done 2026-09-25. Mesa's scheduler named** against *Build Systems à la
   Carte* in `packages/mesa/docs/VISION.md` § 4.7: dirty bit with early cutoff
   as the rebuilder, a restarting scheduler keyed on DOM depth with suspending
   reads. The paper has no word for the one thing Mesa adds, a task disposed by
   another task in the same flush.

---

## Open questions

- ~~**A noun for the interactor pair, or none?**~~ **Answered 2026-09-25 (`FJS-D388`): A — none. `controlFor` and `displayFor` stay two names and the sentence stays a sentence.** `controlFor` and `displayFor` work
  as two names, and a third word for their union may be concept budget spent on
  a sentence. The case for it is that the pair has one registry shape and one
  question — *what may stand for this field here* — and no word to ask it with.
  - **A** — none. `controlFor` and `displayFor` stay two names and the
    sentence stays a sentence
  - **B** — *Interactor*, CAMELEON's word, blessed for the union
  - **Recommend A** — no code asks the union question today, and a noun no
    call site spells is the concept budget § 6 capped at three
- ~~**Is `bytes` a seventh task?**~~ **Answered 2026-09-25 (`FJS-D387`): A — yes, `bytes` joins `INTERACTION_TASKS` and `File` columns answer it. `FileField` and `FileUpload` are its techniques, and a camera capture or a paste target would be the next.** Foley's list predates files as input. Folding
  it into *select* (a file is picked) fits the gesture and misses the payload.
  - **A** — yes, `bytes` joins `INTERACTION_TASKS` and `File` columns answer
    it. `FileField` and `FileUpload` are its techniques, and a camera capture
    or a paste target would be the next
  - **B** — no, a file is *select*. Four tasks stay four
  - **Recommend A** — the payload is what a technique must handle (size,
    type, progress), and a select control handles none of it. § 3's tree
    already draws the leaf
- ~~**Does Component name the concrete level only, or every `.mesa` file?**~~ **Answered 2026-09-25 (`FJS-D382`): B — every `.mesa` file. That is what the code already says: Mesa compiles components, `mount(label, Component)`, and Invariant 18 calls a resource file with no `<script module>` *a component in the wrong folder*. The concrete level gets no noun of its own, and a Component is placed by the umbrella it sits under instead: a Container tier for what holds things, an Interaction task for what edits a value.** A page
  is a `.mesa` component and it is not a concrete interactor — it is a container.
  The tree says two words; the codebase says one.
  - **A** — the concrete level only: Button, Combobox, Card, the things a
    control or a css term names. A page, a layout and a resource file are
    `.mesa` files and not Components. The tree gets its word, and the code has
    to find another one for *any `.mesa` file*
  - **B** — every `.mesa` file. That is what the code already says: Mesa
    compiles components, `mount(label, Component)`, and Invariant 18 calls a
    resource file with no `<script module>` *a component in the wrong folder*.
    The concrete level gets no noun of its own, and a Component is placed by
    the umbrella it sits under instead: a Container tier for what holds
    things, an Interaction task for what edits a value
  - **Recommend B** — steps 1–3 already answer *which level* by placement, so
    a second meaning for Component would name a distinction the tree already
    draws. B keeps the word every other framework uses for the file, and it is
    the only option that needs no code or doc to change
- ~~**What does Binding name?**~~ **Answered 2026-09-25 (`FJS-D383`): A — Mesa's: a template binding is a place in the output that re-runs when a signal it reads changes, and `bind:` is the two-way case. § 3.7's last hop is this sense, since a pushed row reaches the screen through one. The abstract → concrete step needs no noun, because `registerControl` and `registerFormControl` already name both of its halves.** § 2 lists it as *the reactive seam*, and the tree
  already spends the word five ways: Mesa's `bind:` (two-way), Mesa's *template
  binding* (RULE 3, the site that re-renders when a signal it reads changes),
  the last hop of § 3.7's *origin → event → channel → binding*, this paper's
  abstract → concrete step (`controlFor` naming a control and a component
  claiming it), and the Deployment realm's `bindings`, which is a Release's
  configuration (`packages/cli/core/release.js`).
  - **A** — Mesa's: a template binding is a place in the output that re-runs
    when a signal it reads changes, and `bind:` is the two-way case. § 3.7's
    last hop is this sense, since a pushed row reaches the screen through one.
    The abstract → concrete step needs no noun, because `registerControl` and
    `registerFormControl` already name both of its halves
  - **B** — the UI realm's seam between Resource and Component, as § 2 first
    meant it. This coins a meaning no code spells, and it would sit next to
    Mesa's sense
  - **C** — no ruled word. Strike it from § 2 *Not yet named* and let Mesa keep
    its own sense unruled
  - **Recommend A** — two of the five senses are already the same thing (the
    template binding and § 3.7's last hop), and a third (`bind:`) is a case of
    it. Deployment's `bindings` is renamed to *configuration*, the word
    `bindingsHash` was already commented with. Litestone's `@values` binding
    (how strictly a column holds to a value set) is a sixth sense, found while
    ruling, and it stays unruled for now
- ~~**Which word for a UI event?**~~ **Answered 2026-09-25 (`FJS-D385`): A — *Gesture*: what the person did, named for the person rather than the DOM. Collides with nothing in the tree.** `FJS-D44` gave Event to Junction. A click is an
  event in every other framework and every tradition in § 1. `declared-interaction.md`
  is the nearest paper; a ruling is owed before anything here is built.
  - **A** — *Gesture*: what the person did, named for the person rather than
    the DOM. Collides with nothing in the tree
  - **B** — *DOM event*: the qualified word. Familiar, and it names the
    mechanism rather than the act, so a component event is left out
  - **C** — *Action*: IFML's word. Collides with orion's actions and with a
    form's `action`
  - **Recommend A** — it sits on the TAKES branch where § 3 needs it, and
    both other words are already spent
- ~~**Is Effect the word for `$: deps, handler`?**~~ **Answered 2026-09-25 (`FJS-D386`): A — *Effect*, blessed: what every signal library calls it, and RULE 61 already orders user effects as a tier.** § 4 lists it absent, and
  VISION § 4.7 already calls it *a task nothing reads* in build-system terms.
  - **A** — *Effect*, blessed: what every signal library calls it, and RULE
    61 already orders user effects as a tier
  - **B** — *Reaction*: MobX's word, which avoids the React sense of effect
  - **Recommend A** — the word is already in Mesa's docs and runtime, and
    VOCABULARY holds none that competes with it
- ~~**Is the commit point one concept or three?**~~ **Answered 2026-09-25 (`FJS-D389`): B — three spellings, and *Commit point* is only the word the paper uses to say they are one question - **Recommend B until a diff says otherwise** — `now` inside a `<Form>` has no case yet, and A renames `autosave` to buy a symmetry nobody has reached for. Show A as code before choosing it.** Submit, `<Form autosave>` and a
  control bound straight to a Signal are the three leaves of § 3's *when does
  it commit?*, and each is spelled its own way.
  - **A** — one prop: `<Form commit="submit|idle|now">`, replacing `autosave`.
    One question with three answers, spelled once
  - **B** — three spellings, and *Commit point* is only the word the paper
    uses to say they are one question
  - **Recommend B until a diff says otherwise** — `now` inside a `<Form>` has
    no case yet, and A renames `autosave` to buy a symmetry nobody has
    reached for. Show A as code before choosing it
- ~~**Does screen-local state want `@@transitions`' shape?**~~ **Answered 2026-09-25 (`FJS-D390`): A — not yet. Stay open until a screen's booleans cause a defect.** A statechart in a
  `.mesa` file would be the second place a transition is declared, which is a
  cost, and the first place a wizard's states are visible, which is the reason.
  - **A** — not yet. Stay open until a screen's booleans cause a defect
  - **B** — yes, a `<script>`-level `transitions` declaration read the way
    `x-transitions` is
  - **Recommend A** — the largest item here and the least evidenced

---

## See also

- `IDEAS/ontology.md` — the Data realm's paper, whose shape this one takes
- `IDEAS/page-composition.md` — the containment tier css never built; the
  *frame* leaf
- `IDEAS/shipped/list-controller.md` — `resource.list()`; the *many rows* leaf
- `IDEAS/declared-interaction.md` — four facts about a call still in client glue;
  the *what does it change* branch
- `IDEAS/derived-suspense.md` — async boundaries from the dependency graph
- `packages/css/vocabulary.json` — the tiers § 2 reads
- `packages/sierra/src/resource/field-rules.js` — `controlFor`, `displayFor`
- `packages/mesa/docs/VISION.md` §§ 2, 4 — the variable kinds and `$:`
- `FJS-D38` · `FJS-D44` · `FJS-D17` · `FJS-D257` · `FJS-D06` § 3
