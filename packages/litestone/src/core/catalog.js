// ─── catalog ──────────────────────────────────────────────────────────────────
//
// Every word a person can type in a .lite file, in one table: the nine top-level
// declarations, the fifty-five field attributes, the twenty-two model attributes.
//
// It is keyed by the WRITTEN word, not by the node kind the parser returns —
// `@@unique` parses to `uniqueIndex` and `@secret` expands into three other
// attributes, and what a reader of this table is answering is "what may I type".
//
// The parser's switch arms are the only other complete inventory of the language,
// and a word in one and not the other makes this table a lie about the one thing
// it offers, which is completeness. `test/catalog.test.js` holds the two of them
// together in both directions: every row's `example` is parsed, and every `case`
// arm in parseFieldAttribute/parseModelAttribute plus the nine names parseSchema
// throws about must have a row here.
//
// `example` is one line as typed, and `context` is whatever else has to exist for
// that line to parse — a target model, an enum, the @@auth model. The test builds
// a probe schema out of the two, so an example that does not work is a red suite
// rather than a paragraph someone copies.

// ─── positions ────────────────────────────────────────────────────────────────
//
// `level` says which switch parses a word. It is NOT the same question as where
// the word is LEGAL, and the two came apart on `@label`: an enum member may
// carry one, and the parser gets there by calling parseFieldAttribute and then
// refusing everything that is not a label. So the arm the coverage test scrapes
// is the FIELD arm, and a source scan can never see the third position.
//
// `positions` is that second question, stated per row and checked by driving the
// parser rather than by reading it — every field attribute is tried on an enum
// member, and accepted-there must equal declared-here.

export const POSITIONS = {
  field:      "on a model's field",
  typeField:  "on a type's field",
  traitField: "on a trait's field",
  enumMember: 'on an enum member',
  model:      'in a model',
  traitBlock: 'in a trait',
}

/**
 * Which words each narrower position refuses.
 *
 * One block rather than a `positions:` key on fifteen rows, because the parser
 * states it the same way — four named Sets, checked in one pass after parse —
 * and a rule scattered across the rows it constrains is a rule nobody can read
 * whole. `test/catalog.test.ts` binds each list below to the parser's own Set,
 * so the two cannot drift.
 *
 * `only` rather than `excludes` where the position admits almost nothing: an
 * enum member takes `@label` and refuses the other fifty-four, and writing that
 * as an exclusion list would be a list that goes stale every time an attribute
 * is added.
 */
export const POSITION_RULES = {
  typeField:  { excludes: ['id', 'unique', 'map', 'relation', 'generated', 'from',
                           'encrypted', 'guarded', 'secret', 'updatedAt', 'version', 'allow',
                           'values', 'scale', 'money'] },
  traitField: { excludes: ['id'] },
  traitBlock: { excludes: ['map', 'db', 'fts'] },
  enumMember: { only: ['label'] },
}

const FIELD_POSITIONS = ['field', 'typeField', 'traitField', 'enumMember']
const MODEL_POSITIONS = ['model', 'traitBlock']

// ─── groups ───────────────────────────────────────────────────────────────────
//
// Ordered by the question someone arrives holding, not alphabetically: nobody
// looks for "a column nobody may read" under G.

export const GROUPS = {
  declare:   'Declare',
  identity:  'Identify a row',
  relate:    'Reach another row',
  derive:    'Compute a value',
  protect:   'Hide or lock a value',
  stamp:     'Record who and when',
  transform: 'Clean a value on write',
  validate:  'Refuse a bad value',
  shape:     'Shape the table',
  access:    'Decide who may',
  operate:   'Wire it to the app',
}

/**
 * An argument whose accepted values are a closed set.
 *
 * `arity` is prose and nothing checks prose, so a tokenizer that stops being
 * accepted leaves the catalog confidently wrong with no test to fail. `values`
 * states the set as data and carries a `probe` — one line with `%s` where the
 * value goes — so the check DRIVES the parser: every listed value must parse
 * and an invented one must be refused. That second half is what catches a set
 * that has grown rather than shrunk.
 */
const vals = (arg, of, probe) => ({ arg, of, probe })

/**
 * A value that needs a probe of its own.
 *
 * `@from(last:)` demands the field be typed as the target model while
 * `@from(count:)` demands an Int, and `tenancy strategy database` refuses the
 * `column` key that `strategy row` requires. Those are real properties of the
 * language, not awkwardness in the check — one probe per argument would have to
 * pretend otherwise.
 */
const withProbe = (value, probe) => ({ value, probe })

const t = (word, level, group, arity, blurb, example, extra = {}) =>
  ({ word, level, group, arity, blurb, example, ...extra })

// ─── top level ────────────────────────────────────────────────────────────────

