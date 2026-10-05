// device-schema.js — the schema a DEVICE gets, filtered out of the parsed tree.
//
//   import { parseFile }    from '@frontierjs/litestone/parser'
//   import { deviceSchema } from '@frontierjs/litestone/device-schema'
//
//   const { parsed, notes } = deviceSchema(parseFile('./db/schema.lite'))
//   const client = await createBrowserClient({ schema: parsed, ... })
//
// `createClient({ parsed })` has always taken a parse result instead of `.lite`
// text, and the browser client takes one too — so what a device needs is not an
// emitter but a FILTER, and this is it: the `@@sync` models plus what they
// reference, and nothing else.
//
// ─── Why a filter, and not the `.lite` file ───────────────────────────────
//
// Shipping the app's own schema source is not an option. It would undo the
// prose stripping `FJS-D204` measured at 23 kB of `///` comments that address
// whoever EDITS the schema — this repo's own quote policy expressions and
// explain a bearer-token scheme — and it would hand a device every model in the
// app, including the ones nobody said were readable off a server.
//
// A filter cannot accidentally carry a comment, and it cannot accidentally
// carry a model: both are decided by what it copies rather than by what it
// remembers to leave out.
//
// ─── What decides the set ─────────────────────────────────────────────────
//
// `@@sync`, and nothing else. A model declaring it has already said it will be
// read and written with no server reachable, which is the same statement as
// *this crosses to a device* — so the selection is derived and there is no
// second declaration to keep in step (`FJS-D303`). That is also why the row
// policies of a kept model cross with it: the opt-in `FJS-D303` requires is the
// `@@sync` declaration itself, so a model in this projection has opted in by
// being in it.
//
// ─── Nothing is cut silently ──────────────────────────────────────────────
//
// Every cut is graded and returned, on the terms `litestone import` already
// uses for the other direction:
//
//   lost     it is not in the device schema at all
//   changed  it is there and it means something different on a device
//   noted    it is there unchanged and it is worth knowing about
//
// A caller that ignores `notes` gets a working client; a caller that prints
// them gets to see that `StocktakeCount.variant` is not a column it can
// `include` in a stockroom.

const GRADES = ['lost', 'changed', 'noted']

/**
 * Filter a parse result down to what a device is given.
 *
 * @param {{ valid: boolean, schema: object }} parseResult  from `parse` / `parseFile`
 * @returns {{ parsed: object, models: string[], notes: Array<{grade: string, what: string, why: string}> }}
 */
