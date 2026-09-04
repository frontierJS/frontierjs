# Studio

Studio is Litestone's browser UI. Launch it with:

```bash
bunx litestone studio            # http://localhost:8502
bunx litestone studio --port=3000
```

## Panels

### Browse

Paginated table viewer for every model. Features:
- Row-by-row editing directly in the table
- Soft-delete toggle — switch between live rows, deleted rows, and all rows
- Database filter pills for multi-database schemas
- Pagination with configurable page size
- **`🎲 Random`** — generate one plausible row from the schema, parents included
- **`{ } Query`** — the Litestone query behind the current view, to copy or send to the REPL

#### `🎲 Random`

The Testing realm's own generator (`factoryFrom` + `withParents`) pointed at the live
database — no factory class to write, the schema is the definition.

**One click can write to several tables.** A generated row has to satisfy its own
required foreign keys, so `withParents()` walks the chain: one `App` on basecamp
creates an Account, Workspace, Project and Environment first. The toast names every
table it touched, because a button that silently writes six tables is how a scratch
database stops being one.

**It runs as the principal the sidebar selects**, so a refusal is the gate working
rather than the button failing. On basecamp, generating as an unprivileged principal
answers `"Account.create" requires SYSTEM access (use asSystem())` — a true answer
about the schema. With no principal selected Studio is already `asSystem()`, which is
why the default click succeeds.

When a gate does refuse, the toast carries a **Retry as system** button. The
escalation is offered and never taken for you, the refusal is shown in full first,
and the row that results says `(as system)` so the grid cannot quietly disagree with
the principal in the sidebar. The offer appears only for an access refusal —
discriminated on `AccessDeniedError`, not on the wording of the message — because a
validation failure has no such retry.

Each click seeds the generator from a counter, so rows differ and known field names
draw real words (`omar.lindqvist734001@example.org`) rather than filler. Hidden on
`jsonl`/`logger` models, and refused by name at the endpoint too; `--readonly` blocks
it like every other mutating control.

#### Pinning a parent

Open any row's detail drawer and press **📌 Pin**. Every row generated afterwards
reuses that row as its parent instead of creating one, **at every depth of the
chain** — pin one Account and an afternoon of clicking stays inside it rather than
sprouting a tenant per click. Active pins show as chips in the toolbar; `✕` removes
one.

```
without a pin   1× account, 1× workspace, 1× project, 1× environment, 1× app, 1× deployment
with Account    1× workspace, 1× project, 1× environment, 1× app, 1× deployment
```

Studio holds only the id. The server re-reads the row **through the same client it is
about to write with**, so a pin cannot hand a principal a row its own policy hides —
an unreadable pin is refused by name rather than silently ignored. Underneath it is
`withParents({ pins })`, documented in `docs/testing.md`.

Verified by `bench/studio-factory.mjs` (endpoint) and `bench/studio-factory-click.mjs`
(the button, in a real browser).

#### `{ } Query`

Browse builds a real query object on every load. The button shows it:

```js
await db.asSystem().product.findMany({
  where: { OR: [{ name: { contains: 'wid' } }, { sku: { contains: 'wid' } }] },
  orderBy: [{ name: 'desc' }, { id: 'asc' }],
  limit: 50
})
```

**The client is part of what it emits**, because it is part of the query — the same
arguments through a different client return different rows. A view browsed with no
principal selected emits `db.asSystem()`; one browsed as a user emits
`db.$setAuth(user)` and names which user stood behind it. *Send to REPL* drops the
client instead, because the REPL binds `db` from the same auth selector and stating
one there would scope the call twice.

Two things it does not carry. The search box is not a per-field filter — it matches
every searchable String field, every numeric field when the text parses as a number,
and a date prefix on `DateTime`, so the `where` is an `OR` across the model rather
than the one condition you might expect. And cursor paging is left out: the query
describes page one of the same filter and sort, which the drawer says when you are
past it.

Verified by `bench/studio-query-view.mjs`, which executes the emitted source and
compares its rows against the grid's.

### SQL Query

Raw SQL editor with:
- Syntax highlighting
- Results grid with column sorting
- Multiple result sets (UNION, multiple statements)
- Runs against the read connection — safe to use in production

### Schema

Interactive ER diagram:
- Draggable nodes, auto-layout
- Color-coded by database
- Auto-generated models (FTS5 tables, audit models) badged distinctly
- Click any model to jump to its Browse view