const TOP = [
  t('import', 'schema', 'declare', '"path" [into <database>]',
    'Pull another .lite file in. `into` names the database everything it brings lands in, and beats a @@db written inside the imported file — a package shipping a fragment cannot know what an app calls its databases.',
    'import "./auth.lite" into auth',
    { seeAlso: ['db'], note: 'Inlined at parse, so an import does not survive into the parsed schema. Count it off the source text.' }),

  t('database', 'schema', 'declare', '<name> { path · driver · replication · retention · maxSize · model }',
    'A named database. `driver` is sqlite (default), jsonl or logger; `path` takes env("VAR", "./default") or a literal. A second database keeps its declared path even when createClient({ db }) moves main.',
    'database logs {\n  path   env("LOGS_PATH", "./logs.db")\n  driver jsonl\n}',
    { seeAlso: ['db', 'log'],
      values: [vals('driver', ['sqlite', 'jsonl', 'logger'],
                    'database probe {\n  path   "./probe.db"\n  driver %s\n}')] }),

  t('tenancy', 'schema', 'declare', '{ strategy database | row, … }',
    'How this app separates tenants, declared once. `strategy database` is one SQLite file per tenant plus a registry; `strategy row` is one database and a tenant column, desugared into @@deny plus a @default(auth().<claim>) stamp. One block per schema — a second is refused rather than merged.',
    'tenancy {\n  strategy row\n  column   workspaceId\n  claim    workspaceId\n}',
    { seeAlso: ['tenant'],
      values: [vals('strategy',
                    [withProbe('database', 'tenancy {\n  strategy %s\n  dir      "./tenants"\n}'), 'row'],
                    'tenancy {\n  strategy %s\n  column   workspaceId\n}')] }),

  t('model', 'schema', 'declare', '<PascalCaseSingular> { … }',
    'A table. The name is PascalCase singular and three separate resolvers agree on that — `model Lead` is `db.lead`, service `leads`, resource `Lead.mesa`.',
    'model Product {\n  id   Int    @id\n  name String @length(1, 80)\n}'),

  t('view', 'schema', 'declare', '<name> { fields… @@sql(…) [@@materialized] [@@refreshOn([…])] [@@db(…)] }',
    'A SQL view, read-only, with its columns declared so everything downstream of the seed can see them. `@@materialized` makes it a real table refreshed on the models named in `@@refreshOn`.',
    'view accountStats {\n  accountId Int\n  total     Int\n  @@sql("SELECT accountId, COUNT(*) AS total FROM Event GROUP BY accountId")\n}'),

  t('enum', 'schema', 'declare', '<Name> { values… }',
    'A closed value set. Reaches the client as a $def, so a generated form gets a select rather than a text box, and @@transitions can name its values. A member may carry `@label("…")` and nothing else — that is the caption a select shows.',
    'enum Plan { free pro @label("Professional") enterprise }',
    { seeAlso: ['transitions', 'label'] }),

  t('valueset', 'schema', 'declare', '<Name> { source <Model> [value <field>] [scope <name>] [where "…"] }',
    'A named, scoped list of rows from one model — what a picker offers and what a column may hold, declared once instead of a hand-written service, control and validator per list. `value` names the column a record STORES and defaults to the source\'s @id; a set whose rows get replaced wants a stable code instead. `scope` names a @@scope declared on the source. The strength is not here — it goes on @values, because one list is legitimately enforced on one column and merely offered on another.',
    'valueset TaskTag {\n  source Tag\n  value  label\n}',
    { context: 'model Tag {\n  id    Int    @id\n  label String @unique\n}',
      seeAlso: ['values', 'scope'] }),

  t('function', 'schema', 'declare', '<name>(p: Type, …): Type { @@expr("…") }',
    'A named SQL expression, so a formula written once can be used by every @generated field that needs it. The body is @@expr and nothing else.',
    'function discount(price: Int, pct: Float): Int {\n  @@expr("CAST({price} * (1.0 - {pct}) AS INTEGER)")\n}',
    { seeAlso: ['generated'] }),

  t('trait', 'schema', 'declare', '<Name> { fields… attributes… }',
    'A reusable model fragment spliced in with @@trait(T). Erased at parse, so nothing downstream knows it existed. Cannot carry @id, @@id, @@map, @@db or @@fts.',
    'trait Timestamps {\n  createdAt DateTime @default(now())\n  updatedAt DateTime @updatedAt\n}',
    { seeAlso: ['trait'], note: 'Erased at splice time, so a trait counts zero against the parsed schema. Count it off the source text.' }),

  t('extend', 'schema', 'declare', 'model <Name> { fields… attributes… }',
    'Add to a model this schema did not declare — typically one an `import` brought in from a package. The package owns the columns; the app owns where those rows sit in its own schema: the relation back to its own User, whether they are audited, and under row tenancy that they span tenants. None of that can be in the shipped file, because a package cannot know it. Adds only — a field or a single-valued attribute the model already declares is refused by name, and so is an extend naming no model.',
    'extend model Session {\n  user User @relation(fields: [userId], references: [id], onDelete: Cascade)\n  @@index([userId])\n}',
    { context: 'model Session {\n  id     String @id @default(uuid())\n  userId String\n  @@gate("8")\n}\nmodel User {\n  id String @id @default(uuid())\n  @@gate("4")\n}',
      seeAlso: ['trait'],
      note: 'The opposite direction of @@trait, and both exist: a trait is opted INTO by the model, which needs the model\'s author to have known about it. An extend does not. @@tenant(none) and @@log(audit) are the other two an app usually adds here. Applied before traits, so an extend may carry a @@trait(T) of its own.' }),

  t('type', 'schema', 'declare', '<Name> { fields… }',
    'The shape of a JSON value, used as `Json @type(Address)` and validated on write. Scalars, optionals, arrays, enums, validators and nested types only — no relations, no keys, no encryption, no file fields.',
    'type Address {\n  street String\n  city   String\n  state  String?\n}',
    { seeAlso: ['type'] }),
]

// ─── field attributes ─────────────────────────────────────────────────────────

