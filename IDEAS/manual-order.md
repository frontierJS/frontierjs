---
id: manual-order
status: proposed
dated: 2026-09-22
---

# Idea — A position a person drags, declared on the column

**Status: PROPOSED.** Measured in the linear stressor (Phase 4, Q3):
`fjs-prototypes/linear/web/test/verify-order.mjs` (50 concurrent drags over
HTTP, in-process so junction's broadcast telemetry can be counted) and
`web/test/verify-order-offline.mjs` (one device offline in a real browser,
Chrome and Firefox against the build and `vite dev`, **identical in all four
cells**). Every claim marked *measured* was run there on 2026-09-22; *read*
means a source file says so. Decision row: [`FJS-D366`](../ISSUES.md#fjs-d366).
Prior record: `ecosystem-gaps.md` § 15 (*user-defined ordering*), `overview.md`
5.12, and [`FJS-229`](../ISSUES_ARCHIVE.md) (`@@order`, closed as *a named order is
a scope*).

## The shape

A backlog is a list somebody drags, and a board column is the same list filtered
by state. *This row sits between those two* is a fact a person makes with a
mouse, and nothing in `.lite` has a word for it: `fli db:explain` answers
`@rank`, `@position` and `@@order` with *not a word this language has*.
FJS-229's ruling still holds for what it ruled on. A *sort* order is a scope
carrying `orderBy`. A *manual* order is different: somebody has to mint the
value, and a scope cannot.

## Two spellings, measured

Fifty people drag fifty different issues into ONE gap of one column at the same
moment, each from the column as they read it. One `Issue` model carries both
columns: `rank String` (a base-62 fractional key) and `position Int`.

| Spelling | Requests | Answered | Row writes | Broadcasts | Order after |
| --- | --- | --- | --- | --- | --- |
| **F** fractional, midpoint: `patch({ rank, version })` | 50 | 50 × 200 | 50 | 50 | all 50 in the gap, **all on ONE key** |
| **FJ** fractional, jittered (20 coin flips into the gap) | 50 | 50 × 200 | 50 | 50 | all 50 in the gap, 50 distinct keys |
| **IC** integer, the client renumbers what it read | 1,625 | 57 × 200, **1,568 × 409** | 57 | 57 | 1 drag whole, 40 partly, 9 not at all; **40 rows share a position** |
| **IS-v** integer, a transactional server `move`, with the device's version | 50 | 1 × 200, **49 × 409** | 57 | 1 | one drag landed |
| **IS** the same, the server reads the version inside the transaction | 50 | 50 × 200 | **2,850** | 50 | correct, and **2,800 changed rows announced to nobody** ([`FJS-1308`](../ISSUES_ARCHIVE.md#fjs-1308)) |

**Offline** (one device drags in a tunnel while 49 correct drags land, then its
queue drains). The device reads five columns of 60, one board, and the resource
forgets all but the last 200 rows, so a drag of an early card is sent with no
version and refused 400 ([`FJS-1309`](../ISSUES.md#fjs-1309)). The lab re-reads each
dragged row, so the table measures order and not that:

| Case | Held on the device | At the drain | Result |
| --- | --- | --- | --- |
| F midpoint | 1 entry | lands | **ties with the first online drag**: both split the gap they read at its midpoint, and neither could know |
| FJ jittered | 1 entry | lands | its own key, inside the gap |
| IC client renumber | **57 entries** | **55 refused 409** *column position changed here and on the server*, 2 land | a duplicate position; nobody told ([`FJS-1302`](../ISSUES_ARCHIVE.md#fjs-1302)) |
| IS server `move` | 1 entry | lands | correct, 57 rows rewritten, 56 unannounced |
| X: two people drag the SAME issue | 1 entry | refused 409 *column rank changed here and on the server* | the online drag wins, which is right; nobody told (FJS-1302) |

**The integer spelling loses on every axis measured.** A drag writes other
people's rows, so under `@version` (which `@@sync(field)` requires) two drags of
DIFFERENT issues conflict: the client's renumber shreds the column, and the
server's renumber refuses 49 of 50 unless it gives up the version check. When it
does give it up, it writes 57 rows per drag, and FJS-1308 means 56 of them reach
no screen. Offline, one drag is 57 queued writes, and 55 of them conflict.

**The fractional key wins, but the app had to do four things the column could
not say:**

1. **Mint the key.** `web/src/lib/rank.js` is 50 lines the app wrote because
   the toolbelt has none. It must use byte order; `localeCompare` disagrees
   (`'V' < 'a'` in bytes, `'a' < 'V'` in a locale). *Measured cleared*: nothing in
   sierra, ui or litestone sorts on the device, so every order comes from
   SQLite's BINARY collation, and JS `<` agrees with it.
2. **Default it.** A new row belongs at the end of its column, which is a
   LOOKUP (`max(rank) in scope`). `@default("a0")` is the only spelling, and it
   put all 46 seeded issues on one key. It hits the same wall as FJS-1257's per-team
   start state.
3. **Break ties.** Two devices splitting one gap tie (F: 50 of 50 online, and
   deterministically offline). Nothing can mint a key between two equal keys.
   Jitter makes a tie rare (FJ: 0 of 50), but only when every writer uses it. The
   API appends the id to every order, so a tie is STABLE: *measured*, ascending
   and descending agree with `ORDER BY rank, id`. It is not the order the drags
   arrived in; it is the ULIDs' random half.
4. **Keep it short.** Keys grow about one character every five drops at the same
   spot. With `@length(1, 64)`, a gap refuses a drag after about 300–380 drops
   (*measured* with the helper), and something must rebalance the column: N
   writes, once in a long while, which is exactly the integer's cost. Nothing
   owns that.

## The proposal

```lite
model Issue {
  rank  String  @rank(scope: stateId)
  @@sync(field)
}
```

One attribute on a `String`, meaning *ordered within `scope`, stable under
concurrent insert*:

- **Litestone**: validates the alphabet (base-62, no trailing `0`); defaults a
  create to the end of its scope (the one lookup default the language would
  have, argued in FJS-1257 already); orders by `(rank, id)` wherever the column
  is sorted; and offers `db.issue.rebalance({ where: { stateId } })` for the rare
  rewrite, which is announced, and announced per row.
- **Toolbelt**: `between(a, b)` and `jittered(a, b)` in `@frontierjs/toolbelt/rank`,
  so the device and the server mint keys with one function.
- **Sierra**: `resource.move(id, { after, before })`, which mints the key from
  the rows the resource read and patches one column: one queued entry, one
  broadcast, and a merge under `@@sync(field)` that conflicts only when two
  people drag the SAME row (case X, the right answer).
- **Schema metadata**: `x-rank: { scope }` in the JSON Schema, so a board can
  know which column orders it and which column is its scope without being told.

**Why it is a declaration, not only a helper.** Three of the four things above
(the default, the tie-break, the rebalance) sit at the Data boundary, not on the
device. A helper cannot default a create, and cannot make every reader append
the id. The FJ measurement also shows the key's correctness depends on EVERY
writer jittering, and only a single owner can promise that.

## What it must not become

- **Not an integer.** A dense position is the spelling that lost; a trait that
  quietly renumbers would bring back the write storm.
- **Not a CRDT list.** Two people dragging the same card is a column conflict,
  and `@@sync(field)` already answers it correctly (the second is refused with
  its reason). What is missing there is FJS-1302's surface, not a merge.
- **Not `@@order` revived.** FJS-229 was right about sort orders.

## Open questions

- **Q1 — is *ordered within a scope, stable under concurrent insert* a column trait the framework owns, or an app pattern with a toolbelt helper? (`FJS-D366`)**
  Measured in linear Phase 4: the fractional key is the only spelling that stays
  one write, one queued entry and one broadcast per drag, and merges under
  `@@sync(field)`. The integer spelling conflicts across different rows under
  `@version`, and offline one drag is 57 queued writes. The app still had to
  mint, default, tie-break and bound the key itself.
  - **A** — an app pattern. Ship `between`/`jittered` in `@frontierjs/toolbelt/rank`, document *order by `(rank, id)`* and the rebalance, and leave the column a plain `String`
  - **B** — `@rank(scope: field)` on a `String` column: litestone validates it, defaults a create to the end of its scope, orders by `(rank, id)` and owns `rebalance()`; the toolbelt mints keys; sierra gets `resource.move(id, { after, before })`
  - **C** — B, with the key hidden: the column is managed entirely by the engine, and the only way to write it is `move()`
  - **Recommend B** — three of the four things the app had to do are Data-boundary facts (a default that is a lookup, the tie-break every reader must apply, a rebalance that must announce), and a helper reaches none of them. C would hide a value the offline queue has to carry and the merge has to compare, so the key stays an ordinary column that a trait describes. A leaves every app to rediscover the 46-way tie a literal default makes, which this run hit on its first seed

## See also

- `ecosystem-gaps.md` § 15 — the gap as first named, and its `$checkOrderBy` wish
- `tenant-authored-workflows.md` — Q2 of the same run; the default-as-lookup wall again
- `fjs-prototypes/linear/PLAN.md` § Q3 — the run
