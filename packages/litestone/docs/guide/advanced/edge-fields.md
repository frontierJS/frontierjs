# Edge fields

An edge field holds a value for a relationship or a viewer instead of a row: whether a task is important in this project, or whether I have read it. `@scoped` is the per-viewer case.

```lite
model User    { id Int @id  @@auth }
model Project { id Int @id  tasks Task[] }

model Task {
  id          Int       @id
  title       String
  projects    Project[]
  isImportant Boolean   @edge(ref: Project) @default(false)   // per (task, project)
  myFlag      Boolean   @scoped @default(false)               // per (task, viewer)
}
```

```js
await db.user.create({ data: { id: 7 } })
await db.project.create({ data: { id: 123 } })
await db.task.create({ data: { id: 1, title: 'Design', projects: { connect: { id: 123 } } } })

const me = db.$setAuth({ id: 7 })
await me.task.update({ where: { id: 1 }, data: { mine: { myFlag: true } } })
const t = await me.task.findFirst({ where: { id: 1 } })
if (t.mine.myFlag !== true) throw new Error('expected my flag')

const other = await db.$setAuth({ id: 8 }).task.findFirst({ where: { id: 1 } })
if (other.mine.myFlag !== false) throw new Error('another viewer should see the default')
```

The value lives on a managed side table, so the field reads and writes like a column without a hand-written join model.

## What else it can do

- `@edge(ref: Model)` is keyed by a dimension you supply, such as a project or a board
- Read through the relation and the dimension is bound for free: `project.tasks[0].projectEdge`
- `scopedBy: { projectId: 123 }` binds a dimension on a flat read or write, and `db.$scopedBy(...)` binds it once
- Filter on an edge under its namespace: `where: { mine: { myFlag: true } }`
- `as:` and `key:` name the namespace and the bound key, for two edges to one model
- `onMissing: skip` makes a write with no resolvable dimension a no-op instead of an error
- A row with no side row reads as the field's `@default`
- `litestone edge eject` promotes an edge to a real model with a rename, not a data migration

**In depth:** [Edge fields § Schema grammar](../../edge-fields.md#schema-grammar), [§ Reading](../../edge-fields.md#reading), [§ Writing](../../edge-fields.md#writing), [§ Filtering](../../edge-fields.md#filtering), [§ Ejecting to a model](../../edge-fields.md#ejecting-to-a-model)