const FIELD = [
  // identity
  t('id', 'field', 'identity', '',
    'The primary key. One per model.',
    'id Int @id'),
  t('unique', 'field', 'identity', '',
    'A unique constraint on this column. A soft-deleted row keeps its value, so a write naming a value a deleted row holds is refused by name (SoftDeletedUniqueError, 409) rather than by SQLite.',
    'email String @unique',
    { seeAlso: ['unique', 'softDelete'] }),
  t('map', 'field', 'identity', '("column_name")',
    'The column name in SQL, where it differs from the field name. Litestone emits camelCase verbatim otherwise.',
    'firstName String @map("first_name")',
    { seeAlso: ['map'] }),
  t('default', 'field', 'identity', '(value | now() | uuid() | ulid() | cuid() | nanoid() | auth().<claim> | autoincrement())',
    'The value used when a write names no other. `auth()` reads the calling principal, which is how row tenancy stamps its column. `uuid()` is a column DEFAULT; `ulid()`, `cuid()` and `nanoid()` are generated by the client at insert time, on the id or on any other column.',
    'createdAt DateTime @default(now())'),
  t('sequence', 'field', 'identity', '(scope: <field>)',
    'A counter scoped to another field\'s value — invoice #0001 per account. Litestone keeps the counters in _litestone_sequences.',
    'number Int @sequence(scope: accountId)',
    { extraFields: 'accountId Int' }),

  // relate
  t('relation', 'field', 'relate', '(["name",] fields: [...], references: [...][, onDelete][, onUpdate])',
    'A foreign key. The scalar column and the relation field are separate declarations; `fields` names the former and `references` the target\'s key.',
    'author User @relation(fields: [authorId], references: [id])',
    { context: 'model User { id Int @id }', extraFields: 'authorId Int',
      values: [vals('onDelete', ['Cascade', 'SetNull', 'Restrict', 'NoAction'],
                    'author User @relation(fields: [authorId], references: [id], onDelete: %s)')] }),
  t('from', 'field', 'relate', '(<Model>, last|first|count|sum|max|min|exists: … [, where][, orderBy][, via][, withDeleted][, withTemplates])',
    'A value read off another model — the last order, the count of comments, the sum of a column. Computed in SQL, so unlike @computed it can be filtered and sorted by.',
    'orderCount Int @from(Order, count: true)',
    { // The operation decides the field's TYPE, so each carries its own probe.
      values: [vals('operation',
                    [withProbe('last',   'latest Order? @from(Order, %s: true)'),
                     withProbe('first',  'earliest Order? @from(Order, %s: true)'),
                     withProbe('count',  'orders Int @from(Order, %s: true)'),
                     withProbe('exists', 'hasOrder Boolean @from(Order, %s: true)')],
                    'orders Int @from(Order, %s: true)')],
      context: 'model Order {\n  id        Int @id\n  exampleId Int\n  example   Example @relation(fields: [exampleId], references: [id])\n}',
      seeAlso: ['computed', 'derived'],
      note: 'Reads back down a declared relation, so the target model must carry one to here.' }),
  t('edge', 'field', 'relate', '(ref: <Model>[, key][, as][, onMissing: error|skip])',
    'A value that lives on a relationship rather than on the row — a join table\'s payload, read as if it were a column here.',
    'role String @edge(ref: Team)',
    { context: 'model Team { id Int @id }', seeAlso: ['scoped'],
      values: [vals('onMissing', ['error', 'skip'], 'role String @edge(ref: Team, onMissing: %s)')] }),
  t('scoped', 'field', 'relate', '[(as: <ns>[, onMissing: …])]',
    'Shorthand for @edge bound to the @@auth model — a per-viewer value. Resolved once the @@auth model is known.',
    'starred Boolean @scoped',
    { context: 'model User { id Int @id  @@auth }', seeAlso: ['edge', 'auth'] }),

  // derive
  t('computed', 'field', 'derive', '',
    'A value with no column, produced on read by application code. Cannot be filtered, sorted or paginated by — $checkOrderBy refuses it by name and says why.',
    'displayName String @computed',
    { seeAlso: ['transient', 'derived', 'from'] }),
  t('transient', 'field', 'derive', '',
    'The mirror of @computed: a value the caller WRITES that is never stored and never read back. Junction validates it with the model\'s own rules and lifts it onto ctx.transients, so nothing below the API boundary sees it. Takes no arguments.',
    'notifyOwner Boolean @transient',
    { seeAlso: ['computed', 'system', 'guarded'] }),
  t('derived', 'field', 'derive', '(<expression>)',
    'A value computed in SQL from this row\'s own columns, in the declarative expression language rather than a SQL string — so the schema says what it depends on. Filterable and sortable, and it can change because the clock moved.',
    'overdue Boolean @derived(dueAt < now() && completedAt == null)',
    { extraFields: 'dueAt DateTime\n  completedAt DateTime?', seeAlso: ['generated', 'computed'] }),
  t('generated', 'field', 'derive', '("sql expr" | `{a} {b}` template [, stored])',
    'A real generated column. The quote picks the language: a plain string is SQL with {field} → "field", a backtick template is literal text with the fields interpolated. `stored` writes it to disk instead of computing on read.',
    'total Float @generated("{qty} * {price}")',
    { extraFields: 'qty Int\n  price Float', seeAlso: ['function', 'derived'] }),
  t('hardDelete', 'field', 'derive', '',
    'On a File field: delete the stored object even when the row is only soft-deleted.',
    'avatar File @hardDelete',
    { seeAlso: ['keepVersions', 'softDelete', 'keep'] }),
  t('keep', 'field', 'derive', '',
    'On a hasMany field of a @@softDelete parent: these children stay live when the parent is soft-deleted, and so does everything below them. The third fate a child can have, beside cascade and @hardDelete — a receipt outliving the customer record it names.',
    'orders Order[] @keep',
    { context: 'model Order {\n  id        Int @id\n  exampleId Int\n  example   Example @relation(fields: [exampleId], references: [id])\n  deletedAt DateTime?\n  @@softDelete\n}',
      seeAlso: ['softDelete', 'hardDelete'] }),

  // protect
  t('omit', 'field', 'protect', '[(all)]',
    'Left out of results unless asked for. Bare: skipped in lists, present on findUnique. `(all)` means never, unless explicitly selected. A visibility default, not a boundary — it does not refuse a write.',
    'notes String @omit',
    { seeAlso: ['guarded', 'system'],
      values: [vals('level', ['all'], 'notes String @omit(%s)')] }),
  t('guarded', 'field', 'protect', '[(all)]',
    'A system-context lock, BOTH directions: absent from reads and refused on writes outside asSystem(), by name. Not a level — @guarded(5) does not parse. A required @guarded column makes the model uncreatable below level 8. It is not exclusive with @encrypted — @secret expands into exactly that pair — but writing both by hand is @secret spelled out.',
    'internalScore Int @guarded(all)',
    { seeAlso: ['system', 'encrypted', 'secret', 'omit', 'allow'] }),
  t('system', 'field', 'protect', '',
    'Written by the application, never by the caller: readable by anyone, refused on write by name. Reaches the client as readOnly, so a generated form does not offer it, and it is out of create-mode `required`. The app fills it by naming the column — update({ …, system: [\'trackingCode\'] }).',
    'trackingCode String @system',
    { seeAlso: ['guarded', 'transient'] }),
  t('capability', 'field', 'protect', '',
    'Writing THIS column is its own capability — `Server.hostname`, held by a Role row rather than declared anywhere. Opt-in per column and never derived wholesale: every writable column on a real app is hundreds, which is not a list anybody picks from. Needs the model\'s own @@capabilities, and is refused by name without it.',
    'hostname String @capability',
    // The probe needs the model's own switch: without it the column tier is a
    // declaration that means nothing, and the parser refuses it by name.
    { seeAlso: ['capabilities', 'guarded', 'allow'], extraFields: '@@capabilities' }),
  t('encrypted', 'field', 'protect', '',
    'Encrypted at rest. Hides the value from a reader and stays WRITABLE, which is what a caller submitting a secret needs. Not a guard: the choice is @allow(\'write\', …) for a column some callers may set, @guarded for one only asSystem() touches, and @encrypted for one anybody may write and nobody may read back.',
    'ssn String @encrypted',
    { seeAlso: ['secret', 'hashed', 'guarded'] }),
  t('hashed', 'field', 'protect', '',
    'One-way hashed on write. There is no read back — the comparison happens at the boundary.',
    'passwordHash String @hashed',
    { seeAlso: ['encrypted', 'secret'] }),
  t('secret', 'field', 'protect', '[(rotate: …)]',
    'Expands at parse into @encrypted @guarded(all) @log(<logger db>). `deterministic: true` stores the same value as the same bytes, so it can be looked up by equality and still rotated — an API key is both.',
    'apiKey String @secret',
    { seeAlso: ['encrypted', 'guarded', 'log'] }),
  t('check', 'field', 'protect', '("sql expression")',
    'A SQL CHECK constraint on the column. Enforced by SQLite, so it holds against raw statements too.',
    'age Int @check("age >= 0")'),
  t('allow', 'field', 'access', "('read'|'write'|'all', <expression>)",
    'Field-level access: the column is stripped from results, or dropped from write data, when the expression is false. Several @allow on one field OR together. asSystem() bypasses them.',
    "salary Int @allow('read', auth().isAdmin)",
    { seeAlso: ['guarded', 'system', 'allow'] }),

  // stamp
  t('updatedAt', 'field', 'stamp', '',
    'Set to now() on every update.',
    'updatedAt DateTime @updatedAt'),
  t('updatedBy', 'field', 'stamp', '[(<authField>)]',
    'Stamped with the calling principal on every update.',
    'updatedById Int? @updatedBy',
    { seeAlso: ['createdBy', 'updatedBy'] }),
  t('createdBy', 'field', 'stamp', '[(<authField>)]',
    'Stamped with the calling principal on create.',
    'createdById Int? @createdBy',
    { seeAlso: ['updatedBy', 'createdBy'] }),
  t('version', 'field', 'stamp', '',
    'Optimistic concurrency. An update must carry back the revision it read; a mismatch is a 409 naming both numbers (VersionConflictError). Reaches the client as x-version, and createResource remembers the revision a screen READ — a WS push does not move it.',
    'version Int @version',
    { seeAlso: ['keepVersions'] }),
  t('scale', 'field', 'shape', '(<places>)',
    'The column is an integer and the decimal point sits <places> places in — 1_500_000 at scale 6 is 1.5. Exact where a Float is not: SQLite has no fixed-point type, and the drift lands on multiplication and on comparing two derived numbers, which is what a reorder point or a projected on-hand IS. What a caller sends and reads back is the WHOLE number of minor units; a value with a fraction is refused by name. At most 9 places, or a 64-bit integer runs out of room in front of the point.',
    'qty Int @scale(6)',
    { seeAlso: ['money'] }),
  t('money', 'field', 'shape', '[(<CURRENCY>)] | [(field: <column>)]',
    'An amount, stored as a whole number of minor units. The scale is DERIVED from the currency and is not the author\'s to pick — JPY has none, USD has two, KWD has three — and the ISO table is read off Intl rather than shipped, so a code this runtime does not know is refused at parse rather than silently taking two places. `field:` names a sibling String column holding the code per row, for a shop that takes more than one currency. Bare @money is the app\'s default currency. Formatting is formatMoney in @frontierjs/toolbelt/units; rounding and splitting a bill are the application\'s, not the schema\'s.',
    'total Int @money(USD)',
    { seeAlso: ['scale'] }),
  t('keepVersions', 'field', 'stamp', '',
    'On a File field: keep old objects on update instead of cleaning them up.',
    'document File @keepVersions',
    { seeAlso: ['hardDelete', 'version'] }),
  t('log', 'field', 'stamp', '(<database>[, reads: false][, writes: false])',
    'Log reads and writes of this one field into a logger database. Both by default.',
    'balance Int @log(audit)',
    { context: 'database audit {\n  path   "./audit.db"\n  driver logger\n}', seeAlso: ['log', 'database'] }),

  // transform
  t('trim', 'field', 'transform', '',
    'Strip surrounding whitespace before validation and write. A Data-boundary rule — transforms do not cross to Junction\'s validator (FJS-401).',
    'name String @trim'),
  t('lower', 'field', 'transform', '', 'Lowercase before validation and write.', 'email String @lower'),
  t('upper', 'field', 'transform', '', 'Uppercase before validation and write.', 'sku String @upper'),
  t('slug', 'field', 'transform', '[(<field>…)]',
    'Slugify this field on write. The parenthesised form is not a second transform — it is a call to a `function slug` the schema declares, and without that declaration it is refused by name.',
    'slug String @slug',
    { seeAlso: ['function'] }),

  // validate
  t('values', 'field', 'validate', '(<ValueSetName>[, required|open|suggested])',
    'Where this column\'s legal values come from. `required` (unstated) refuses anything outside the set; `open` accepts a value the caller typed AND joins it to the set, so the source needs a @@label naming which column receives the text; `suggested` offers the list and enforces nothing. It sits BESIDE @relation rather than instead of it — a foreign key is storage and a value set is resolution, and those are two facts about one column. An enum field is refused: an enum is already a complete set and required by construction.',
    'tag String @values(TaskTag)',
    { context: 'model Tag {\n  id    Int    @id\n  label String @unique\n  @@label(label)\n}\n\nvalueset TaskTag {\n  source Tag\n  value  label\n}',
      seeAlso: ['valueset', 'relation'],
      values: [vals('strength', ['required', 'open', 'suggested'],
                    'tag String @values(TaskTag, %s)')] }),
  t('label', 'field', 'validate', '("Human name")',
    'The human name for this column. Emitted as `title` in JSON Schema and read straight into a generated form\'s label — a field\'s label is read off its OWN schema, never a $ref target. **The one attribute an ENUM MEMBER may also carry**, for the same reason and with the same grammar: `active @label("In progress")` is what a select shows. Every other attribute on a member is refused by name — a member is a symbol, not a column.',
    'sku String @label("Stock code")',
    { seeAlso: ['enum', 'label'] }),
  t('required', 'field', 'validate', '[(message: "…")]',
    'Required beyond what optionality says — chiefly to attach a message. A message reaches the browser as x-messages and renders in <Form>.',
    'name String @required("Tell us your name")'),
  t('email', 'field', 'validate', '[(message)]', 'Must be an email address.', 'email String @email'),
  t('url', 'field', 'validate', '[(message)]', 'Must be a URL.', 'website String @url'),
  t('phone', 'field', 'validate', '[(message)]', 'Must be a phone number.', 'phone String @phone'),
  t('markdown', 'field', 'validate', '',
    'Semantic annotation only — no validation. Says the text is Markdown, so a generated form can offer the right editor.',
    'body String @markdown'),
  t('accept', 'field', 'validate', '("image/*")',
    'On a File field: the content types accepted. Reaches the browser as the file input\'s accept.',
    'avatar File @accept("image/*")'),
  t('date', 'field', 'validate', '[(message)]', 'Must be a calendar date.', 'birthday String @date'),
  t('datetime', 'field', 'validate', '[(message)]', 'Must be an ISO-8601 instant.', 'seenAt String @datetime'),
  t('time', 'field', 'validate', '[(seconds: true[, message: "..."])]',
    'Must be HH:MM, 24-hour, leading zeros required. `seconds: true` also accepts HH:MM:SS. Named arguments only.',
    'opensAt String @time(seconds: true)'),
  t('regex', 'field', 'validate', '("pattern"[, message])', 'Must match the pattern.', 'code String @regex("^[A-Z]{3}$")'),
  t('length', 'field', 'validate', '(min[, max][, message])', 'String length bounds.', 'name String @length(1, 80)'),
  t('startsWith', 'field', 'validate', '("text"[, message])', 'Must start with the text.', 'ref String @startsWith("INV-")'),
  t('endsWith', 'field', 'validate', '("text"[, message])', 'Must end with the text.', 'file String @endsWith(".pdf")'),
  t('contains', 'field', 'validate', '("text"[, message])', 'Must contain the text.', 'path String @contains("/")'),
  t('lt', 'field', 'validate', '(n[, message])', 'Less than.', 'ratio Float @lt(1)'),
  t('lte', 'field', 'validate', '(n[, message])', 'At most.', 'pct Int @lte(100)'),
  t('gt', 'field', 'validate', '(n[, message])', 'Greater than.', 'qty Int @gt(0)'),
  t('gte', 'field', 'validate', '(n[, message])', 'At least.', 'price Int @gte(0)'),
  t('minItems', 'field', 'validate', '(n[, message])', 'Array must hold at least n.', 'tags String[] @minItems(1)'),
  t('maxItems', 'field', 'validate', '(n[, message])', 'Array must hold at most n.', 'tags String[] @maxItems(10)'),
  t('uniqueItems', 'field', 'validate', '[(message)]', 'Array values must not repeat.', 'tags String[] @uniqueItems'),
  t('type', 'field', 'validate', '(<TypeName>)',
    'On a Json column: the declared shape it must match, validated on write.',
    'address Json @type(Address)',
    { context: 'type Address {\n  street String\n  city   String\n}', seeAlso: ['type'] }),
]

