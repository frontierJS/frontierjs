---
id: cross-model-search
status: shipped
dated: 2026-10-13
---

# Cross-model search — one index, one graded query, one ranked list

**Status: SHIPPED 2026-10-14, all of Phases 0–4, ruled
[`FJS-D970`](../../DECISIONS.md#fjs-d970).** Dated 2026-10-13, replacing the
2026-10-12 draft that recommended a client-side composition (its option D,
kept below as the shape it was priced against). **This file is the ARGUMENT,
not the reference**: the behavior is litestone's `$search`
(`packages/litestone/docs/full-text-search.md`), junction's `searchService`
and sierra's `paletteSource`, and `search-spanning.test.ts` is what holds it.
4.3 priced dropping the per-model `_fts` tables and refused it; they stay.

One search box that finds a client, a task and a property in one list. Every
app with a shell wants it, and so far every app has written it by hand.

## What was settled, and the premise it stood on

linear's PLAN Q4 (`fjs-prototypes/linear/PLAN.md`, answered 2026-09-22, rebuilt
on `@@fts` 2026-10-04) and `stressors.md` § 3 hold the measurements:

- bm25 scores against one index's own term statistics: identical text scored
  −0.981 as an issue title and −3.287 as a comment body. A list merged on rank
  across two indexes is ordered by which TABLE a hit sits in.
- **One graded `search()` per model is the only safe spelling over per-model
  indexes.** A ranked `UNION` returned 20 of 20 rows the caller may not read;
  rank-then-grade spent the limit on decoys and lost the caller's real hits.

Both findings are about **per-model indexes**, and that is the premise this
paper moves. One FTS5 table holding every model's rows has one vocabulary and
one length normalization, so bm25 over it IS one scale — the `multisearch`
documents-table pattern every shipped ⌘K uses. The grading finding is kept as
written: whatever the index, the policy goes INSIDE the query, before the
limit. Nothing in `FJS-D333` is overturned: `search()` keeps its verb because
FTS5 is still a different engine on a different table, and so is this.

## What every caller wrote

| App | Kinds | Under `@@fts` | Not under `@@fts` | Where a hit goes |
| --- | --- | --- | --- | --- |
| linear | issue, comment, project, person | the first three | person: `Membership.displayName` `contains` | a comment opens its ISSUE, by `issueId` |
| remnant | verse, word, lemma | all three | — | its own page |
| maid.tech (reference `SearchAll.svelte`, not ported) | client, lead, task, board | the port has `Contact`, `Property`, `Task` | board: matched by the name of a related row | `/clients/[clientId]` and siblings |
| ELA (same ancestor, not ported) | as maid.tech | `Client`, `Task`, `Property`, `Crew`, `Message`, `Asset` | as maid.tech | as maid.tech |

Three facts come out of the table:

1. **A kind without `@@fts` is in every palette.** Read again, the people case
   is a model that should carry `@@fts([displayName])` and does not: the
   search is a `contains` over one column. The board case — matched by a
   RELATED row's name — is real and stays the app's.
2. **The link is not always the row's own page.** A comment opens its issue.
   Where a hit goes is a UI fact, and sometimes a relation.
3. **Every copy is N calls, a group per kind, and a title picked by hand** —
   linear's `label()` is a `switch` over the model name restating `@@label`.

## What already exists to derive from

| Piece | Owner | Answers |
| --- | --- | --- |
| `@@fts([...])` → `createFts` | litestone `ddl.js` | the per-model index and the three triggers that keep it current |
| `visibleWhere(op, where)` + the correlated `EXISTS` | litestone `client.js` `search()` | the global filter, soft-delete, tenant filter and row policy, folded once and applied BEFORE the limit (`FJS-262`, `FJS-1692`) |
| `@@label(field)` → `x-label-field` | litestone parser, `jsonschema.js` | the column that names a row: the hit's title |
| `x-identify` | litestone `jsonschema.js` | the business key a person recognizes: the subtitle |
| `x-search` (`FJS-D249`) | litestone `jsonschema.js` | which models answer `$search` at all |
| `CommandPalette`'s `search(query, signal) => Item[]` | `@frontierjs/ui` | drawn as given; `Item` is `{ id, group, label, sub, action }` |
| `fli make:resource` routes | cli | `<plural>/[id].mesa`, so a row's page is derivable from its model name |

