---
id: studio-access-and-drift
status: shipped
dated: 2026-08-14
---

# Idea — Studio shows the access surface, and says when it has drifted

**Status: BUILT 2026-08-14.** Shipped the same day it was written, so this file is
now a design record of something that exists rather than a proposal. What shipped:
`GET /api/access` + `GET /api/drift`, an Access panel with all four views, and the
header drift badge. Proven by `packages/litestone/test/verify-studio-access.mjs`
(21 assertions, real Chrome against a real server) — `bun run verify:studio`.

Two things found while building it, neither of which this file predicted:

- **Studio never opened the panel its URL named.** `showTool` was bound to
  `hashchange` only, so a fresh load of `#query` showed Browse while the hash sat
  there disagreeing — against the file's own note that *"a Studio link can name the
  panel it opens"*. Fixed in `boot()`.
- **The stale-parse problem was worse than described.** It was not only the badge
  that needed the current file: the access panel reads through `currentSchemaParse()`
  too, or it would have reported a surface from boot while the badge beside it said
  the surface had changed.

---

## The observation

**The access surface is already structured data with exactly one formatter.**
`deriveAccess(schema)` returns

```js
{ models: [{ name, gate, gateSource, unrestricted, policies, fields, transitions }],
  levels: LEVELS,
  counts: { models, gated, unrestricted, policied, protected, transitions } }
```

and `renderAccessSnapshot()` turns it into `db/access.snapshot.md`. That file is the
**reviewable** form and it earns its place: the `access` CI phase byte-compares it, so
a moved gate arrives as a diff in a pull request rather than as a production refusal.

What it is bad at is being *read*. Basecamp's snapshot is 37 rows of `"4.4.4.5"`
strings. Scanning it answers "what does this model require"; it does not answer the
question people actually have, which runs the other way:

> **What can a level-4 user do to this schema?**

Nothing anywhere answers that. `expectedVerdict()` in `access.js` computes it — it is
what `verifyGateLadder` grades against — and it has no reader outside the test tier.

The second half is the user's framing, and it is the sharper one: **the snapshot is
*what is*. It cannot tell you it has stopped being true.** Studio is already looking
at both the schema file and the live database, so it is the one place that can.

## What already exists (verified, not assumed)

| Piece | Where | State |
| --- | --- | --- |
| `deriveAccess(schema)` | `src/access.js` | ships; returns the whole surface as an object |
| `renderAccessSnapshot(access, {source})` | `src/access.js` | ships; the markdown formatter |
| `expectedVerdict(...)` | `src/access.js` | ships; *may level N do op X* — no reader outside tests |
| `litestone access --check` | `src/tools/cli.js` | ships; re-renders and byte-compares |
| `POST /api/schema-diff` | studio server | ships; diffs live editor text against every database |
| `GET /api/migrations` | studio server | ships; per-file `applied` / `pending` / `modified` / `orphaned` |
| `GET /api/schema-source` | studio server | ships; the raw `.lite` text |
| Migration drift **in the UI** | `studio.html` migrations panel | ships — but only *inside* that panel |
| Access anything in the UI | — | **absent** |
| A global drift indicator | — | **absent** |

So the server can already answer most of this. The gap is one endpoint and a panel,
plus a badge that makes an existing answer visible without opening a panel to find it.

## Part 1 — the access panel

One new endpoint, `GET /api/access`, which is `json(deriveAccess(parseResult.schema))`
and nothing else. Read-only by nature, so `--readonly` needs no new case.

Four views over one payload:

**The gate matrix.** 37 models × R/C/U/D, one cell each, coloured by level rather
than printed as a string. The thing the markdown table cannot do is let you see the
*shape* — which models are stricter on delete, which are readable by strangers, where
one model breaks the pattern its neighbors follow. That is a glance in a grid and a
careful read in a table.

