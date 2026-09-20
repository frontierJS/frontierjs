---
id: embedding
status: proposed
dated: 2026-09-20
---

# Idea — what a row MEANS: vectors in the seed

**Status: PROPOSED — nothing here is built — but the design is RULED.**
`FJS-D328`–`FJS-D333`, six questions struck in § *Open questions* below,
including the shape (`Bytes @vector(n)`) and the retrieval surface (an `orderBy`
on `findMany`). **The work is filed as `FJS-1193`**, which is where its state
lives from here; this record is the argument and the measurements behind it.
Dated 2026-09-20. Every number in
§ *What both engines already hold*, § *What the extension buys* and § *The two
silent failures* was measured on this tree today and the probes are named;
everything else is argued. The field survey is dated and its confidence is stated
inline. Read nothing here as behavior (`VERIFYING.md`).

---

## Trigger, and the prior-art answer

*"Litestone embedding — do we have prior art done?"* **Partly, and the part that
was missing is the part that decides the design.**

Four places already say something, and they agree:

- `packages/litestone/docs/roadmap.md` § *Embedding(n) — vector search* — the
  sketch. `Embedding(1536)` stored as a BLOB of float32, `findSimilar({ vector,
  limit, threshold })`, auto-embedding on write through a plugin's `embed`
  function. The file says of itself *proposals only, never a statement of
  behavior*.
- `IDEAS/chat-surface.md` § Part 2 — the argument, dated 2026-09-18. Hybrid
  retrieval over the same `where` as `search()`, so **the gate and the row
  policies apply to retrieval for free**; embedding-on-write is an existing
  transform hook; chunking is refused as the app's.
- `IDEAS/ecosystem-gaps.md` — one row with the verdict already applied: *in-house
  column type; the model that produces the embedding is a Conduit target already*.
- `packages/litestone/CHANGES.md` — names it in *what actually remains*, beside
  `LatLng`.

**What was missing:** no record of its own, no engine measurement, and PHILOSOPHY
§ V's nine questions never run on the column — chat-surface ran them on the chat
surface, where the vector appears only as *+1 column type* inside the concept
budget. The roadmap flags the real hazard in one sentence and stops there: *the
cost is not the column: `sqlite-vec` is a loadable extension, so this is a
distribution question before it is a language one.* **This record answers that
sentence**, and the answer moves the design away from the sketch in three places.

**Zero code.** `grep -rin 'sqlite-vec\|findSimilar\|Embedding('` across every
package's `src/` and `test/` returns nothing.

---

## What both engines already hold — measured 2026-09-20

Litestone has two engines by ruling (`FJS-D305`): `bun:sqlite` on a server and
SQLite's own wasm build over `opfs-sahpool` in a browser worker. A feature that
needs a loadable extension has to be asked of both.

**The server engine can load one.** `bun:sqlite` 3.51.2 exposes
`db.loadExtension` as a function; `sqlite-vec` 0.1.9 loads through it and
`vec_version()` answers `v0.1.9`. Worth recording beside it: `SELECT
load_extension('…')` as **SQL** answers *not authorized*, so the C API is the only
door and a string reaching the query planner cannot open one.

**The browser engine can never load one, and it is not our choice.**
`@sqlite.org/sqlite-wasm@3.53.4-build1` ships one 868,907-byte `sqlite3.wasm`, and
the compile-option list inside that binary reads `ENABLE_FTS5`, `ENABLE_RTREE`,
`THREADSAFE=0` — and **`OMIT_LOAD_EXTENSION`**. The extension mechanism is
compiled out of the build, so there is no flag, no VFS trick and no second entry
point that reaches it. Any design whose retrieval path *is* the extension has no
browser half at all.

That is the inverse of what geo measured against the same two engines a day
earlier: there, `ENABLE_RTREE` and the math functions were present in both, so a
bounding box plus haversine needed no extension and no second code path. **Here
the extension is server-only by construction**, which makes *how much does it buy*
the question the shape hangs on.