export function deviceSchema(parseResult) {
  // Asked in this order: a schema that does not parse has `schema: null`, so the
  // shape guard would answer it with the sentence about the wrong argument.
  if (parseResult && typeof parseResult === 'object' && parseResult.valid === false)
    throw new Error(
      'deviceSchema: this schema does not parse, so there is nothing to filter:\n  ' +
      (parseResult.errors ?? []).join('\n  '))
  if (!parseResult || typeof parseResult !== 'object' || !parseResult.schema)
    throw new Error('deviceSchema: expected a parse result — deviceSchema(parseFile(\'./db/schema.lite\'))')

  const source = parseResult.schema
  const notes  = []
  const note   = (grade, what, why) => {
    if (!GRADES.includes(grade)) throw new Error(`deviceSchema: unknown grade '${grade}'`)
    notes.push({ grade, what, why })
  }

  // ─── the set ────────────────────────────────────────────────────────────

  const syncable = (source.models ?? []).filter(m => m.attributes?.some(a => a.kind === 'sync'))
  const keptNames = new Set(syncable.map(m => m.name))

  if (!syncable.length)
    note('noted', 'the schema', 'no model declares @@sync, so a device is given no tables at all')

  const enumsByName    = new Map((source.enums    ?? []).map(e => [e.name, e]))
  const typesByName    = new Map((source.types    ?? []).map(t => [t.name, t]))
  const valuesByName   = new Map((source.valuesets ?? []).map(v => [v.name, v]))
  const viewNames      = new Set((source.views    ?? []).map(v => v.name))
  const loggerDbNames  = new Set((source.databases ?? []).map(d => d.name))

  const neededEnums  = new Set()
  const neededTypes  = new Set()
  const neededValues = new Set()

  // A `type T { … }` may hold a field of another `type` or of an enum, so the
  // want is transitive. Walked here rather than at the field, or a type reached
  // only through another type arrives as a dangling name in the device schema
  // and every read of that column fails on a client that otherwise booted.
  const wantType = (name) => {
    if (neededTypes.has(name)) return
    const t = typesByName.get(name)
    if (!t) return
    neededTypes.add(name)
    for (const f of t.fields ?? []) wantNamed(f.type?.name)
  }

  const wantNamed = (name) => {
    if (!name) return
    if (enumsByName.has(name))  neededEnums.add(name)
    else if (typesByName.has(name)) wantType(name)
  }

  // ─── the models ─────────────────────────────────────────────────────────

  const models = syncable.map((model) => {
    const droppedFields = new Set()

    const fields = []
    for (const field of model.fields ?? []) {
      const typeName = field.type?.name
      const scalar   = field.type?.kind === 'scalar'

      if (!scalar && (viewNames.has(typeName) || (isModelName(source, typeName) && !keptNames.has(typeName)))) {
        // The relation comes out and the foreign key stays. `ddl.js` writes a
        // `FOREIGN KEY (…) REFERENCES "<target>"` out of a relation, and SQLite
        // accepts a CREATE TABLE naming a table that does not exist. The device
        // does not enforce keys (`FJS-D485`), but the relation would still name
        // a model the client does not have.
        //
        // `StocktakeCount.variant` is the case: `variantId Int` is still there,
        // which is what the held write carries and what the server joins on.
        droppedFields.add(field.name)
        note('lost', `${model.name}.${field.name}`,
          `a relation to ${typeName}, which does not declare @@sync` +
          (foreignKeyOf(field) ? ` — ${foreignKeyOf(field)} is still a column` : ''))
        continue
      }

      if (!scalar) wantNamed(typeName)
      for (const name of namesReferredToBy(field)) {
        if (valuesByName.has(name)) neededValues.add(name)
        else wantNamed(name)
      }

      fields.push(stripComments({
        ...field,
        attributes: (field.attributes ?? []).filter((attr) => {
          // `@log(audit)` names a database this device does not have. The
          // attribute writes a row into it on every read or write, so leaving
          // it in is a throw on the first query rather than a missing column.
          if (attr.kind === 'log' && loggerDbNames.has(attr.db)) {
            note('lost', `${model.name}.${field.name} @log(${attr.db})`,
              'a logger database is a fleet-wide file on a server; a device has one database')
            return false
          }
          return true
        }),
      }))
    }

    const attributes = []
    for (const attr of model.attributes ?? []) {
      if (attr.kind === 'db') {
        // Answered at the schema level below — the whole `database` block is
        // dropped, so the attribute naming one has nothing to name.
        continue
      }
      if ((attr.kind === 'index' || attr.kind === 'unique') &&
          (attr.fields ?? []).some(f => droppedFields.has(f))) {
        note('lost', `${model.name} @@${attr.kind}([${(attr.fields ?? []).join(', ')}])`,
          'it names a relation that is not in the device schema')
        continue
      }
      if ((attr.kind === 'allow' || attr.kind === 'deny') && walksDropped(attr.expr, droppedFields)) {
        // Not rewritten and not dropped: a policy is the row's own rule and
        // guessing at half of one is worse than either. It is reported because
        // a predicate reaching through a relation that is not here evaluates
        // against nothing, which on a device looks like an empty screen.
        note('noted', `${model.name} @@${attr.kind}`,
          'the predicate reaches through a relation the device does not have, so it will not resolve locally')
      }
      attributes.push(attr)
    }

    return stripComments({ ...model, fields, attributes })
  })

  // ─── everything above a model ───────────────────────────────────────────

  for (const m of source.models ?? [])
    if (!keptNames.has(m.name))
      note('lost', m.name, 'it declares no @@sync')

  for (const v of source.views ?? [])
    note('lost', v.name, 'a view is SQL over tables the device may not have; a device reads its own rows')

  // `createClient({ db })` overrides a declared `main`, and overrides NOTHING
  // ELSE: every other block keeps the path it declares. `example` declares a
  // second one — `database audit { path "./db/audit/" driver logger }` — which
  // resolves against the working directory and is a fleet-wide file on a
  // server, so a device carrying the block opens a host filesystem path that
  // `host/browser.js` refuses by name.
  //
  // `@@db(name)` comes off the kept models with it, in the model loop above: an
  // attribute naming a block that is not here would route the model nowhere.
  if ((source.databases ?? []).length)
    note('changed', `database ${(source.databases ?? []).map(d => d.name).join(', ')}`,
      'a device has one database and the caller names it; a second block keeps its own declared path')

  if (source.tenancy)
    note('lost', 'tenancy', `strategy ${source.tenancy.strategy} names a directory and a registry a browser does not have; ` +
      'a device holds one tenant\'s rows, which is the database it opened')

  // A value set reads its options off a MODEL, and a device only has the ones
  // that declared `@@sync`. The set is carried either way — a field bound to it
  // still has to validate — and the read that fills a picker is the one that
  // answers nothing, which is a blank dropdown rather than an error.
  for (const name of neededValues) {
    const source_ = valuesByName.get(name)?.source
    if (source_ && isModelName(source, source_) && !keptNames.has(source_))
      note('noted', `valueset ${name}`,
        `its options are read off ${source_}, which is not in the device schema`)
  }

  const schema = {
    imports:   [],                       // resolved by parseFile before this ran
    databases: [],
    models,
    views:     [],
    enums:     (source.enums ?? []).filter(e => neededEnums.has(e.name)).map(stripEnum),
    functions: (source.functions ?? []).map(stripComments),
    traits:    [],                       // resolved into the models by parse()
    types:     (source.types ?? []).filter(t => neededTypes.has(t.name)).map(stripType),
    valuesets: (source.valuesets ?? []).filter(v => neededValues.has(v.name)).map(stripComments),
    extends:   [],                       // resolved into the models by parse()
    claims:    [...(source.claims ?? [])],
    tenancy:   null,
  }

  return {
    parsed: { schema, valid: true, errors: [], warnings: [] },
    models: models.map(m => m.name),
    notes,
  }
}