// ─── model attributes ─────────────────────────────────────────────────────────

const MODEL = [
  // shape
  t('index', 'model', 'shape', '([field, …])', 'An index over one or more columns.', '@@index([customerId, createdAt])',
    { extraFields: 'customerId Int\n  createdAt DateTime' }),
  t('unique', 'model', 'shape', '([field, …])',
    'A composite unique constraint. Parses to `uniqueIndex`, which is why the written word and the node kind differ.',
    '@@unique([accountId, number])',
    { kind: 'uniqueIndex', extraFields: 'accountId Int\n  number Int' }),
  t('check', 'model', 'shape', '("<sql>"[, "<message>"])',
    'A row invariant that spans more than one column, emitted as a table CHECK. The table-level half of field `@check`: a field validator sees one field, `@@unique` is about rows in a table rather than values in a row, and `@@allow` is who rather than what is valid — so a two-column rule had nowhere to live but a service hook, which a job, a migration, `asSystem()` and a seed all bypass. Repeatable. The message is the last argument and is what a form shows; without one the expression is on the error for a developer and the person sees a generic sentence, because SQL under a control reaches somebody who did not write it. A violation is a `ValidationError` — 400, with the message on the record rather than on a box, since a rule over several columns names none of them.',
    '@@check("startsAt < endsAt", "an end must come after its start")',
    { extraFields: 'startsAt DateTime\n  endsAt DateTime', seeAlso: ['check'] }),
  t('arc', 'model', 'shape', '([field, …][, optional: true])',
    'An exclusive arc — several optional foreign keys, of which exactly one is set. The answer to "this row points at an Order OR a Product" that keeps a real foreign key, a real `onDelete` and a real `include`, where a polymorphic (typeName, id) pair keeps none of the three and the database cannot refuse a dangling one. Emitted as a table CHECK counting the non-null members, so it holds against a migration, a seed, an atomic operator and `asSystem()`, which drops the gate and every row policy and cannot drop a CHECK. `optional: true` relaxes it to at most one, for a row that may point at nothing. Members must exist and be optional; a required member is always the answer and is refused at parse. Costs one column per member and does not scale far — needing many is the signal the target set is open, which no relation can serve.',
    '@@arc([orderId, productId])',
    { extraFields: 'orderId Int?\n  productId Int?', seeAlso: ['check', 'relation'] }),
  t('map', 'model', 'shape', '("table_name")', 'The table name in SQL, where it differs from the model name.', '@@map("legacy_orders")'),
  t('label', 'model', 'shape', '(<field>)',
    'Which column a picker SHOWS for a row of this model. A bare field NAME, like @@index and @@transitions take — a quoted argument is the shape that looks like a caption, and is refused with the spelling it meant. The consumer sorts by this column and searches it with `contains`, so a value the database cannot order and match is refused at parse rather than becoming a list of `1, 2, 3` with nothing saying why. One per model.',
    '@@label(name)',
    { kind: 'labelField', extraFields: 'name String', seeAlso: ['label'] }),
  t('external', 'model', 'shape', '',
    'The table exists outside migrations — Litestone reads it and never creates or alters it. Exempt from the PascalCase-singular rule.',
    '@@external'),
  t('strict', 'model', 'shape', '', 'Legacy explicit opt-in to STRICT tables. Strict is the default now.', '@@strict'),
  t('noStrict', 'model', 'shape', '', 'Opt out of STRICT tables for this model.', '@@noStrict'),
  t('fts', 'model', 'shape', '([field, …][, tokenize: unicode61|ascii|porter|trigram])',
    'Full-text search over the named columns, which is what makes search() legal — calling it without this is a 400 naming the attribute. The tokenizer decides what matches: unicode61 is word-based, trigram is fuzzy character overlap, porter stems English.',
    '@@fts([title, body], tokenize: porter)',
    { extraFields: 'title String\n  body String',
      values: [vals('tokenize', ['unicode61', 'ascii', 'porter', 'trigram'],
                    '@@fts([title], tokenize: %s)')] }),
  t('capabilities', 'model', 'access', '[(all)]',
    'Grade this model by CAPABILITY as well as by @@gate — both, ANDed, the gate as floor. A capability is a REFERENCE to something this schema already declares (an operation, a named move, a @capability column), so there is no list to keep in step and no enum. Bare covers create, update, delete and every named move; `(all)` adds read, which is opt-in because its refusal is the silent one — a write refusal throws and names itself, a missing read capability filters into an empty list with a 200.',
    '@@capabilities(all)',
    { seeAlso: ['capability', 'gate', 'allow', 'transitions'],
      values: [vals('scope', ['all'], '@@capabilities(%s)')] }),
  t('softDelete', 'model', 'shape', '[(cascade)]',
    'Deletes mark rather than remove, and restore() is the way back. A deleted row KEEPS its @unique values. `(cascade)` carries the delete to children.',
    '@@softDelete(cascade)',
    { seeAlso: ['unique', 'hardDelete'],
      values: [vals('mode', ['cascade'], '@@softDelete(%s)')] }),
  t('softDeleteCascade', 'model', 'shape', '',
    'Removed. The parser keeps the word only to refuse it by name and say the replacement — @@softDelete(cascade).',
    '@@softDeleteCascade',
    { removed: true, replacedBy: 'softDelete', seeAlso: ['softDelete'] }),
  t('hasTemplates', 'model', 'shape', '[(<field>)]',
    'Some rows are templates rather than records, flagged on a boolean column. Reads exclude them unless withTemplates is asked for; onlyTemplates on a model without this is refused by name.',
    '@@hasTemplates'),

  // access
  t('gate', 'model', 'access', '("<read>.<create>.<update>.<delete>" | "<n>")',
    'The standing a caller needs, per operation, on the 0–9 ladder — read first, then create, update, delete. A missing position cascades from the left, so "4" is 4 for all four. Levels must be NON-DECREASING (8 and 9 are sentinels and may appear anywhere), because a model easier to delete than to read is a mistake every time. A gate REFUSES — it throws naming the model and the level, where a policy filters. A schema declaring any gate auto-installs GatePlugin, since a declared-but-unenforced gate is fail-open. It is per MODEL, so a gate on the table getLevel reads from lets any signed-in caller rewrite anyone else\'s standing.',
    '@@gate("2.4.4.5")',
    { seeAlso: ['allow', 'deny'] }),
  t('allow', 'model', 'access', "('read'|'create'|'update'|'delete'|'all', <expression>[, message])",
    'A row policy: compiled into the WHERE. Allows OR together within one operation, so a wrong policy is an empty screen with a 200 rather than an error. Membership spells as `auth().id in memberIds`, the list always the right operand.',
    "@@allow('read', ownerId == auth().id)",
    { extraFields: 'ownerId Int', seeAlso: ['deny', 'gate', 'scope'] }),
  t('deny', 'model', 'access', "('read'|…, <expression>[, message])",
    'The other half, and it is not sugar for a negated allow: a deny cannot be widened by another rule. Row tenancy desugars into @@deny for exactly that reason.',
    "@@deny('read', archived == true)",
    { extraFields: 'archived Boolean @default(false)', seeAlso: ['allow', 'tenant'] }),
  t('scope', 'model', 'access', '(<name>, <expression>)',
    'A named filter declared once and reused — db.$scopedBy(name) applies it.',
    '@@scope(active, archived == false)',
    { extraFields: 'archived Boolean @default(false)' }),
  t('tenant', 'model', 'access', '(<column> | none | via: parent)',
    'How this model belongs to a tenant under `tenancy { strategy row }`. `none` says it spans tenants on purpose; `via: parent` says it carries no column of its own and inherits through its relation. A model with no column and no rule is reported by name at parse.',
    '@@tenant(none)',
    { context: 'tenancy {\n  strategy row\n  column   workspaceId\n}', seeAlso: ['tenancy', 'deny'],
      values: [vals('mode', ['none'], '@@tenant(%s)')] }),
  t('transitions', 'model', 'access', '(<field>, [<name>:] <from>|[<from>,…] -> <to> [@gate(N)], …)',
    'A state machine on a CLOSED column — an enum, or a Boolean, which is the two-state machine every schema has (isPrimary, isPublished, isSuspended) and whose two directions are routinely different authorities. Enforced at the Data boundary. A boolean move states its own name, because `-> true` says which value is written and not what a person did. @gate(N) on a move is a floor on top of the model update level, and @gate(8) marks a move the ENGINE makes: getLevel is clamped to 7, so no caller passes and asSystem() bypasses. Reaches the client as x-transitions keyed by field — on the model, never on the enum $def, because only a model can carry a per-transition gate.',
    '@@transitions(status,\n    pay:    draft        -> paid,\n    ship:   paid         -> shipped,\n    cancel: [draft, paid] -> cancelled @gate(5))',
    { context: 'enum OrderStatus { draft paid shipped cancelled }',
      extraFields: 'status OrderStatus @default(draft)', seeAlso: ['gate'] }),

  // operate
  t('auth', 'model', 'operate', '',
    'This model is the principal auth() reads. One per schema; @scoped resolves against it.',
    '@@auth',
    { seeAlso: ['scoped'] }),
  t('log', 'model', 'operate', '(<database>[, reads: false][, writes: false])',
    'Record writes to this model in a logger database. Protected fields (@encrypted/@guarded/@secret) log as [redacted], in field entries and in before/after snapshots alike. This records a WRITE — db.$audit() is the verb for an EVENT nothing wrote.',
    '@@log(audit)',
    { context: 'database audit {\n  path   "./audit.db"\n  driver logger\n}', seeAlso: ['log', 'database'] }),
  t('db', 'model', 'operate', '(<database>)',
    'Which declared database this model lives in. An import\'s `into` beats it.',
    '@@db(logs)',
    { context: 'database logs {\n  path   "./logs.db"\n  driver sqlite\n}', seeAlso: ['database', 'import'] }),
  t('trait', 'model', 'operate', '(<TraitName>)',
    'Splice a trait\'s fields and attributes in here. Collisions and cycles are caught at splice time.',
    '@@trait(Timestamps)',
    { context: 'trait Timestamps {\n  createdAt DateTime @default(now())\n}', seeAlso: ['trait'] }),
  t('createdBy', 'model', 'operate', '[(<base>)]',
    'The model-level form: declare the created-by column for this model without naming it on a field.',
    '@@createdBy',
    { context: 'model User { id Int @id  @@auth }', seeAlso: ['createdBy', 'auth'] }),
  t('updatedBy', 'model', 'operate', '[(<base>)]',
    'The model-level form of @updatedBy.',
    '@@updatedBy',
    { context: 'model User { id Int @id  @@auth }', seeAlso: ['updatedBy', 'auth'] }),
]