**Float32 survives the round trip exactly.** A `Float32Array` written as a
`Uint8Array` comes back as a `Uint8Array` of the same length and reinterprets to
the same values through `new Float32Array(buf, byteOffset, n)`. `Bytes` already
maps to `BLOB`, so the storage half of the roadmap sketch needs no language change
at all.

**Distribution, stated as numbers.** `sqlite-vec` 0.1.9 is a 4.0 kB loader with
five optional platform packages — `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `windows-x64` — each shipping one `vec0.so`/`.dylib`/`.dll` of
about 160 kB. There is no musl build in that list, which an Alpine base image is.

---

## What the extension buys — measured, and it is less than the sketch assumes

1536 dimensions, normalized random vectors, an in-memory database on Bun, top 10,
the same corpus inserted into both a plain `BLOB` column and a `vec0` table. The
probes were throwaway and are not committed; each row below is one `ORDER BY …
LIMIT 10` against `Bun.nanoseconds()`, so the shape is rebuildable in a dozen
lines and the ratios are what it is evidence for.

| Path | 10,000 rows | 50,000 rows |
| --- | --- | --- |
| SQL `vec_distance_cosine`, full scan, `ORDER BY d LIMIT 10` | 34.2 ms | 227.6 ms |
| the same with `WHERE tenant = 1` (a quarter of the rows) | 11.0 ms | 61.3 ms |
| JS dot product over `Float32Array`s already in memory | 24.0 ms | 122.8 ms |
| JS dot product, blobs read out of SQLite first | 88.2 ms | 487.2 ms |
| `vec0` virtual table, `MATCH … AND k = 10` | 31.0 ms | 239.3 ms |

**Three readings, and the second is the one that moves the design.**

**The `vec0` virtual table buys nothing.** It is not faster than a full scan with
the scalar function at 10k and it is *slower* at 50k, because
`sqlite-vec` 0.1.9 — the published `latest`, 2026-03-31 — is exact brute force
with no ANN index. Both lines are linear in the row count and they are the same
line. So the `@@fts`-shaped design (a shadow table, triggers, a differ rule, a
`@@softDelete` rule, and a JOIN inside the one code path every gate, policy,
tenant filter and `where` composes into) would be paid in full for a ratio below
one. **This is geo's R*Tree adjudication with the numbers pointing further**: geo
declined a virtual table at a measured 1.8–2.3× advantage, and here the advantage
is negative.

**The extension itself is ~2×.** SQL scalar against JS-over-blobs is 2.6× at 10k
and 2.1× at 50k. That is the same order geo rejected a virtual table over — and
here the 2× costs a platform-specific binary on five platforms, no musl, a
`loadExtension` call in the one file allowed to name the engine, and it does not
exist at all on the browser engine. **So the extension is an accelerator and must
not be the mechanism.**

**The prefilter is a speedup, not an overhead.** A quarter of the rows runs in
roughly a quarter of the time — 3.1× at 10k, 3.7× at 50k. chat-surface's claim was
that the gate and the row policies *apply* to retrieval for free; the measurement
says something stronger, which is that they **pay for themselves**. Every
authorization filter the caller's standing puts in front of the scan is a
proportional cut to the work. The system that runs retrieval as a separate index
cannot have this property, because its filter is a post-hoc mask over a result set
the index already chose.

### The browser engine, measured 2026-09-20

The record's largest hole when it was written, and it is the engine that
*cannot* have the extension, so the JS path there is not a fallback but the only
answer. Driven in real Chrome through litestone's own wasm engine over the OPFS
pool — `createSqliteWasmEngine`, a module worker, a fresh database per run so no
run reads the previous one's warm pages.

| | 10,000 rows | 50,000 rows |
| --- | --- | --- |
| insert | 707 ms | 3,181 ms |
| read the blobs out of OPFS | 192 ms | 779 ms |
| score them in JS | 33 ms | 144 ms |
| read + score, every row | 191 ms | 915 ms |
| read + score, `WHERE tenant = 1` | 83 ms | 422 ms |

**A browser-side corpus is a real offer, not a paragraph.** 191 ms at 10,000 rows
is an interaction; 915 ms at 50,000 is a stretch and should be said out loud
rather than discovered. Against Bun's JS path the penalty is 2.2× at 10k and 1.9×
at 50k — predictable, and nowhere near a disqualification.

**The read dominates, and the arithmetic does not.** Pulling 6 kB blobs out of
SQLite is 5.9× the cost of the dot product at 10k and 5.4× at 50k. Two
consequences, and the second was not visible from the server numbers:

- **It explains what the extension was actually buying.** `vec_distance_cosine`
  is not faster math; it is math that never materializes the blob into JS. On the
  server that saving is the whole 2×. On the browser the materialization is
  unavoidable at any speed, because there is no way to put the comparison inside
  SQLite — which is the same `OMIT_LOAD_EXTENSION` wall reached from the other
  side.
- **It makes the prefilter the only real lever on this engine**, and the
  measurement moderates the claim rather than repeating it: a quarter of the rows
  costs 2.3× less rather than 4× less, because a fixed cost sits under the scan.
  Still the largest single saving available, and still free — but the server's
  3–4× is not what a browser sees, and quoting the server number here would be
  the kind of cached claim `VERIFYING.md` is about.

**Insert is a cost of its own and belongs to sync rather than to query.** 3.2 s
for 50,000 vectors is what seeding a device's corpus costs, once, and it is the
number an offline-first design has to budget — not the read path this section is
otherwise about.

**The honest ceiling is memory, not time.** At 1536 dimensions a row is 6,144
bytes, so 50,000 rows is 307 MB of vector. The JS path reads candidate blobs into
the process to score them; what keeps that viable is the prefilter above, and
nothing else. A model with a million un-narrowed rows is not served by this
proposal and should be told so rather than allowed to try.

---

## The two silent failures, measured

PHILOSOPHY § V's ninth question asked of the thing itself rather than of the
design — every distance below was run against `sqlite-vec` 0.1.9 loaded into
`bun:sqlite`, one malformed input per call.

**Most of the failure modes are already loud, and that is worth recording.** A
dimension mismatch throws and names both dimensions. A `TEXT` value throws. A blob
whose length is not a multiple of four throws and says so. `vec0` refuses a
wrong-dimension insert by column name. None of those needs a mechanism from us.

**Two are silent, and one of them is severe.**

**1. A zero vector is the top hit of every query, forever, with a 200.**
`vec_distance_cosine` over an all-zeros vector answers **`NULL`** — the norm is
zero and the division has no answer — and `NULL` sorts **first** under `ORDER BY d
ASC`. An all-zeros embedding is exactly what a failed, empty, or not-yet-populated
`embed()` call returns. So one bad write makes that row the best match for every
question anybody ever asks, no error is raised, and the grounded answer is built
on it. Measured: three rows, one exact match, one orthogonal, one zeros — the zeros
row comes back first with `d: null`. **`WHERE e IS NOT NULL` does not fix it**,
because the column is a perfectly valid blob; it is the *distance* that is null.

**2. One un-embedded row throws the whole query.** A `NULL` in the column makes
`vec_distance_cosine` throw *Error reading 1st vector*, so the moment any row is
missing its embedding — a backfill in progress, an optional field, a failed job —
every similarity read on that model fails, rather than that one row dropping out.

**Both get a mechanism rather than a warning**, which is what geo's both-or-neither
`CHECK` did for a half-set coordinate:

- the compiled read emits `WHERE <col> IS NOT NULL` itself, so an unembedded row
  is absent rather than fatal;
- **a zero-norm vector is refused at write by the attribute**, because it is never
  a meaningful embedding — the declaration already knows the column is a vector, so
  making the app write the check would fail the *derived rather than restated*
  question;
- and the compiled read carries `AND <distance> IS NOT NULL` as the belt to that
  brace, since a zero vector can also arrive as the *query* vector.

**A third finding is against the roadmap sketch rather than against SQLite.** The
sketch reads `threshold: 0.8 // cosine similarity`. Measured, the function is a
**distance**: identical vectors answer `0`, orthogonal `1`, opposite `2`. A
`threshold` named for similarity and compared as a distance is inverted — it keeps
the worst matches — and nothing would say so, because both readings return rows.
Whatever this option is finally called, it is a distance and the name has to say
which.

