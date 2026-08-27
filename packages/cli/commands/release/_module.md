---
namespace: release
description: The Release realm — what a deploy may promise, read off the schema
---

<script>
import { resolve } from 'path'

// ─── litestone ───────────────────────────────────────────────────────────────
// The litestone CLI invocation for the current project. A hand copy of the same
// helper in db/_module.md and test/_module.md — a namespace module is the only
// script a command is compiled with, so there is nowhere shared to put it.

const litestone = (context) => `cd ${context.paths.root} && bunx litestone`

// ─── schemaPath ──────────────────────────────────────────────────────────────
// Existence is not checked here: the litestone CLI already fatals by name when
// the schema is missing, and a second check would drift from it.

const schemaPath = (context) => resolve(context.paths.db, 'schema.lite')
</script>

## The Release realm

A deploy replaces code. It does not replace the rows already written, and it
does not replace the release that is still serving while the new one starts. So
the question a deploy has to answer is not *is this migration reversible* but:

```
can Release N-1 and Release N serve the same database at once?
```

Yes is an **expand** — the previous release keeps working, so the deploy can be
taken back. No is a **contract**, and that deploy is the **pivot**: the point
after which only forward recovery exists.

```
fli release:check   — classify this deploy, and commit db/release.snapshot.md
fli release:mint    — compute the Release this tree would deploy
```

A **Release** is what that verdict is attached to: an immutable
artefact-plus-bindings, addressed by its own content. `release:mint` computes one
and writes nothing — the id is a hash of its four terms, so the same tree mints
the same id on a laptop, in CI and on the target, which is what makes a digest
promotable between environments instead of rebuilt.

Every other deployment tool ships a rollback that restores code and nothing
else, because it sees an opaque image and cannot tell whether the change was
reversible. This reads it off the file the developer already wrote.