// ─── the table ────────────────────────────────────────────────────────────────

export const CATALOG = [...TOP, ...FIELD, ...MODEL]

export const TOP_LEVEL       = TOP
export const FIELD_ATTRS     = FIELD
export const MODEL_ATTRS     = MODEL

/** Every position a word is legal in, computed from POSITION_RULES. */
export function positionsOf(row) {
  if (row.level === 'schema') return ['schema']
  const all = row.level === 'field' ? FIELD_POSITIONS : MODEL_POSITIONS
  return all.filter(pos => {
    const rule = POSITION_RULES[pos]
    if (!rule) return true                                  // the home position
    if (rule.only) return rule.only.includes(row.word)
    return !rule.excludes.includes(row.word)
  })
}

/** The word as it is typed, prefix included: `model`, `@guarded`, `@@gate`. */
export function typed(row) {
  return row.level === 'schema' ? row.word : row.level === 'field' ? `@${row.word}` : `@@${row.word}`
}

/**
 * One row, by the word as typed. `level` disambiguates the nine words that exist
 * at two levels with different meanings — @unique is a column constraint and
 * @@unique is a composite one, and answering the wrong one is worse than none.
 */
export function lookup(word, level) {
  const w = String(word).replace(/^@@?/, '')
  const lvl = level ?? (String(word).startsWith('@@') ? 'model' : String(word).startsWith('@') ? 'field' : undefined)
  return CATALOG.find(r => r.word === w && (lvl ? r.level === lvl : true)) ?? null
}

