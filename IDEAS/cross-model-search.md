---
id: cross-model-search
status: proposed
dated: 2026-10-12
---

# Cross-model search — derived from what the schema already says

**Status: PROPOSED, and not owed yet.** Dated 2026-10-12. Do not cite as
behavior — see `VERIFYING.md`. It records the cheapest shape a framework-owned
⌘K could take, so the app that writes the third copy prices against it rather
than against a new attribute.

One search box that finds a client, a task and a property in one list. Every
app with a shell wants it, and so far every app has written it by hand.

## Already settled — do not reopen

linear's PLAN Q4 (`fjs-prototypes/linear/PLAN.md`, answered 2026-09-22, rebuilt
on `@@fts` 2026-10-04) and `stressors.md` § 3 hold the measurements. What they
settled:

- **Across models, search is not a verb.** bm25 scores against one index's own
  term statistics: identical text scored −0.981 as an issue title and −3.287 as
  a comment body. A list merged on rank is ordered by which TABLE a hit sits in.
  So hits are **grouped by kind and ranked within a kind**, and `FJS-D333`'s
  *search is its own verb* survives because of this.
- **One graded `search()` per model is the only safe spelling.** It puts the
  policy inside the FTS query (`FJS-262`). Both shorter spellings were measured
  wrong: one ranked `UNION` returned 20 of 20 rows the caller may not read, and
  rank-then-grade spent the limit on decoys and lost the caller's real hits.
- **A second caller did not change the answer.** remnant spans `Verse`, `Word`
  and `Lemma` with three calls in one service: *the spanning verb is still not
  owed*.

## What every caller wrote

| App | Kinds | Under `@@fts` | Not under `@@fts` | Where a hit goes |
| --- | --- | --- | --- | --- |
| linear | issue, comment, project, person | the first three | person: `Membership.displayName` `contains` | a comment opens its ISSUE, by `issueId` |
| remnant | verse, word, lemma | all three | — | its own page |
| maid.tech (reference `SearchAll.svelte`, not ported) | client, lead, task, board | the port has `Contact`, `Property`, `Task` | board: matched by the name of a related row | `/clients/[clientId]` and siblings |
| ELA (same ancestor, not ported) | as maid.tech | `Client`, `Task`, `Property`, `Crew`, `Message`, `Asset` | as maid.tech | as maid.tech |

Two facts come out of the table, and both shape the proposal:

1. **Every app with a palette searched a kind that has no `@@fts`.** Anything
   the framework derives covers SOME of the palette, never all of it, so it
   has to compose with sources the app writes.
2. **The link is not always the row's own page.** A comment links to its issue.
   Where a hit goes is a UI fact, and sometimes a relation, not a function of
   the model alone.

## What already exists to derive from

| Piece | Owner | Answers |
| --- | --- | --- |
| `x-search` (`FJS-D249`) | litestone `jsonschema.js` | which models answer `$search`, and over which columns |
| `x-label-field` / `labelFieldInfo` | litestone emit, sierra `resource.js` | the column that names a row: the hit's title |
| `x-identify` | litestone emit | the business key a person recognizes: a candidate for the hit's subtitle |
| `resource.filters().search` | sierra | the model's search answer, or a refusal with a reason |
| `$search` on each service's `find` | junction → `table.search()` | a graded, ranked page of one model, over the wire |
| `CommandPalette`'s `search(query, signal) => Item[]` | `@frontierjs/ui` | drawn as given, unranked; `Item` is `{ id, group, label, sub, action }`; aborts a stale search |

**Every input a derived palette source needs is already emitted except the
link.** The display contract is already in the kit.

## The options