### Explore

Every other panel answers *what did you declare*. This one answers *what is this
language, and what of it am I using* — every word a `.lite` file can hold, across
top-level declarations, field attributes and model attributes. The committed list
is `catalog.snapshot.md`; a number written here would be wrong by the next
attribute, which is what that file exists to make visible.

- Boxes for the nine declarations, then one per attribute group, each carrying
  how many of its words this schema uses
- **A word with nothing behind it is dimmed, never hidden.** Its card still
  opens — blurb, argument form, a worked example — because a gray box is the
  only way somebody finds a feature they have not heard of
- Clicking a declaration gives a card per instance: a model's gate, columns,
  relations, row policies and protected fields; an enum's values; a database's
  driver and path. Models Litestone generated for a logger database are listed
  and badged `generated`, and are left out of every count
- Search reaches both halves at once — the language, and what this schema
  declares
- **Add to…** asks where it goes, then does the surgery: a model attribute
  before the chosen model's closing brace, a field attribute onto the column you
  picked, or the whole example line as a new field. A blind append would write a
  second model called `Example`, which is not what anybody meant by *add
  full-text search*. The text lands in the editor **unsaved** — its own input
  handler runs validation and queues the diff, and Save and *create migration*
  stay a person's decision. A model the file does not hold (an imported one) is
  refused by name

**Preview** answers the question no panel could: what does this word do to my
app. The seed fans out into four things computed in four places, and the preview
asks all of them against the *proposed* text, before anything is written —

| Realm | Pane |
| --- | --- |
| Data | the DDL this model emits — table, indexes, FTS index |
| Data | the access surface — gate, row policies, protected fields |
| API | the JSON Schema a validator and a generated form read |
| Release | `expand` / `contract` from `classifyPivot`, and `widens` / `narrows` from `classifyAccess` |

Raising a `@@gate` previews as **contract** *and* **narrows**, which is the pair
that disagrees by construction and the reason both are shown. A word that changes
none of the derived surfaces says so rather than showing empty panes. A pane the
server could not compute shows the reason: `parse()` is more permissive than the
layers above it, and a gate string it accepts and `deriveAccess` refuses used to
come back as a bare 500.

**The UI realm is deliberately absent.** Which control a form renders is sierra's
`field-rules.js`, and litestone may not import sierra — a table here would be a
second answer to a question that already has an owner.

**Which word do I want?** comes the other way round. Three yes/no answers —
*does a request get it back? may a request write it? is there a column?* — select
one row of litestone's own visibility table, which is the table the parser
carries in prose above `@transient`:

| | column | caller writes | caller reads |
| --- | --- | --- | --- |
| `@computed` | no | no | yes |
| `@transient` | no | yes | no |
| `@system` | yes | no | yes |
| `@guarded` | yes | no | no |
| `@encrypted` | yes | yes | no |

It is a lookup, not a decision tree drawn beside the table — a tree would be free
to disagree with it. All eight combinations are named, including the three that
are not a word, so the answer is never silence. *Does it depend who is asking?*
is shown **beside** the answer rather than as a fourth question, because a field
`@allow('read', …)` multiplies with every row instead of partitioning them.

**Legal and worth a look** is the other half. Every rule fires on a schema the
parser accepts — measured, each case parses clean and is still wrong:

| Rule | What it costs |
| --- | --- |
| `required-guarded-uncreatable` | a required `@guarded` column: nothing below level 8 can create the row |
| `gate-over-own-standing` | a gate is per MODEL, so `@@gate` on the table `getLevel` reads from lets any caller at that level rewrite anyone else's standing |
| `required-system-unfilled` | `@system` is out of create-mode `required`, so no form asks for it and the application must name it on the write |
| `guarded-and-encrypted-is-secret` | the pair by hand is `@secret` spelled out |
| `fts-over-a-column-search-cannot-read` | `@@fts` over `@encrypted`/`@hashed`: the index holds ciphertext, so search returns nothing and says nothing. Over `@guarded` it matches and is then stripped, and `snippet()` renders the text |
| `foreign-key-without-index` | SQLite indexes a PK and a UNIQUE and nothing else, so an unindexed FK scans — including every `ON DELETE CASCADE` walk |
| `transition-to-a-state-nothing-reaches` | an enum value no `@@transitions` move ends at, and not the default: a state nothing can put a row in |
| `label-column-that-may-be-null` | `@@label` on an optional column: a blank row in every picker, sorted together and matching no search |
| `unique-on-an-optional-column` | SQLite counts NULLs as distinct, so the constraint applies only to rows that have a value |
| `index-another-index-already-covers` | a prefix of a longer index, or a duplicate of what `@unique` built. A `@@softDelete` model is exempt: there every `@@index` is partial and every UNIQUE is not |
| `declared-and-unreferenced` | an enum or type nothing uses |