/** Rows of one level, grouped in GROUPS order — what a panel renders. */
export function grouped(level) {
  const rows = CATALOG.filter(r => r.level === level)
  const out  = []
  for (const key of Object.keys(GROUPS)) {
    const members = rows.filter(r => r.group === key)
    if (members.length) out.push({ group: key, title: GROUPS[key], rows: members })
  }
  return out
}

// ─── probe ────────────────────────────────────────────────────────────────────
//
// `example` is one line as typed, which is not a schema. This assembles the
// smallest one that holds it: the row's `context` (a target model, an enum, a
// tenancy block), then a model carrying `extraFields` and the example itself.
//
// It is here rather than in the test because two readers need the same text.
// `test/catalog.test.ts` parses it — that is what makes an example a checked
// claim rather than a paragraph someone copies — and the reference page PRINTS
// it. A renderer with its own assembler would publish a snippet the suite has
// never seen.

/**
 * The model an example is dropped into. Named for the reader rather than the
 * harness: a `context` row references it back (a `@from` target needs a
 * relation to something), so the name is on the page.
 */
export const PROBE = 'Example'

/** The smallest schema a row's `example` parses inside. */
export function probeFor(row) {
  const ctx = row.context ? row.context + '\n\n' : ''
  if (row.level === 'schema') return ctx + row.example

  const extra = row.extraFields ? `  ${row.extraFields}\n` : ''
  // A row whose example IS the primary key must not get a second one.
  const pk = /@id\b/.test(row.example) ? '' : '  id Int @id\n'
  return `${ctx}model ${PROBE} {\n${pk}${extra}  ${row.example}\n}`
}