---

## The shape — how a vector is DECLARED

Three candidates. Storage is the same BLOB in all three; what differs is what the
language learns.

**A — `embedding Embedding(1536)`, a ninth scalar (the roadmap's sketch).**
`.lite` has eight scalars — `String Int Float Bytes Boolean DateTime Json File` —
and **not one of them takes an argument**; `SCALAR_TYPES` is a flat set the parser
checks membership against. So this is not one new type, it is the first
*parameterized* type in the grammar, and the parameter then has to travel into the
DDL, the differ, the JSON Schema, `select`, `orderBy`, patch semantics, the audit
trail and the import tiers. It also spends a scalar on a thing that is a `Bytes`
with a promise attached.

**B — `embedding Bytes @vector(1536)`, an attribute on existing storage.** The
storage exists and only the marker is new. This is `FJS-D288` exactly — `String
@date` rather than a `Date` type, because the storage existed and only the
attribute was new — and it is geo's `@point(lat, lng)` decision a second time. The
argument is a plain attribute argument, which the grammar already parses
(`@money(field: currency)`, `@@fts(tokenize: trigram)`). The marker is what earns
the ordering operator, refuses it by name elsewhere, emits the zero-norm and
length `CHECK`s, and lets `fli check` ask *a vector column nothing ever reads* and
*a similarity ordering on a field that is not one*.

**C — `@@vec([embedding])`, the `@@fts` shape.** Rejected on the measurement
above: a `vec0` shadow table, its triggers, its differ rule, its soft-delete rule
and a JOIN in the hot path, in exchange for a ratio below one.

**Ruled B** (`FJS-D332`). It coins a word and not a mechanism — no scalar, no
parameterized type, no second table, and nothing new in the three expression
evaluators (`FJS-D259`, `FJS-D271`).

### And the client verb is not a new verb

The sketch proposes `db.document.findSimilar({ vector, limit, threshold })`.
**`search()` earned its own verb because FTS5 is a different engine on a different
table** — that is what `import/prisma.js` tells an adopter in those words. A
vector column is not: it sits on the model's own table, so a similarity ordering
composes with `where`, `select`, `include`, cursors, `@@softDelete`, the tenant
filter, both row policies and the gate **by doing nothing at all**.

    db.document.findMany({
      where:   { status: 'published' },
      orderBy: { embedding: { near: queryVector } },
      take:    10,
    })

This follows geo's `near` precedent and is the version that lets a developer
predict more from less knowledge six months out, which is § V's tiebreak: there is
no second verb to learn, no second set of options to keep in sync with
`findMany`'s, and the free composition is not a promise in a doc but a consequence
of where the column lives. A distance cutoff — the sketch's `threshold`, under a
name that says *distance* — is then an ordinary filter and is left as an open
question below, because a cosine cutoff is a magic number apps guess at.

### What the seam looks like, since the extension is optional

`core/engine.js` already owns *what runs the SQL* and already refuses an engine by
name at registration for failing its contract. **The distance is the same kind of
fact**: an engine that loaded `sqlite-vec` compiles the ordering to
`vec_distance_cosine`; one that did not — the browser engine, or a server that
declined a platform binary — scores the prefiltered candidates in JS. Two
implementations of one comparison is the shape litestone already runs for
`@@allow` (`compileSql` against `evalJs`), and that pairing is held together by an
oracle test rather than by care, which `FJS-195` is the record of. **The same
oracle is the condition on shipping two paths here**, not an extra.

---

## What derives from the declaration

One line paying for readers that already exist:

- the `BLOB` column and a length `CHECK` of `n × 4` bytes;
- the zero-norm write refusal and the two `IS NOT NULL` guards above;
- `near` at the **Data** boundary, so `@@gate` and both `@@allow` halves are in
  front of retrieval rather than beside it — chat-surface's whole claim, and the
  measurement says it is a speedup;
- `@guarded`/`@encrypted` on a vector answered rather than left open: an embedding
  is a lossy but real reconstruction of its source text, so a vector of a protected
  field is protected material and Invariant 7's redaction applies to it;
- `x-vector` on the JSON Schema so a boundary knows the field is not user input,
  and `controlFor()` never renders one;
- a `fli check` rule for the ungated case, which is the artefact § V's ninth
  question asks for.

**And one thing that must be derived and is easy to miss: the column is excluded
from the default `select`.** 6 kB per row means twenty rows is 123 kB of blob
across the wire for a list nobody asked for a vector from. The attribute knows the
field's size class, so the exclusion is the declaration's job — but *a field that
is not selected by default* is a behavior `.lite` does not currently have, which
makes it the largest hidden cost in option B and is carried as an open question
rather than waved at.

---

## The nine questions (`PHILOSOPHY.md` § V) — run on B, before any code

**Run once, before the first edit**, which is the skill's requirement; where an
answer is a change to the proposal it is marked ⇒.

1. **Another origin of truth?** No. The vector is one column and the source text is
   another; nothing else holds either. The near-miss is the **dimension**, which
   would exist in the attribute *and* in whatever `embed()` the app calls — they can
   disagree silently until a write throws. ⇒ the length `CHECK` is emitted from the
   declaration, so the disagreement is refused at the first write rather than at a
   read.
2. **Concept budget?** One attribute and one ordering operator. Option A adds a
   parameterized scalar type — the grammar's first — and option C adds a second
   table with four rules attached.
3. **Whose complexity?** The problem's. A vector is bytes with a dimension and a
   comparison; B is that sentence. What is **ours** and is refused: chunking (the
   app's, per chat-surface), the model that produces the vector (a Conduit target
   per `FJS-D153`), and an ANN index.
4. **Predictability?** Improves, and this is B's strong question. The column is
   ordinary storage with an ordinary filter over it, so every existing rule about
   `where`, `select`, soft delete, tenancy and the gate holds with nothing
   restated. The cost is honest and is named in § *What derives*: the field is not
   in the default `select`, which is an asymmetry and needs the refusal text to say
   so by name.
5. **Derived rather than restated?** The `CHECK`s, the null guards, the schema
   keyword, the protection treatment, the exclusion from `select` and the `fli
   check` rule all come off the one attribute. The dimension is the column's, once.
6. **Exactly one owner?** The column and the comparison: litestone. The engine's
   choice of SQL-or-JS distance: `core/engine.js`, which already owns exactly that
   question. The model that makes the vector: the app's conduit target. The
   chunking: the app. ⇒ the two distance implementations are held by an oracle
   test, on `FJS-195`'s precedent, or only one of them lands.
7. **Boundary explicit?** Named (`@vector`), typed (`Bytes` + a dimension), sized
   by a `CHECK`, published (`x-vector`), and testable on both engines — which the
   measurement establishes is possible, at 2× on the engine without the extension.
8. **Failure proportional?** A wrong dimension is a refused write. A zero vector is
   a refused write. A malformed blob throws by name. A too-large candidate set is
   slow rather than wrong. **Nothing here can widen access**, because the ordering
   composes into a read the gate and the policies already filtered — which is the
   inverse of the external vector store this feature replaces, where the index is
   the one copy of the data nobody's policy reaches.
9. **Can it be wrong silently?** **Yes, twice, and both are measured rather than
   imagined** — the zero vector that wins every query and the distance-named-as-
   similarity threshold. Both get mechanisms above (a write refusal, a null guard,
   and a name that says *distance*). The third, the ungated case, gets the `fli
   check` rule, and that rule is the part of this record most worth building first,
   exactly as chat-surface said of the streaming one.

**Adjudication named (§ IV).** *Batteries vs. smallness*: the extension is a
battery and the measurement makes it a severable one — it is an accelerator behind
the engine seam, not the mechanism, so removing it costs 2× and no feature. *Paved
road vs. the workaround* is what the whole record is about: an external vector
store is the same workaround in the same place every time, and what it destroys is
the property this proposal exists for. **No adjudication is in tension** —
preservation is not in play, since nothing has shipped.

**Tier (§ VII): Assessment when this was written, and everything it asked for has
since been ruled.** The shape is `FJS-D332` — `Bytes @vector(n)`, not a ninth
scalar — and the retrieval surface is `FJS-D333`, an `orderBy` on `findMany`
rather than a `findSimilar()` verb. The *no-extension-required* commitment is
`FJS-D331`, with three consequences of it beside it: `FJS-D328` the default
`select`, `FJS-D329` the distance rather than a cutoff, `FJS-D330` the caller
holds the query vector. **So the roadmap sketch is superseded by ruling rather
than by argument**, which was the point — what remains is an implementation, and
the holes below are what it should be measured against.

---

## Prior art — the field, surveyed 2026-09-20

Confidence: the sqlite-vec release facts and the `vec1` status wording are quoted
from their own pages; the ORM comparisons are read off vendor documentation and
issue threads and are leads rather than probes.

- **`sqlite-vec` is mid-transition and the stable release is the brute-force one.**
  `latest` is 0.1.9 (2026-03-31). The alpha line 0.1.10-alpha.1…4 (through
  2026-05-18) adds *rescore*, *ivf (experimental, not enabled)* and *DiskANN*, with
  the release notes saying *proper docs/examples coming soon*. So the measurement
  above is correct for what an app installs today and is **dated by construction**:
  when the ANN line stabilizes, § *What the extension buys* must be re-run before
  anyone cites it. It does not change the shape — an ANN index is an accelerator
  behind the same seam — but it would change the number.
- **SQLite's own house has a vector extension, and it is still loadable.**
  `vec1` on sqlite.org is a virtual-table extension using IVFADC with OPQ,
  Euclidean and cosine, SIMD-optimized, one C file, no dependencies. Its roadmap
  says *"No further features are required before a 1.0 release. But testing is
  insufficient."* at version 0.7. **The relevant fact for this record is that it is
  compiled separately rather than being in the amalgamation**, so the
  `OMIT_LOAD_EXTENSION` wall in the wasm build stands against it too. A future
  where the browser engine gets vector search in SQL runs through a different wasm
  build, not through a better extension.
- **Prisma still has none**, which is the same finding geo recorded: `db push` will
  create a `VECTOR` column and every query is `$queryRaw`, with pgvector support
  arriving first as a managed-Postgres feature rather than as a language one. This
  is precisely the shape that produces the hand-written-SQL workaround.
- **Drizzle has it first class on Postgres** — `vector({ dimensions: n })` and a
  `cosineDistance` operator since 0.36 — and the shape it chose is the one
  recommended here: a **column plus an ordering expression that composes with an
  ordinary query**, not a separate search verb. Worth reading as convergence rather
  than as influence.
- **The gap none of them close** is the one this framework is positioned for:
  everywhere else, authorization lives in application code, so the vector index is
  a second copy of the corpus that no row policy reaches and retrieval is the
  place where a gate stops applying. Here the ordering is a clause on a read the
  policy already filtered. `prior-art.md`'s convergence table is Ash-specific and this is a Drizzle
  convergence, so it does not belong there; what it belongs in is the sentence
  this framework can say and the others cannot.

---

## Open questions

- ~~**Is a vector column in the default `select`?**~~ **Answered 2026-09-20 (`FJS-D328`): A — the attribute excludes it; naming it in `select` is how you get it.** `.lite` has no class of field
  that is present and unselected, and at 6 kB a row the default decides whether an
  ordinary twenty-row list carries 123 kB of blob nobody asked for. If it is
  excluded, the second half of the question is whose rule does the excluding.
  - **A** — the attribute excludes it; naming it in `select` is how you get it.
  - **B** — a general `@lazy`-shaped rule, which is a second concept and would
    want other users before it earns a word.
  - **C** — no exclusion; the column behaves like any other and the cost is
    documented.
  - **Recommend A** — the declaration already knows the size class, so excluding it
    there restates nothing, and C ships a performance trap whose failure is a slow
    list nobody attributes to the schema. B is the right shape only if a second
    kind of oversized column turns up; coining it for one user is the concept
    budget spent early.
- ~~**Does V1 ship a distance cutoff, or the distance itself?**~~ **Answered 2026-09-20 (`FJS-D329`): A — no cutoff. The ordering puts the computed distance on the row, the way `search()` already returns `_rank`, and the app filters on it.** It is a distance and
  not a similarity (measured), so the sketch's `threshold: 0.8` is inverted; but
  the deeper question is whether a cutoff belongs in the language at all, since a
  cosine cutoff is a number every app guesses and neither option bounds the scan.
  - **A** — no cutoff. The ordering puts the computed distance on the row, the way
    `search()` already returns `_rank`, and the app filters on it.
  - **B** — `maxDistance:` as a declared filter beside the ordering.
  - **Recommend A** — the precedent exists and is the same shape (`withRank` /
    `_rank`), it hands the app the number instead of a knob it has to guess, the
    grounding decision stays where the domain knowledge is, and B remains addable
    later without a break. A cutoff shipped now is the config flag § IV's
    paved-road row says widens the shoulder and records nothing.
- ~~**Who holds the query vector — the caller, or litestone?**~~ **Answered 2026-09-20 (`FJS-D330`): A — the caller passes floats; litestone never calls a model.** `orderBy: {
  embedding: { near: v } }` takes raw floats, which means the caller already
  called a model.
  - **A** — the caller passes floats; litestone never calls a model.
  - **B** — a paved road where the *text* is the argument and litestone calls an
    app-registered embedder.
  - **Recommend A** — B puts a vendor network call with a deadline inside a read,
    and therefore inside whatever transaction the read is in; that is exactly what
    `IDEAS/orion-port.md` keeps out of its executor loop. It also splits the
    failure: under B a model timeout surfaces as a failed query. One line at the
    call site keeps the failure attributable and keeps `FJS-D153` intact — the
    vendor stays the app's.
- ~~**May a server run the JS path, or is the extension required there?**~~ **Answered 2026-09-20 (`FJS-D331`): A — the JS path exists on both engines; the extension is an optional accelerator a server may install.** The
  browser's is now settled by measurement — it has no other option and the numbers
  say it works — so the live question is only whether a server may decline the
  binary.
  - **A** — the JS path exists on both engines; the extension is an optional
    accelerator a server may install.
  - **B** — the extension is required on a server; the JS path is browser-only.
  - **Recommend A** — measured, the extension is 2.1× at 50k, and what B demands in
    exchange is a platform-specific binary on five targets with no musl build, on
    every server, forever. B also gives the two paths different status, which is
    how the one nobody runs rots; under A both are load-bearing and the oracle that
    holds them together is a test somebody notices failing. Two implementations is
    a real cost either way — A does not make it free, it makes it honest.
- ~~**How is a vector DECLARED?**~~ **Answered 2026-09-20 (`FJS-D332`): B — `embedding Bytes @vector(1536)`, an attribute on existing storage.** The letters are § *The shape*'s, so there is one
  labeling rather than two; the argument is there and only the pick is here.
  - **A** — `embedding Embedding(1536)`, a ninth scalar.
  - **B** — `embedding Bytes @vector(1536)`, an attribute on existing storage.
  - **C** — `@@vec([embedding])`, the `@@fts` shape over a `vec0` table.
  - **Recommend B** — the storage already exists and only the marker is new, which
    is `FJS-D288` (`String @date` rather than a `Date` type) and geo's `@point` a
    third time. A is not one new type but the grammar's **first parameterized
    scalar** — `SCALAR_TYPES` is a flat set — whose parameter then has to travel
    into the DDL, the differ, the JSON Schema, `select`, `orderBy`, patch
    semantics, the audit trail and the import tiers, and it spends a scalar on a
    `Bytes` with a promise attached. C is refused on the measurement rather than
    on taste: `vec0` is exact brute force at 0.1.9 and measured *slower* than a
    plain scan at 50k, so its shadow table, triggers, differ rule, soft-delete
    rule and hot-path JOIN would be paid in full for a ratio below one.
- ~~**Is retrieval a new verb, or an `orderBy` on `findMany`?**~~ **Answered 2026-09-20 (`FJS-D333`): A — `orderBy: { embedding: { near: v } }` on the ordinary read.**
  - **A** — `orderBy: { embedding: { near: v } }` on the ordinary read.
  - **B** — `db.doc.findSimilar({ vector, limit })`, a verb of its own, as the
    roadmap sketch has it.
  - **Recommend A** — `search()` earned its verb because FTS5 is a different engine
    on a different table, which is what the language tells adopters in those
    words; a vector column is not, it sits on the model's own table. So the
    ordering composes with `where`, `select`, `include`, cursors, `@@softDelete`,
    the tenant filter, both row policies and the gate **by doing nothing at all**,
    where B would restate every one of `findMany`'s options and then have to keep
    them in sync. It is also § V's six-months-out tiebreak answered: no second
    surface to learn, and the free composition is a consequence of where the
    column lives rather than a promise in a document.

---

## Holes still open

- **No app in this repo has a vector column**, so this record has no dogfooding
  evidence behind it the way geo has a live client application. `example` is the
  place, and the honest smallest version is the storefront's product search
  answering by meaning rather than by token.
- **The benchmarks are in-memory and single-threaded on one machine**, with random
  normalized vectors rather than real embeddings. The ratios are what they are
  evidence for; the absolute milliseconds are not a promise.
- **The browser numbers are one machine, one Chrome, one run each.** They are
  evidence that the shape works and that the read dominates; they are not a
  promise, and no other browser engine was driven. A device on a phone is
  unmeasured and is the place this would first stop being an offer.
- **The `@encrypted` interaction is argued and not probed.** The claim that a
  vector of protected text is protected material follows from Invariant 7, but
  `@@fts` has a ruled precedent here — `advise.js` already warns that FTS5 indexes
  the ciphertext — and the vector case has no such rule yet.

---

## Sources

- sqlite-vec releases and the ANN alpha line — <https://github.com/asg017/sqlite-vec/releases>
- sqlite-vec ANN tracking issue — <https://github.com/asg017/sqlite-vec/issues/25>
- `vec1`, SQLite's own vector extension — <https://sqlite.org/vec1/doc/trunk/doc/vec1.md>
- Prisma pgvector issue — <https://github.com/prisma/prisma/issues/18442>
- Prisma 6.13.0, pgvector for Prisma Postgres — <https://www.prisma.io/blog/orm-6-13-0-ci-cd-workflows-and-pgvector-for-prisma-postgres>
- Drizzle vector similarity search — <https://orm.drizzle.team/docs/guides/vector-similarity-search>