The rules live in `src/core/advise.js` and run on the **proposed** schema in the
preview, with anything already true of the file marked as such — a warning that
was there before this edit is not this edit's fault. `GET /api/advise` answers
them for the schema as it stands.

**Declared by nobody** is the section beside it, and it is the other question
entirely. A rule is *legal and wrong*; an opportunity is *legal and missing* —
the schema says nothing, everything works, and a word would have said it better.

| Check | The word nobody reached for |
| --- | --- |
| `credential-column-in-plain-text` | a password, token or key column stored as text. `@guarded` grades it DOWN rather than clearing it: that decides who may ask, and the value is still plaintext at rest |
| `column-declared-and-inert` | a `deletedAt` with no `@@softDelete`, an `isTemplate` with no `@@hasTemplates` — the column somebody wrote and the feature they did not |
| `model-outside-the-gate-ladder` | a model with no `@@gate` where its neighbors are graded |
| `gate-with-nothing-saying-whose-row` | a `@@gate` with no `@@allow`. A gate is per MODEL and never says which rows |
| `format-column-with-no-validator` | an `email`, `url` or `phone` column nothing checks |
| `enum-column-with-no-state-machine` | a lifecycle enum with no `@@transitions`, so any write sets any value from any other |
| `json-column-with-no-shape` | a `Json` column with no `@type` — the one place the schema stops |
| `field-group-repeated-across-models` | the same columns in three models and no `trait` |
| `text-model-with-no-search` | two prose columns and no `@@fts` |

Every finding names the WORD it is about and the word is a button: clicking it
opens that word's card, which is what makes this a route rather than a lint.
`litestone advise` prints the same two lists in a terminal, each row ending in
the `explain` command and the docs page. A rule carries a **severity** because it
is a defect; a suggestion carries a **confidence** — `likely` where litestone can
SEE the thing it is asserting, `possible` where it is asking.

A rule is only as good as the schemas it has met. Each of these was run against
`example` and `basecamp` before it shipped, and one was wrong: the redundant-index
rule told basecamp to delete nine indexes that are the better ones, because on a
`@@softDelete` model `ddl.js` emits every `@@index` `WHERE deletedAt IS NULL` and
every UNIQUE in full — so the short one is a smaller partial index rather than a
duplicate. The exemption is in the rule and pinned by a test. The suggestions cost four
more: a `@guarded` credential is not plaintext to a caller, a `@transient` one
has no column at all, a catalogue legitimately lets every caller read every row,
and a `@@trait` use is ERASED at parse — so the check for repeated columns had
to compare against the trait DECLARATIONS, which survive.

**The surface is committed too.** `litestone catalog --snapshot` writes
`catalog.snapshot.md` — every word with its arity, where it is legal and what its
arguments accept — and the `snapshots` CI phase byte-compares it. The suite
proves the table is COMPLETE; the snapshot is the other question, *what changed*,
which no suite can ask: a word whose arity gains an argument or an attribute that
stops being legal inside a type keeps every test green, because the table and the
parser move together in one commit. Blurbs are deliberately absent from it —
prose churns on wording, and a snapshot that reshuffles on an edited sentence is
one nobody reads.

**The same rows answer in a terminal**: `litestone explain @guarded` needs no
server, no schema and no database, and `litestone explain --visibility` prints
the interview as a table. That is the reason the catalog is a module rather than
part of this panel — and the same rows are a page, too:
`litestone catalog --reference` writes
[reference.snapshot.md](reference.snapshot.md), every word with a worked example,
for looking one up when you do not already know its name.

The inventory is served from `GET /api/catalog`, which reads
`src/core/catalog.js`. That file is held against the parser's own `case` arms in
both directions by `test/catalog.test.ts`, so an attribute added to the language
and not to the table fails the suite: the panel's whole offer is that nothing is
missing from it.

