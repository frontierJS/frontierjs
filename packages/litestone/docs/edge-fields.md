# Edge fields — `@edge` / `@scoped`

Attach a field value to a **relationship** instead of a row. Two things want this:

- **Per-relationship data** — "is this task important *within this project*", "the priority of this task *on this board*". The value belongs to the `(task, project)` pair, not to the task.
- **Per-viewer data** — "have *I* read this", "is this important *to me*", "my personal sort order". The value belongs to the `(row, viewer)` pair.

Both are the same shape: a value keyed by two things. Without edge fields you'd hand-write a join model and rewrite every query through it. `@edge` lets you keep the value on a managed side table and read/write it like a normal field — and **eject** to a real model, losslessly, only when the relationship actually grows up.

```prisma
model Task {
  id          Int @id
  title       String
  projects    Project[]                                  // implicit m2m
  isImportant Boolean @edge(ref: Project) @default(false) // per (task, project)
  myFlag      Boolean @scoped @default(false)             // per (task, viewer)
}
```

## Objective vs subjective

A `@relation` is an **objective** fact about a row — resolved through an FK, the same for every reader. `task.assignee` is Joe no matter who asks.

An edge field is **subjective** — resolved for a *bound dimension*, and different depending on who's asking or which context you came through. `task.mine.isImportant` is *your* flag.

Rule of thumb: if the value is the same for everyone, use a column or a relation; if it differs by viewer or by which relationship you came through, use an edge.

## The two flavors

`@edge(ref: Model)` — the generic primitive. Keyed by a **supplied** dimension (a project, a board, a device). You bind that dimension explicitly (`scopedBy`) or implicitly (by traversing the relation).

`@scoped` — shorthand for the per-viewer case. Equivalent to `@edge` pointed at your `@@auth` model, bound automatically from `auth()`. `myFlag Boolean @scoped` is "my flag", resolved for the current viewer with no extra plumbing.

```prisma
model User { id Int @id  @@auth }   // @scoped needs a model marked @@auth
```

## How it's stored

An edge is **columns on an m2m join table** — byte-for-byte the explicit join model you'd otherwise hand-write.

- If a declared m2m relation to the ref already exists (`projects Project[]`), the edge **adds columns** to that join (`_project_task` gains an `isImportant` column).
- If none exists (the `@scoped` case), the edge **creates its own** side table (`_task_user(taskId, userId, myFlag, …)`) — composite primary key, FK cascade, no surrogate id.

Edge fields are **not** columns on the host table. This is what makes eject a rename rather than a data migration.

## Schema grammar

```
<field> <Type> @edge(ref: <Model> [, key: <name>] [, as: <namespace>] [, onMissing: error|skip]) [@default(<v>)]
<field> <Type> @scoped [, as: <namespace>] [, onMissing: error|skip] [@default(<v>)]
```

| arg | meaning | default |
| --- | --- | --- |
| `ref:` | the dimension's model (required for `@edge`) | — |
| `key:` | the bind-dimension name — what `scopedBy` matches | `<ref>Id` (e.g. `projectId`) |
| `as:` | the read/write namespace values surface under | `<ref>Edge` (e.g. `projectEdge`); `mine` for `@scoped` |
| `onMissing:` | `error` or `skip` when the dimension can't resolve on write | `error` |
| `@default(...)` | also the value a read falls back to when no side row exists | — |

Multiple fields sharing a namespace form one group on one side table:

```prisma
model Task {
  id       Int @id
  projects Project[]
  isImportant Boolean @edge(ref: Project) @default(false)  // projectEdge.isImportant
  note        String? @edge(ref: Project)                  // projectEdge.note
}
```

## Reading

Edge values surface under their namespace. The dimension can be bound three ways.

### By traversal (dimension bound for free)

Reach the edge *through* its ref relation and the dimension is pinned by the path — no `scopedBy` needed:

```js
const project = await db.project.findFirst({
  where: { id: 123 },
  include: { tasks: true },
})
// project.tasks[0].projectEdge → { isImportant: true, note: 'blocking' }  (resolved for project 123)
```

### By `scopedBy` (flat access)

```js
await db.task.findMany({ scopedBy: { projectId: 123 } })
// each task.projectEdge → resolved for project 123
```

### By `auth()` (@scoped)

```js
const me = db.$setAuth(req.user)
const t  = await me.task.findFirst({ where: { id } })
// t.mine → { myFlag: true }  (this viewer's value)
```

A task never set for the current viewer reads as the field's `@default`. Under `asSystem()` / no auth, a `@scoped` field reads as its `@default` for every row (there's legitimately no viewer). A non-auth edge read with no bound dimension simply leaves the namespace absent — the "you forgot to bind" error is reserved for *filtering*, where the intent is explicit.

## Writing

Write edge values under the namespace, alongside normal columns:

```js
await db.task.update({
  where: { id },
  data:  { title: 'Ship it', projectEdge: { isImportant: true, note: 'blocking' } },
  scopedBy: { projectId: 123 },
})

// @scoped writes bind from auth automatically:
await db.$setAuth(user).task.update({ where: { id }, data: { mine: { myFlag: true } } })
```

