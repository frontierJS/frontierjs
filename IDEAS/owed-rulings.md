---
id: owed-rulings
status: proposed
dated: 2026-09-26
---

# Rulings owed

Questions a fix ran into and could not answer alone, for which no other paper
had room. Each one is filed first with `fli file --sev decision --blocks
<row>`, which writes a row in `ISSUES.md` § Needs a decision and sets the fix's
row aside in `fli next`. Its options then go here, in a bullet whose lead names
that row's id. `fli decide` answers the bullet under the row's own id and closes
the row, so the held row comes back naming its ruling.

A question an existing paper argues belongs in that paper's `## Open questions`,
not here.

## Open questions


- **FJS-D468 — Which rows does a resource keep the read `@version` of, and what does a patch of a row it holds none for do?** `_read` in `createResource` (`packages/sierra/src/junction/resource.js`) is a 200-entry insertion-ordered map, so a screen that read 300 rows sends its first rows' patches with no version. It also records only READS (the `FJS-341` rule, restated in the `record()` comment and pinned by *nothing read means nothing sent* in `test/resource-version.test.js`), so a row that reached the screen only by push, or through a `record(id)` over a node a push filled, has none either. Both are refused 400 in the server's words (*use asSystem()*), and offline the held write carries no version and no `base` and is refused at the drain (`FJS-1302`). The red test is to load 201 rows and patch id 1: `expect(lastPatch().version).toBe(3)` fails today, and so does `store.upsert({ id: 2, version: 5 })` followed by patching id 2 and expecting version 5. Two facts constrain the answer. The linear lab reads its 300 rows through `service.find`, which no view holds. And recording a push only when `_read` has NO entry for that id is the one form compatible with `FJS-341`, since a later push must still not move it.
  - **A** — Evict only rows no view holds (`client.nodes.peek(model, id)?.held`), and treat the first sight of a never-read row in a held view as its read (a `store.subscribe` / `record()` watch that calls `_remember` only when the id is absent). This amends the doctrine's *never from the store* to *never over a read*. It leaves a `find()` read into a plain array, as in the lab, still forgetting silently.
  - **B** — Keep the cap and the rule as they are, and add a device-side refusal. A patch on a `@version` model with no remembered version and no explicit one throws a `ResourceError` naming the row, *read too long ago, or never read, to edit safely — reload it*, before anything is queued. The pushed-row case then becomes a refusal too, and linear's board has to re-read before every drag.
  - **C** — A's eviction and first-sight rule, plus B's refusal for whatever still misses (an unheld `find()` row past the cap). No screen showing a live row is ever refused, and no miss reaches the server or the queue.
  - **Recommend C** — the push case is what the person saw, so refusing it (B) punishes the ordinary live screen. A alone keeps a silent 400 for `find()` readers, and the offline drain is where that miss is destructive.
- **FJS-D470 — Where may a row under an enum `@@transitions` START: is `@default` the one entry a caller may name, or does the machine declare its entries?** `create` is the one write the machine never grades. Probed 2026-09-26 against `Doc` in `packages/litestone/test/bulk-transitions.test.ts`'s schema (`approve: review -> published @gate(5)`): the same level-4 caller is refused `update({ status: 'published' })` with *level 5* and ACCEPTED on `create({ data: { status: 'published' } })`, so a gated destination is reached by starting there (FJS-1257, connectteam `LeaveRequest`). The red test is that pair, and it asserts the create is refused. The form half follows whichever rule wins, because `x-transitions` already reaches the kit: a generated create form offers only the entries, and leaves the column out when there is one. The per-tenant default lookup is not part of this question. It is FJS-D365's.
  - **A** — `@default` is the only entry. A non-system caller whose create names any other state is refused with `TransitionViolationError`, and the message names the default. A row that genuinely starts elsewhere is made by `asSystem()` or by create-then-`@system`-move. Nothing new to spell: the entry is derived from a declaration that already exists, and `IDEAS/state-machines.md`'s *a create is not graded* is struck.
  - **B** — the machine declares its entries as moves with no `from`: `@@transitions(status, start: -> draft, rush: -> urgent @gate(5), …)`. A create must land on an entry that the caller's level reaches. With no entry declared, `@default` is the only one (A's rule), and a declared `@default` that is not an entry is refused at parse. This is the spelling `IDEAS/tenant-authored-workflows.md` gives the enum form, next to D365 B's `fromId: null` row.
  - **C** — no Data-boundary rule. The kit leaves a `@@transitions` column out of a generated create form, and apps keep a hook per machine (`example`'s `checkOrderRules`). A direct `create()` still skips the gate, against Invariant 6.
  - **Recommend A** — it closes the Invariant-6 bypass with no new word, derived from `@default`. A is also B's zero-declaration case, so B's `start:` spelling can arrive later as an addition once a product needs a second entry, or once D365 coins entry rows.
