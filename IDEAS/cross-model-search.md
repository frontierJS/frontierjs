---
id: cross-model-search
status: proposed
dated: 2026-10-13
---

# Cross-model search — one index, one graded query, one ranked list

**Status: PROPOSED, and not owed yet.** Dated 2026-10-13, replacing the
2026-10-12 draft that recommended a client-side composition (its option D,
kept below as the shape it was priced against). Do not cite as behavior —
see `VERIFYING.md`.

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

- **Text is indexed twice** while the per-model `_fts` tables stay. Later the
  per-model `search()` can read `_search WHERE model = ?` and drop its own
  table; that is a second change and not this one.
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
`FJS-D##` recording that `$search` spans models over one index, citing Q4's
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
- **Per-model `search()` over `_search`.** If it works, the per-model tables
  go and the index is written once. Priced after E lands, not with it.

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

Verdict: **build E.** The ruling is owed with it.

## When it is owed

**The trigger is the maid.tech `SearchAll` port**, the third app to write the
service. Port it with A first, as linear did, fixing the reference bugs ELA's
PLAN files as D152 (an empty term returns every client and lead; each of four
searches clears `searching` when its own call ends). The one-index measurement has
run and passed (above), so the port builds E rather than a fourth copy of A;
D stays here as the shape E was priced against.