The base row and the edge row are written together. A create can set edge data if the link is established in the same call:

```js
await db.task.create({
  data: { title: 'Design', projects: { connect: { id: 123 } }, projectEdge: { isImportant: true } },
  scopedBy: { projectId: 123 },
})
```

**Membership is required for a decorate edge.** Setting `projectEdge` for a task that isn't in that project throws `EDGE_NO_MEMBERSHIP` — the write never silently creates the link. (`@scoped` / create-own edges have no separate membership, so they just upsert their own row.)

**Unresolvable dimension.** If the dimension can't be resolved on write (no auth, unbound `scopedBy`), the write throws — unless the field is declared `onMissing: skip`, which makes it a silent no-op.

## Filtering

Filter on an edge under its namespace; it compiles to an `EXISTS` scoped to the bound dimension and composes with any normal `where`:

```js
// the important tasks in project 123
await db.task.findMany({
  where:    { projectEdge: { isImportant: true } },
  scopedBy: { projectId: 123 },
})

// my flagged tasks
await db.$setAuth(user).task.findMany({ where: { mine: { myFlag: true } } })

// composes with scalar filters, and count honors it
await db.task.count({
  where:    { status: 'open', projectEdge: { isImportant: true } },
  scopedBy: { projectId: 123 },
})
```

Operators supported inside the namespace: equality, `not`, `gt`/`gte`/`lt`/`lte`, `in`, `contains`. Filtering a non-auth edge with no bound dimension is an error — bind it with `scopedBy`.

## The `scopedBy` binder

Bind a dimension once instead of per query, and chain it with `$setAuth`:

```js
const proj = db.$scopedBy({ projectId: 123 })
await proj.task.update({ where: { id }, data: { projectEdge: { isImportant: true } } })
await proj.task.findMany({ where: { projectEdge: { isImportant: true } } })

// both dimensions active at once:
const both = db.$scopedBy({ projectId: 123 }).$setAuth(user)
```

A bound dimension applies to **every** edge that declares that key name, across all models — so `scopedBy({ projectId })` resolves a project edge on `Task` and a project edge on `Message` in one binding. Sharing is intentional: same key name, same binding.

## Auth is special

`@scoped` uses your `@@auth` model in its *subject* role (the current viewer). The same model can still be a normal relation target in its *entity* role — a `Task` can have both `assignee User @relation(...)` (Joe, objective) and `isImportant @scoped` (Sally's own flag, subjective). They coexist because they surface under different names (`task.assignee` vs `task.mine`) and bind differently (FK vs `auth()`). The `scopedBy` binder never touches auth — a `@scoped` field is always bound by `auth()`, never by a `scopedBy()` call.

## Two edges to the same model

If a model has two *different* relationships to the same ref, disambiguate both the namespace and the key:

```prisma
model Task {
  id       Int @id
  teamProjects   Project[] @relation("team")
  clientProjects Project[] @relation("client")
  teamPriority   Int @edge(ref: Project, as: team,   key: teamProjectId)   @default(0)
  clientPriority Int @edge(ref: Project, as: client, key: clientProjectId) @default(0)
}
// read → task.team.teamPriority / task.client.clientPriority
// bind → scopedBy({ teamProjectId: 10, clientProjectId: 99 })
```

The parser enforces the rules that keep this unambiguous: an `@edge` at a `belongsTo` ref is an error (that's just a column); a derived key that collides with an existing column is an error (set an explicit `key:`); a namespace can't collide with a field or relation; and fields sharing an `as:` must share the same `ref` and `key`.

## Ejecting to a model

The friction of adding fields to an edge is deliberate — when it gets to be a cluster, or the relationship needs its own policies / soft-delete / indexes / to be queried as a primary entity, promote it to a real model. Because the side table is already the model's shape, this is a rename, not a data migration:

```bash
litestone edge eject Task.projectEdge --apply
```

This prints the model to add, the fields to remove, the m2m to rewire (for a decorate edge), and runs the physical `ALTER TABLE "_project_task" RENAME TO "project_task"`:

```prisma
model ProjectTask {
  projectId Int @id
  taskId    Int @id
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  task      Task    @relation(fields: [taskId], references: [id], onDelete: Cascade)
  isImportant Boolean @default(false)
  note        String?
}
```

Existing data is preserved and immediately queryable as `db.projectTask.*`.

## Migrations

`autoMigrate` handles edges incrementally: adding an `@edge` to an existing schema ALTERs the new column into the join table, or creates the side table — preserving existing rows. Fresh DDL emits everything from the start.

## Lifecycle

Hard-deleting the host row or the dimension entity cascades the edge rows away (real FK, `ON DELETE CASCADE`). Soft-deleting the host does **not** touch edge rows — they're keyed to a still-present host, and `restore()` brings the state back intact.

## Not (yet) supported

Edge fields inside `@@allow` / `@@deny` policy expressions; indexing or `@@fts` on edge columns; `introspect` auto-detecting an edge (it emits a plain model instead); reading several dimensions' values in a single query; and firing `onEvent` / audit on an edge write. These are deferred by design, not oversights.