- **A — Status quo: the app composes N `search()` calls** in one service and
  groups by kind (linear's `search.service.ts` is the reference). It costs one
  service per app, and the copies are near-identical.
- **B — `@@searchable(title: …, subtitle: …, link: …)` on each model.**
  *Refused:*
  - `link:` is a route, and a route is the UI realm's. The Data seed would be
    naming URLs.
  - `title:` restates `@@label` and the model list restates `@@fts`: two origins
    for two facts that already have one each.
  - `-able` is the suffix the REFUSAL keys wear, and `FJS-D249` refused
    `x-searchable` for exactly that misreading.
  - It cannot include a kind with no `@@fts`, which every real palette has.
- **C — A derived server endpoint**: junction mounts a `/search` that fans out
  over every `@@fts` model through `$.db`. One round trip per keystroke, but:
  - It is a new API-side owner for a composition an app can already write.
  - "Every `@@fts` model" is the wrong default. ELA indexes `Message` bodies,
    and whether mail belongs in the shell's palette is the app's call. An
    opt-out means new syntax, which is B again.
  - A non-`@@fts` kind still cannot join, and the link still lives on the client.
- **D — A derived CLIENT source (recommended, when owed).** A sierra function
  takes the resources the CALLER names and answers a `CommandPalette` `search`:
  - **Kinds:** the resources passed in, so inclusion is a call-site list and
    needs no schema word.
  - **Query:** one `find(..., { $search })` per resource, each graded by its
    own service exactly as today.
  - **Group:** the model's label. **Title:** `x-label-field`. **Subtitle:**
    `x-identify` where the model declares one.
  - **Link:** a function per resource that the app supplies, because only the
    app knows that a comment opens its issue.
  - **Extra kinds:** an app-written source for a kind with no `@@fts` (people,
    boards) joins as another entry in the same list.

  D adds no syntax and no server owner. It moves the app's composition out of
  its service and into one function over pieces that already exist.

## The nine, answered for D (2026-10-12, before writing)

1. **Origin** — none new: kinds come from the call site, title from `@@label`,
   subtitle from `x-identify`, columns from `@@fts`. The link is the app's, and
   it has one origin there.
2. **Concept budget** — no new noun. It is a function that answers an existing
   contract (`CommandPalette`'s `search`).
3. **Complexity** — the problem's: N graded calls grouped by kind is what the
   measurements require. D adds no machinery beyond that.
4. **Predictability** — a hit's title is the same label a picker and a table
   already show for that row, so the palette cannot disagree with the screens.
5. **Derived** — yes, except the link, which is a UI fact with no Data source
   to derive it from.
6. **Owner** — sierra, beside `filters()`, which already owns *does this model
   answer `$search`*. The kit stays free of a sierra import; it receives
   `Item[]`.
7. **Boundary** — the `search(query, signal)` signature `CommandPalette`
   already names. A resource without `@@fts` is refused by name when the source
   is built, reusing `filters().search.reason`.
8. **Failure** — one kind failing must not blank the palette. Its group is
   dropped with its error, and the other groups still draw.
9. **Silence** — *what must stay true:* a hit is never a row the caller may not
   read. *What fails when it stops:* each call is that service's own graded
   `find`, so the per-model grading test linear already runs (`verify:search`)
   covers it. No new test grades it. *What else can be wrong in silence:* a
   short-word search returns `_rank: null` in row order (`FJS-2332`'s fallback),
   which an ordering by rank would misplace. Its artefact is **none** until D
   is built.

**§ IV:** *paved road vs. the workaround*. Three copies of the same service is
the measurement the road is owed. Until then it is an edge case, and the
proposal waits for the measurement rather than anticipating it.

**§ VII tier:** Assessment, so this paper. A ruling is owed only if D is built.

## Open, for whoever builds it

- **N calls per keystroke.** Over a connected socket these are frames on one
  connection. Over HTTP each call resolves the caller again; linear measured 4
  extra queries for that in one service. Measure before choosing. `db.query(spec)`
  batching N `search` entries is the server-side alternative, and today it
  refuses a `search` key by name (`FJS-1310`).
- **Offline.** linear found that a model-less search service is never kept on
  the device, so ⌘K offline answers nothing. D runs per resource, so a local
  database could answer each `$search` itself. That is unmeasured.
- **The subtitle.** `x-identify` is emitted only where something identifies a
  row (an email, a code). A model with none gets no subtitle. Find out whether
  that reads as a defect on a real screen before inventing a fallback.

## When it is owed

**The trigger is the maid.tech `SearchAll` port**, the third app to write the
service (ELA's copy shares maid.tech's ancestor and is not counted separately).
Port it with A first, the way linear's service does it, and fix the reference
bugs ELA's PLAN files as D152 on the way: an empty term returns every client and lead, and
each of four searches clears `searching` when its own call ends. If the
port's code reads as linear's with the names changed, extract D from it. If it
does not, record here what differed.