// ─── the cuts ─────────────────────────────────────────────────────────────

// A `///` comment addresses whoever edits the schema, and nothing on a device
// does — `ddl.js` writes it into the CREATE TABLE, so unfiltered it reaches the
// device twice, in the tree and in the SQL.
//
// Emptied rather than deleted: `comments` is part of a node's shape and several
// readers take `model.comments.length` without asking, so a node missing the
// key is a throw inside DDL generation rather than a node with no prose.
function stripComments(node) {
  return { ...node, comments: [] }
}

const stripEnum = (e) => stripComments({ ...e, values: (e.values ?? []).map(stripComments) })
const stripType = (t) => stripComments({ ...t, fields: (t.fields ?? []).map(stripComments) })

// ─── asking the tree ──────────────────────────────────────────────────────

const isModelName = (schema, name) => (schema.models ?? []).some(m => m.name === name)

/** The scalar column a relation is stored in, for the note that says it stayed. */
function foreignKeyOf(field) {
  const rel = (field.attributes ?? []).find(a => a.kind === 'relation')
  return (rel?.fields ?? []).join(', ') || null
}

/**
 * Every name a field's ATTRIBUTES refer to, which its type never mentions.
 *
 * Two of them, and a walk over types alone misses both. `Json @type(Address)`
 * is how a `type` is bound to a column at all — the field's own type is `Json`
 * — so a projection reading types only ships the column and not its shape.
 * `@values(TaskTag)` binds the legal values, and `dependsOn: countryId` names
 * the source the list is filtered against.
 */
function namesReferredToBy(field) {
  const out = []
  for (const attr of field.attributes ?? []) {
    if (attr.kind === 'type' && typeof attr.name === 'string') out.push(attr.name)
    if (attr.kind !== 'values') continue
    if (typeof attr.set === 'string') out.push(attr.set)
    if (typeof attr.dependsOnSource === 'string') out.push(attr.dependsOnSource)
  }
  return out
}

/**
 * Does a policy expression name one of the relations that came out?
 *
 * A generic walk rather than a reading of the expression grammar: this decides
 * a NOTE and nothing else, and a second copy of that grammar here would go
 * stale against `@frontierjs/toolbelt/predicate` with nothing saying so.
 */
function walksDropped(expr, dropped) {
  if (!dropped.size || !expr) return false
  let found = false
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && (key === 'name' || key === 'field' || key === 'path') && dropped.has(value)) {
        found = true
        return
      }
      walk(value)
    }
  }
  walk(expr)
  return found
}