// ─── where to read more ───────────────────────────────────────────────────────
//
// A blurb is one paragraph and several of these words are a page. Without a
// pointer the routing stops here: every reader — the panel, `explain`, the
// editor's hover, the reference page — dead-ends at the sentence, and `seeAlso`
// only ever leads to another word.
//
// One block rather than a `doc:` key on eighty-five rows, for the same reason
// POSITION_RULES is one block: a mapping scattered across the things it maps is
// one nobody can read whole, and this one is read whole every time a docs file
// is renamed. Keyed `<level>:<word>` — the word as TYPED, not the node kind, so
// `@@unique` is `model:unique` and not `model:uniqueIndex`; nine words exist at
// two levels, which is what the prefix is for.
//
// `test/catalog.test.ts` asserts every value names a file that is there, and
// that every word either has one or is named below as having none.

const D = 'docs/'

export const DOCS = {
  // declarations
  'schema:import':      'schema.md',
  'schema:database':    'multi-database.md',
  'schema:tenancy':     'multi-tenancy.md',
  'schema:model':       'schema.md',
  'schema:view':        'schema.md',
  'schema:enum':        'schema.md',
  'schema:function':    'schema.md',
  'schema:trait':       'traits.md',
  'schema:extend':      'traits.md',
  'schema:type':        'json-types.md',

  // identity
  'field:id':           'schema.md',
  'field:unique':       'schema.md',
  'field:map':          'schema.md',
  'field:default':      'schema.md',
  'field:sequence':     'sequences.md',

  // relate
  'field:relation':     'relations.md',
  'field:from':         'relations.md',
  'field:edge':         'edge-fields.md',
  'field:scoped':       'edge-fields.md',

  // derive — the four that get confused go to the page that compares them
  'field:computed':     'modelling.md',
  'field:transient':    'modelling.md',
  'field:derived':      'modelling.md',
  'field:system':       'modelling.md',
  'field:generated':    'schema.md',
  'field:hardDelete':   'soft-delete.md',
  'field:keep':         'soft-delete.md',

  // protect
  'field:omit':         'schema.md',
  'field:guarded':      'encryption.md',
  'field:encrypted':    'encryption.md',
  'field:hashed':       'encryption.md',
  'field:secret':       'encryption.md',

  // stamp
  'field:updatedAt':    'schema.md',
  'field:updatedBy':    'schema.md',
  'field:createdBy':    'schema.md',
  'field:version':      'schema.md',
  'field:scale':        'exact-numbers.md',
  'field:money':        'exact-numbers.md',
  'field:keepVersions': 'file-storage.md',
  'field:log':          'audit-logging.md',

  // transform
  'field:trim':         'schema.md',
  'field:lower':        'schema.md',
  'field:upper':        'schema.md',
  'field:slug':         'schema.md',

  // validate
  'field:label':        'jsonschema.md',
  'field:required':     'schema.md',
  'field:email':        'schema.md',
  'field:url':          'schema.md',
  'field:phone':        'schema.md',
  'field:markdown':     'schema.md',
  'field:accept':       'file-storage.md',
  'field:date':         'schema.md',
  'field:datetime':     'schema.md',
  'field:time':         'schema.md',
  'field:regex':        'schema.md',
  'field:length':       'schema.md',
  'field:check':        'schema.md',
  'model:arc':          'schema.md',
  'model:check':        'schema.md',
  'field:startsWith':   'schema.md',
  'field:endsWith':     'schema.md',
  'field:contains':     'schema.md',
  'field:lt':           'schema.md',
  'field:lte':          'schema.md',
  'field:gt':           'schema.md',
  'field:gte':          'schema.md',
  'field:minItems':     'schema.md',
  'field:maxItems':     'schema.md',
  'field:uniqueItems':  'schema.md',
  'field:type':         'json-types.md',

  // access
  'field:allow':        'access-control.md',

  // model attributes
  'model:index':        'performance.md',
  'model:unique':       'performance.md',
  'model:map':          'schema.md',
  'model:label':        'jsonschema.md',
  'model:external':     'multi-database.md',
  'model:strict':       'schema.md',
  'model:noStrict':     'schema.md',
  'model:fts':          'full-text-search.md',
  'model:softDelete':   'soft-delete.md',
  'model:hasTemplates': 'schema.md',
  'model:gate':         'access-control.md',
  'model:capabilities': 'access-control.md',
  'field:capability':   'access-control.md',
  'model:allow':        'access-control.md',
  'model:deny':         'access-control.md',
  'model:scope':        'filtering.md',
  'model:tenant':       'multi-tenancy.md',
  'model:transitions':  'schema.md',
  'model:auth':         'access-control.md',
  'model:log':          'audit-logging.md',
  'model:db':           'multi-database.md',
  'model:trait':        'traits.md',
  'model:createdBy':    'schema.md',
  'model:updatedBy':    'schema.md',
}

/**
 * Words with no page, each because of something rather than by oversight.
 *
 * Named rather than left absent so that a word arriving with no documentation
 * is a decision someone made, and so that writing the page is a line deleted
 * from here rather than a thing nobody remembers is owed.
 */
export const UNDOCUMENTED = {
  'schema:valueset': 'FJS-412 — ruled and being built, so the page is owed with the feature rather than now',
  'field:values':    'FJS-412 — the binding half of valueset, and the same page will cover both',
}

/** The docs page for a word, repo-relative, or null. */
export function docFor(row) {
  const path = DOCS[`${row.level}:${row.word}`]
  return path ? D + path : null
}
