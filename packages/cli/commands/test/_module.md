---
namespace: test
description: The Suite realm — access snapshots and schema-derived checks
---

<script>
import { resolve } from 'path'

// ─── litestone ───────────────────────────────────────────────────────────────
// The litestone CLI invocation for the current project. A hand copy of the same
// helper in db/_module.md — a namespace module is the only script a command is
// compiled with, so there is nowhere shared to put it.

const litestone = (context) => `cd ${context.paths.root} && bunx litestone`

// ─── schemaPath ──────────────────────────────────────────────────────────────
// Existence is not checked here: the litestone CLI already fatals by name when
// the schema is missing, and a second check would drift from it.

const schemaPath = (context) => resolve(context.paths.db, 'schema.lite')
</script>

## The Suite realm

Checks derived from `db/schema.lite`, so they assert declared intent rather than
code shape — a refactor cannot break one, and a gate change cannot leave one
passing against a rule that no longer exists.

```
fli test:access  — write db/access.snapshot.md, the reviewable access artefact
fli test:ddl     — write db/ddl.snapshot.sql, the tables SQLite is given
fli test:mutate  — mutate the schema, report what the checks cannot see
```

Both snapshots name the command that regenerates them in their own header, so
CI reruns them with `--check` without carrying a list of what exists.

## The access snapshot

`@@gate` refuses and `@@allow` filters, both at the Data boundary and neither
visible from the API or UI realm. The snapshot is where the whole declared
surface is readable at once: gates per model per operation, row policies as the
predicates they were written as, protected fields, and gated state transitions.

Commit it. Regenerate after a schema change and read the diff — it names exactly
which access moved, in tens of lines rather than the thousands a generated test
suite would have moved with it. A line that changed without a schema change you
meant to make is a shipped security bug.

`fli test:access --check` re-derives and exits 1 when the committed file is
stale. That is the CI half; without it nothing enforces that a gate change was
ever reviewed.

## The mutation score

The access snapshot says what is DECLARED. `createTestEnv`'s four executed
checks — the gate ladder, constraints, field protection, row policies — say
whether it is ENFORCED. `fli test:mutate` answers the question above both of
them: *would anything notice if this rule were deleted?*

It is the honest form of "are the derived checks any good", because the answer
is a list of specific changes nobody would catch rather than a feeling. Every
survivor it has reported so far named a check that did not exist yet and now
does.

Run it by hand after changing a check. `--check` belongs to `test:access`; a
232-mutant sweep does not belong on a push.