**Every input is already emitted except the link, and the link has a derivable
default.**

## The options

- **A — Status quo: the app composes N `search()` calls** in one service and
  groups by kind (linear's `search.service.ts` is the reference). One service
  per app, near-identical copies, a title `switch` per copy.
- **B — `@@searchable(title: …, subtitle: …, link: …)` on each model.**
  *Refused:* `link:` is a route in the Data seed; `title:` restates `@@label`
  and the model list restates `@@fts`; `-able` is the refusal suffix
  (`FJS-D249`).
- **C — A junction `/search` that fans out N per-model `search()` calls.** A
  new API-side owner for a composition an app can already write, and the
  answer is still grouped, never ranked.
- **D — A sierra function that makes N graded `find({ $search })` calls and
  groups the answer** (the 2026-10-12 recommendation). No syntax, no server
  owner — but N round trips and N caller resolutions per keystroke (linear
  measured 4 extra queries per call over HTTP), a grouped list where a ranked
  one was wanted, and nothing a device can answer offline, since each call is
  a service.
- **E — One shared index in litestone, graded in one query (recommended).**

## E, in detail

**Data.** Beside the per-model `<table>_fts`, litestone emits one virtual
table and, per `@@fts` model, the same three triggers `createFts` already
writes:

```sql
CREATE VIRTUAL TABLE "_search" USING fts5(model UNINDEXED, rid UNINDEXED, title, body)
```

`title` is the row's `@@label` column, `body` the `@@fts` columns joined. No
new schema word: a model is in the index because it declares `@@fts`, and its
title is the column `@@label` already names. A `@@fts` model with no `@@label`
is refused at parse time with the fix in the message, in the voice `@@label`'s
own refusals use.

**Verb.** `db.$search(q, { models?, limit, offset, prefix })` on the client,
beside `$transaction`. One SQL: `MATCH` over `_search`, ordered by
`bm25(_search, <title weight>, 1.0)`, narrowed BEFORE the limit by

```sql
AND (  (model = 'issue'   AND EXISTS (SELECT 1 FROM "issue"   WHERE rowid = _search.rid AND <issue's visibleWhere>))
    OR (model = 'comment' AND EXISTS (SELECT 1 FROM "comment" WHERE rowid = _search.rid AND <comment's visibleWhere>)) …)
```

— each branch is what that model's own `search()` builds today, so the
grading has one owner and the two cannot drift. A hit is
`{ model, id, title, sub, _rank, _snippet }`, title and snippet from the index
and `id`/`sub` from a second read keyed on `rid`, the step `search()` already
has. `models` narrows with `model IN (…)`; the default is every `@@fts` model.

**Wire.** A junction `search` service with one method, `find({ q, models })`,
calling `$.db.$search`. Mounted by the app the way `account` is, and the
mount is where the app says which models the palette holds — *should ELA's
mail be in ⌘K* is answered at the call site, not with syntax. Junction adds
the route and nothing else; the grade is litestone's (Invariant 6).

**Offline.** The triggers run under `sqlite-wasm` as they do under
`bun:sqlite`, so a device holding the models holds the index, and the palette
answers with no socket. D could never do this; it is the strongest reason the
owner is litestone and not sierra.

**UI.** A sierra `paletteSource(client, { models, link })` answering
`CommandPalette`'s `search`. Group is the model's label, title is `title`,
subtitle is `sub`. The link defaults to `/<plural>/<id>` — the route
`fli make:resource` scaffolds — and the app overrides the ones that go
elsewhere: `{ comment: h => '/issues/' + h.parentId }`. A kind the index does
not hold (maid.tech's board by related name) is an app-written source
appended to the same `Item[]`.

**What D cost that E does not.** N calls and N auth resolutions per keystroke;
a grouped list; no offline answer; the composition still in the app.

## What E costs, stated

- **Text is indexed twice**, and the per-model `_fts` tables stay: 4.3 priced
  reading `_search WHERE model = ?` instead and it does not hold (Plan 4.3).
- **One tokenizer for the whole index.** Two models under different
  `tokenize` disagree. First answer: `_search` is `trigram`, so a short word
  is a match rather than the `GLOB` fallback of `FJS-2332`; measure before
  choosing.
- **The title weight is a number**, measured below: 3 is enough, 10 is the
  margin. **`bm25()` weights are positional over EVERY declared column,
  `UNINDEXED` ones included** — with `(model, rid, title, body)` the title's
  weight is the THIRD argument, and `bm25(_search, 10, 1)` weights `model`,
  silently changing nothing. The first run of the measurement did exactly
  that. The builder puts the weight by column name, never by hand.
- **The differ** learns `_search`: a model gaining or losing `@@fts` adds or
  drops its triggers, and a changed `@@label` or `@@fts` list rebuilds the
  rows for that model.
- **A short-word-only query** has `_rank` null and sorts last; a test asserts
  the placement.

## The nine, answered for E (2026-10-13, before writing)

1. **Origin** — none new. Membership comes from `@@fts`, the title from
   `@@label`, the subtitle from `x-identify`, the grading from each model's
   `visibleWhere`. The link's default derives from the model name; an
   override has one origin, the app.
2. **Concept budget** — one verb, `$search`, which the language already has
   per model; this is the same verb one level up. No noun.
3. **Complexity** — the problem's: one index is what a ranked answer across
   kinds REQUIRES, and the per-model grading is already written. E adds
   triggers of a shape that exists and one SQL that composes branches that
   exist.
4. **Predictability** — `$search` takes what `search()` takes (`prefix`,
   `limit`, `offset`), returns `_rank` and `_snippet` under the same names,
   and a hit's title is the label a picker and a table already show.
5. **Derived** — yes, index membership, title, subtitle, grading and the
   default link. The one hand-written fact is an overridden link.
6. **Owner** — the grade stays in litestone's `search()` machinery (Invariant
   4: add to the owner). Junction owns the route, sierra the link, the kit
   the drawing. `bridge-index` names no existing spanning read, so none is
   bypassed.
7. **Boundary** — a caller names models and a query. A model outside
   `@@fts` is refused by name (`CapabilityNotDeclaredError`, as `search()`
   does); a `@@fts` model without `@@label` is refused at parse. The caller
   never needs to know which branch graded which hit.
8. **Failure** — one SQL, so there is no "one kind failed, the rest drew";
   either the query answers or it throws. That is the right shape: a palette
   that silently drops a kind reads as *no hits*.
9. **Silence** — *must stay true:* a hit is never a row the caller may not
   read, and the limit is spent only on readable rows. *What fails when it
   stops:* a test under `packages/litestone/test/` that seeds two models
   with a row policy, searches as a caller who may read half, and asserts
   both the count and that no `_rank` is spent on a decoy — linear's
   `verify:search` leak/starvation measurement, moved into the owner.
   *What else can be wrong in silence:* a title weight that lets bodies
   outrank titles; its artefact is the rerun measurement above, recorded in
   this paper, and **none** in CI until a number is chosen.

**§ IV:** *paved road vs. the workaround* — three copies of the same service
is the measurement the road is owed; and *doctrine vs. discovery* — the
settled "not comparable" finding was true of its premise and the premise is
what changed, so this is a hearing on the measurement, not a reopening of the
ruling.

**§ VII tier:** Assessment, so this paper. Building E is a ruling: an
`FJS-D970` records that `$search` spans models over one index, citing Q4's
measurement and its premise.

## Open, for whoever builds it

- **Tokenizer**: `trigram` for `_search` regardless of the models' own, or
  refuse mixed tokenizers at parse. The measurement ranks the same under
  both; a two-letter word matches nothing under `trigram` (0 rows) and two
  rows as a `unicode61` prefix, so `FJS-2332`'s scan fallback is owed either
  way.
- **The subtitle.** `x-identify` is emitted only where something identifies a
  row. A model with none gets no `sub`; see whether that reads as a defect on
  a real screen before inventing a fallback.
- **Per-model `search()` over `_search`** — priced in 4.3 and refused; the
  per-model tables stay.

## The gate, run (2026-10-13)

One `_search(model UNINDEXED, rid UNINDEXED, title, body)` built from a copy
of linear's `db/app.db` (49 issues, 6 comments, 1 project — a small corpus),
plus Q4's planted pair *quasar lattice* as an issue title and as a comment
body, a title holding the words among others, and a long body holding them
twice. Scores are bm25, lower is better.

| Title weight | `quasar lattice` title | bare body | title + 4 words | long body | Order |
| --- | --- | --- | --- | --- | --- |
| 1 | −6.925 | −6.925 | −4.399 | −3.814 | tie, then by length — one scale |
| 3 | −9.257 | −6.925 | −7.371 | −3.814 | both titles over both bodies |
| 10 | −10.495 | −6.925 | −9.655 | −3.814 | same, wider |

- **One scale.** The identical text that scored −0.981 and −3.287 on two
  indexes scores −6.925 and −6.925 on one. Q4's finding was the premise, and
  the premise is gone.
- **Titles win at 3.** A title of four other words still outranks a body that
  is the bare phrase; a word the corpus has only in bodies (*flamingo*) ranks
  bodies by length, as it should. *board* puts both titled issues over the
  long comment under every weight.
- **`trigram` and `unicode61` agree** on every order above (−10.43 vs −10.495
  at the top).
- **Not measured:** a corpus large enough for term statistics to matter, and
  the grade (one query with a policy branch per model). The grade is
  construction, and its test is § nine, 9.

The spanning test's fixture reran it with 40 decoys sharing one word (`quasar`), the four planted rows under `trigram`:

| Title weight | `quasar lattice` title | title + 4 words | bare body | long body | Order |
| --- | --- | --- | --- | --- | --- |
| 3 | −2.732 | −2.036 | −2.046 | −1.325 | **bare body over the long title** |
| 5 | −2.932 | −2.356 | −2.046 | −1.325 | both titles over both bodies |
| 10 | −3.141 | −2.748 | −2.046 | −1.325 | same, wider |

`unicode61` held at 3 (−2.215 against −2.011). So the two tokenizers do not agree once a word is common, and the weight is 10 — the margin above, now the artefact `search-spanning.test.ts` grades.

Verdict: **build E.** The ruling is `FJS-D970`, weight amended to 10.

## Plan

### Phase 0 — Ruling and the fixture

Goal: the decision is written and the leak test exists before any index does.
Done when: `fli decisions` lists nothing for this paper and the new test fails for want of `$search`.

- [x] 0.1 `FJS-D970` in `DECISIONS.md`: `$search` spans models over one shared index; cites Q4's premise and the gate table above. Records `_search` is `trigram` whatever the models' own tokenizers, and the title weight 3 by column index.
- [x] 0.2 `packages/litestone/test/search-spanning.test.ts`: two `@@fts` models with a row policy, a caller who may read half, Q4's planted pair. Asserts: no hit the caller may not read; the limit is spent only on readable rows; a title outranks a body; a short-word-only query sorts last with `_rank` null.
  - Red on 7 of 7 for want of `$search`; the schema (`@@fts` + `@@label` on two policied models) builds.

### Phase 1 — Data

Goal: every `@@fts` model is in `_search`, kept current by triggers, and `db.$search` answers graded and ranked.
Done when: 0.2 is green under `bun:sqlite` and under the sqlite-wasm drive.

- [x] 1.1 Parser: a `@@fts` model without `@@label` is refused with the fix in the message, in `@@label`'s own refusal voice.
- [x] 1.2 `ddl.js`: `_search(model UNINDEXED, rid UNINDEXED, title, body)` beside `createFts`, and per model the same three triggers (plus the soft-delete pair where declared).
- [x] 1.3 Differ: a model gaining or losing `@@fts`, or changing `@@label` or its `@@fts` list, adds or drops its triggers and rebuilds its rows in `_search`.
- [x] 1.4 `client.$search(q, { models, limit, offset, prefix })`: `MATCH` over `_search`, one `EXISTS` branch per model from `visibleWhere`, `bm25` weight 3 placed by column index, step-2 read keyed on `rid` for `id` and `sub`, `FJS-2332`'s scan fallback. A model outside `@@fts` or outside the schema is refused by name.
- [x] 1.5 `db:explain @@fts`, the catalog snapshot and `docs/traits.md` say `_search` exists and what `$search` returns.
- [x] 1.6 sqlite-wasm drive: the triggers fire and `$search` answers in the browser engine.

### Phase 2 — API

Goal: one round trip per keystroke, graded by the Data boundary.
Done when: a junction test mounts the service with two of three models and the third is refused by name.

- [x] 2.1 `search` service, `find({ q, models })` → `$.db.$search`, mounted the way `account` is; the mount names the models the palette holds.
  - `searchService({ models, name })` at `@frontierjs/junction/search`, registered with `app.services.register`. `q` and `models` are reserved query keys; any other key is a 400 by name, an empty `q` answers `[]`, `prefix` is always on.
- [x] 2.2 `models` outside the mount list refused by name, in the same voice as 1.4.
  - `junction/test/search-service.test.ts`: two of three `@@fts` models mounted, the third a 400 naming it over HTTP and internally. A mounted model without `@@fts` answers litestone's `CapabilityNotDeclaredError` (400) on the first call.

### Phase 3 — UI

Goal: a palette is one call with a link map.
Done when: `paletteSource` answers `CommandPalette`'s `search` with a default link and an override, under test.

- [x] 3.1 sierra `paletteSource(client, { models, link })` → `Item[]`: group is the model's label, title and `sub` from the hit, link defaults to `/<plural>/<id>` and the override map wins.
  - `@frontierjs/sierra/resource`, `src/resource/palette-source.js`. Group is `humanize(pluralize(model))` (`Issues`, `Product Variants`) since the schema carries no model-level label; item ids are `search:<model>:<id>` so they cannot collide with an app's own items. A hit carries only `{ model, id, title, sub }` — no `parentId` — so a `link` may answer a promise, and linear's comment → issue override in 4.1 is a read. A `link` key outside `models` is refused at construction. `test/palette-source.test.js` runs a real client against a spawned `searchService` (`fixtures/palette-source-server.ts`, port 7928).
- [x] 3.2 `exports.snapshot.md` and sierra's `README.md` name it.
  - README § Search and an `AGENTS.md` wrong-guess row. `exports.snapshot.md` lists entry points, not names, and `./resource` is already there — `fli ws:exports` regenerates with no diff. Writing it found `FJS-2841`, closed: the default link is `serviceNameFor(model)` lowercased, and the cli's plural copies became toolbelt's, so it is the route `fli scaffold` writes.

### Phase 4 — Prove

Goal: the two real palettes run on E and the copies are gone.
Done when: `fli proves --from main` names drives that have run, and `fli done` lists nothing.

- [x] 4.1 linear: `search.service.ts` replaced by the mount and `paletteSource`; `comment` overrides to its issue; `Membership @@fts([displayName])` puts people in the index. `web/test/verify-search.mjs` green, and its timing row added to the Q4 table in `docs/plan-done.md`.
  - The mount is one line in `api/src/app.ts`; `SearchPalette.mesa` is `paletteSource` with three links, two of them a one-column read (a comment's `issueId`, a membership's `userId`). `Comment` gained `@@label(body)`, which 1.1 now demands. `verify:search` 15/15, `verify-screens` § ⌘K green in Chrome. Timing: 1 MATCH + 1 read per model that hit, 3-4 ms rare, 10-14 ms common, 69-97 ms for two letters at 15k rows.
  - Found `FJS-2843`, closed: the per-model resolve read was invisible to the query tap.
  - Accepted by the owner: Membership is `@@tenant(none)` and reads the caller's own rows in every workspace, so Ana finds herself once per workspace. The hand service had filtered `workspaceId`; `$search` takes no `where`.
  - Read on a real screen, for § Open: an issue hit has no `sub` (Issue's key is `@@unique([teamId, number])`, and nothing emits `x-identify` for it), so the team key the hand palette showed is gone; people group as *Memberships*, since a group is the model's plural; under `trigram` *ana* matches *Kai Tanaka* and ranks it above *Ana Ribeiro*.
- [x] 4.2 maid.tech `SearchAll` port on E; the board-by-related-name source appended as the app's own entry. ELA's D152 bugs cannot recur (no per-kind `searching`, an empty term answers nothing).
  - The mount is `api/src/services/search.service.ts` (`contact`, `task`, `property`), autoloaded, so `api/test/search.test.ts` runs the app's own list. `web/src/components/SearchAll.mesa` is `paletteSource` with no link override (each model's page is the scaffolded route), the board source a `lists` read on `name contains` with `populate: board`, and the reference's Enter-to-create a `New task: …` row fed by `onquery`. Opened with ⌃J, as the reference was, and ⌘K. The port's schema already carried `@@fts` + `@@label` on all three; its migrations had no `_search` (`20261014074005_shared_search.sql`).
  - D152 cannot recur: one call, so one `searching`, the palette's; an empty or blank box answers `[]` (graded in `search.test.ts`).
  - Found, ruled by the owner and amended into `FJS-D970`: one model the caller's Role may not read made the whole `$search` a 403. A refused model now holds no hit; refused by every model, the first refusal stands. `search-spanning.test.ts` § a model the caller may not read.
  - `web/test/verify-search.mjs` 13/13 in Chrome on a copy of the dev db: the owner finds contacts and boards, opens a contact, makes a task from the words; the Closer (`Contact.read` alone) gets contacts and no boards, with nothing drawn as an error; the Site Manager sees the refusal by name. `search.test.ts` 8/8, typecheck and lint clean.
  - Read on the real screen, for § Open: a contact hit has no `sub`, so a lead and a customer look alike where the reference's badge said which; a completed task is a hit, where the reference filtered `completedAt: null`; the Site Manager's refusal is the capability sentence, worded for a developer; the `New task` row is offered to a Role without `Task.create`, as every create button in the port is.
- [x] 4.3 Per-model `search()` over `_search WHERE model = ?` priced: if it holds, a follow-up paper drops the per-model tables.
  - **It does not hold, and no follow-up paper is owed.** Measured on a copy of remnant's `db/app.db` (31,100 verses, 443,808 words, 20,602 lemmas, all `unicode61`), with `_search` built as `ddl.js` emits it. Median of 7, step 1 only, `LIMIT 20`:

    | Model | Words | Per-model ms (hits) | `_search` trigram ms (hits, top 20 shared) | Same index under `unicode61` ms (hits, top 20 shared) |
    | --- | --- | --- | --- | --- |
    | verse | god | 34.4 (3864) | 74.9 (4092, 15/20) | 46.8 (3864, 18/20) |
    | verse | shepherd | 0.6 (60) | 19.9 (105, 10/20) | 1.2 (60, 20/20) |
    | verse | H0430 | 16.8 (2247) | 73.9 (2247, 16/20) | 30.3 (2247, 15/20) |
    | lemma | god | 0.2 (16) | 34.1 (29, 12/16) | 97.0 (16, 16/16) |
    | lemma | love | 0.4 (16) | 14.0 (31, 8/16) | 6.0 (16, 16/16) |
    | lemma | H0430 | 0.1 (1) | 66.0 (1, 1/1) | 26.7 (1, 1/1) |

  - **Speed: a small model pays for the big one's postings.** `model` is `UNINDEXED`, so it filters after the MATCH has walked every model's hits: 20–660× on `lemma` beside 444k words. That half is fixable: `model` as an indexed column narrowed inside the MATCH (`{model} : "lemma" AND …`, weight 0) answers in 2–8 ms under `unicode61` and 6–14 ms under `trigram`. `$search({ models })` narrows the same way and pays the same cost — `FJS-2845`.
  - **What it cannot keep is why it fails.** Of 25 `@@fts` declarations across the prototypes, 16 are not `trigram` (8 `porter`). One `_search` has one tokenizer: `porter`'s stems and `unicode61`'s word boundaries are gone, and *shepherd* finds 105 verses where it found 60. Its columns are `title` and `body`, so ELA's raw column filters (`{phone phoneDigits} : …`, `{address1} : …` in `clients.service.ts`) and portal's `snippet: { field: 'quote' }` have nothing to name. And bm25 over the whole corpus, with the title at 10, reorders a model's own list: 8 to 19 of the top 20 kept under `trigram`, 15 to 20 even under the model's own tokenizer.
  - **What dropping would save is small.** `_search` stores its text (no single content table to point at): 217 MB under `trigram` against 41 MB for the three external-content `_fts` tables, beside 283 MB of rows. The write saved is one FTS insert per row.
  - Found pricing it: `ela`, `portal` and `remnant` no longer parse — 9 `@@fts` models without `@@label`, refused by 1.1 (`FJS-2844`).

## When it is owed

**The trigger is the maid.tech `SearchAll` port**, the third app to write the
service. Port it with A first, as linear did, fixing the reference bugs ELA's
PLAN files as D152 (an empty term returns every client and lead; each of four
searches clears `searching` when its own call ends). The one-index measurement has
run and passed (above), so the port builds E rather than a fourth copy of A;
D stays here as the shape E was priced against.