**Level view — the one that justifies the panel.** Pick a level 0–7; every model and
operation lights up as permitted or refused, computed with `expectedVerdict()`. This
is the question that has no answer today, and answering it with the same predicate the
gate ladder grades against means the panel cannot drift from the enforcement.

**Policies.** `@@allow` / `@@deny` per model grouped by operation, predicate rendered.
Worth showing alongside the gate, because the two compose in a way the snapshot's
separate sections hide: a gate refuses and a policy filters, so *gate 2 + a policy you
do not satisfy* is an empty screen, not a 401. Showing them together is the point.

**Protected fields.** `@guarded` / `@encrypted` / `@secret` / `@hashed` / field
`@allow`, with which attribute is doing the protecting.

## Part 2 — drift

**Three different drifts, and they are not the same question.** Naming them separately
is most of the value; a single "out of date" badge would blur them.

| Drift | Question | Computable from |
| --- | --- | --- |
| **A · schema ↔ database** | *have I applied what I declared?* | `/api/schema-diff` + `/api/migrations` — both ship |
| **B · schema ↔ snapshot** | *is the reviewable record still true?* | re-render + compare, exactly what `access --check` does |
| **C · file ↔ what Studio loaded** | *has the file changed under me?* | new — `parseResult` is read once at startup |

**C is the one that makes the badge honest.** Studio parses the schema at boot and
holds it for the life of the process, so a schema edited in an editor while Studio is
open leaves every panel — including the new access one — quietly describing the
previous version. An mtime check on the schema path is enough to detect it, and until
it exists the badge would be reporting on a stale parse, which is worse than no badge.

**Shape:** a single indicator in the header, always visible, drilling into whichever
panel owns the answer — migrations for A, a diff view for B, a reload prompt for C.
The badge says *something has moved*; the panel says *what*.

## The rule that keeps this from doing harm

**Studio is for exploring. The committed snapshot stays the reviewable form and the CI
gate.** Both, never either.

The failure mode to avoid is specific: if a `Regenerate snapshot` button appears in
Studio, the snapshot becomes something you make green rather than something you read.
The whole value of the `access` CI phase is that a widened gate has to be *explained
in a review*, and one click that silently rewrites the file to match whatever the
schema now says converts a review artifact into a formality. If the panel offers the
action at all it should show the rendered diff first and hand back the command —
`litestone access --schema db/schema.lite` — rather than writing the file itself.

## Sizing

**S–M.** Part 1 is one endpoint over a function that already returns the right shape,
plus a panel in a file that already has six. Part 2's A is re-presenting an answer the
server gives today; B is `access --check`'s comparison moved behind an endpoint; C is
an mtime check and a reload path — small, but the one piece that is genuinely new and
the one everything else depends on for correctness.

No new dependency, no new concept in the schema language, and nothing to teach: it
renders a surface the schema already declares.

## Open questions

- **Does the level view need a principal, or only a level?** `expectedVerdict()` takes
  a level, but an app's real answer comes from its own `getLevel`, and row policies
  need an `auth()` to evaluate against. A level-only view is honest about gates and
  silent about policies; a principal-shaped one would need Studio to know the app's
  resolver, which it has no route to today. Probably: levels for the matrix, and show
  policy predicates as text rather than pretending to evaluate them.
- **Multi-database and tenants.** Studio already re-points at a tenant client. The
  access surface is a property of the *schema*, so it does not vary per tenant — worth
  stating in the UI, because the natural assumption is that it does.
- **Is drift B worth showing when the repo has no committed snapshot?** `litestone
  access` writes one beside the schema, but nothing requires it to exist. Absent, the
  badge should say *no snapshot is committed* rather than *no drift* — the same
  distinction `db.$checkWhere` makes between *I cannot judge this* and *this is fine*.

## What would make this wrong

If the panel ever becomes the thing people check instead of the diff. The snapshot is
committed precisely so that a change to the access surface cannot happen without
someone seeing it in a review; a pretty live view is a complement to that and a poor
substitute for it. Build the badge to *point at* the drift, and leave writing the file
to the command that already does it.