**Which switch parses a word is not the same question as where the word is
legal.** There are six positions and only two are a switch: a model's field, a
type's field, a trait's field, an enum member, a model, a trait. The parser
reaches the other four by calling `parseFieldAttribute`/`parseModelAttribute` and
refusing afterwards — so the arms a source scan reads are the HOME arms, and no
amount of reading can see the rest.

`POSITION_RULES` states them once, in the shape the parser states them (four
named Sets), rather than as a key on the fifteen rows they constrain. The test
binds each list to the parser's own Set, and drives the parser for the one
position that is a throw rather than a Set — every field attribute tried on an
enum member, where exactly `@label` is accepted.

**`arity` is prose, and nothing checks prose.** A `values` entry states an
argument's closed set as data with a probe beside it, and the check drives the
parser twice: every declared value must parse, and an invented one must be
refused — the second half is what catches a set that has GROWN. Where a value
constrains its own context it carries its own probe, because `@from(last:)`
demands the field be typed as the target model while `@from(count:)` demands an
`Int`, and `tenancy strategy database` refuses the `column` key that `strategy
row` requires.

Proven by `bun run verify:studio:explore` — 46 assertions, real Chrome against a
real server.

### Migrations

- Applied/pending status per database
- Live schema diff showing exactly what's changed
- Per-migration SQL viewer

### Schema Advisor

Index analysis across the schema and the live database: foreign keys with no leading
index, `@@softDelete` models with no index on `deletedAt`, declared indexes a
migration has not built yet, and large tables carrying only a primary key.

An issue that has one states its **Fix in the schema** — a button that writes
`@@index([col])` into the right model in `schema.lite`, keeping the block's
indentation and sitting with the other `@@` attributes. It parses the result before
saving and refuses a duplicate. **It does not create the index**: the schema now
says something the database does not, so the toast says `migrate to create it` and
offers the Migrations panel, and the advisor keeps reporting the issue until a
migration runs, which is the truth rather than a stale read.

The raw `CREATE INDEX` is still shown for a database you cannot redeploy, but the
schema is the better route: **a migration only drops what litestone named**
(`idx_<table>_<cols>`), so an index created by hand under another name survives
every later migration.

**Why index a foreign key at all**, measured on 50k rows:

| | no index | index |
| --- | --- | --- |
| 2,000 lookups by the FK | 4,023 ms | 56 ms |
| cascade-delete 200 parents | 656 ms | 8 ms |
| insert 50,000 children | 31 ms | 53 ms |
| database size | 0.86 MB | 1.40 MB |

The cost is real but small; the win is two orders of magnitude. Note the direction:
reading the **parent** from the child (`include({ environment: true })`) resolves by
primary key and was never affected. What scans is everything starting from the other
side — the parent's `hasMany`, a `where` on the FK column, and `ON DELETE CASCADE`.

### Stats

Per-database health dashboard:
- Page size, WAL mode, cache size
- Row counts per model
- Database file size
- WAL checkpoint status

### REPL

Interactive Litestone query REPL:
- Full ORM API available (`db.user.findMany(...)`)
- Autocomplete on model names and methods
- History (up/down arrows)
- **SQL log** — shows the actual SQL + params for every expression executed
- Timing per query

### schema.lite

Live schema editor:
- Syntax highlighting for `.lite` DSL
- Debounced validation (600ms) — error tray shows parse errors in real time
- Ctrl+S to save to disk

### Transform (dev tool)

Anonymize/shard pipeline runner:
- Load a transform config
- Preview output before executing
- Download anonymized database

### Performance

- Schema advisor: suggests missing indexes, flags FK columns without indexes
- Query analyzer: paste any SQL to see `EXPLAIN QUERY PLAN`

## Acting-as picker

Select any user from your `@@auth` model to browse with row-level policies enforced. Useful for testing what a specific user can see.

## Production use

Studio reads from the read connection — safe to run against production databases. It does not bypass any policies or access control. The raw SQL editor runs with the system context (no policy filtering) — consider restricting access in production.

```bash
# Host on the server, not localhost
kamal app exec --no-interactive -- litestone studio --port=8502
```

> Note: Running Studio via `kamal app exec` spawns a new container — if your SQLite file is on the host, use the host directly to avoid WAL contention.
