// src/testing.js — Test helpers for Litestone
//
// Import from '@frontierjs/litestone/testing'
// Never imported in production code.

export { Factory, defineFactory, Seeder, runSeeder, loadFixture, parseCsv } from './seeder.js'
export { FAKE, fakeFor } from './fake.js'
export { deriveAccess, renderAccessSnapshot, gateLadder, policyExprToString,
         expectedVerdict, levelLabel, REACHABLE_LEVELS } from './access.js'
export { schemaMutants, mutationScore } from './mutate.js'
export { tempDir, reapTempDirs } from './tmp-dirs.js'

import { parse, inlineImportsFromDisk } from './core/parser.js'
import { modelToAccessor }          from './core/ddl.js'
import { createClient, buildRelationMap } from './core/client.js'
import { cloneInto }                from './testdb.js'
import { parseGateString, GatePlugin }  from './plugins/gate.js'
import { AccessDeniedError }        from './core/plugin.js'
import { levelLabel, REACHABLE_LEVELS, deriveAccess, gateLadder, expectedVerdict } from './access.js'
import { DEFAULT_MESSAGES, validateField } from './core/validate.js'
import { buildPolicyMap, evalJs }   from './core/policy.js'
import { fakeFor, fakeEmail }       from './fake.js'
import { capabilityNames }          from './core/capabilities.js'
import { Factory }                  from './seeder.js'
import { tempDir }                  from './tmp-dirs.js'
import { parseDuration }            from './tools/retention.js'
import { existsSync, readFileSync } from 'fs'
import { join }                     from 'path'

// ─── makeTestClient ───────────────────────────────────────────────────────────
//
// One-call test setup: parse schema → create fresh db → apply DDL → open client.
//
// opts:
//   seed          {number}   RNG seed forwarded to all factories
//   factories     {object}   { modelName: FactoryClass, ... }
//   autoFactories {boolean}  Auto-generate factories for all sqlite models (default: false)
//   data          {Function} async (db) => {...}  seeder called after tables created
//   [createClient opts]      encryption, plugins, hooks, etc. forwarded transparently
//
// Returns: { db, factories }
//
// Note: When using autoFactories, all FK fields default to 1.
// Seed FK parents in the `data` option or use withRelation() to avoid FK violations.

// ─── The clock ────────────────────────────────────────────────────────────────
//
// `createClient({ now })` has always taken a clock. What a suite could not do is
// MOVE it, and moving it is the whole point: the bugs worth a test here are
// crossings — a window that opens, a schedule at a boundary, a retention that
// expires — and a frozen instant can only ever assert one side of one.
//
// So the option is normalised into a holder every client this env opens reads
// through, and the holder is handed back on `env.clock`.
//
// WHAT IT DOES NOT COVER, and it is not a small caveat: `@default(now())` and
// `@updatedAt` are stamped by SQLITE, not by this — a column DEFAULT and an
// AFTER UPDATE trigger, both `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (`ddl.js`).
// Freezing the clock does not move them. A suite that needs a row to be old
// STATES its timestamp on the write, which works because a column default only
// applies to a column the write omits. What the clock does move is `now()` in a
// policy and `@@softDelete`'s stamp. See `FJS-531`.

function makeTestClock(source) {
  // A function is the caller's own source and they keep it. Moving it here would
  // be two things claiming to say what time it is, and the loser would be
  // whichever one the reader did not have in mind.
  const owned = typeof source === 'function'
  let fixed   = owned ? null : toDate(source)

  const refuseOwned = (verb) => {
    if (owned) throw new Error(
      `createTestEnv: cannot ${verb}() a clock passed as a function — that source is yours to move. ` +
      `Pass a Date or an ISO string instead, or move your own holder.`)
  }

  return {
    /** The instant every client reads. */
    now: () => owned ? toDate(source()) : (fixed ?? new Date()),

    /** Freeze at, or move to, an instant. Answers the new one. */
    set(at) {
      refuseOwned('set')
      fixed = toDate(at)
      return fixed
    },

    /**
     * Move by a duration — `'90m'`, `'2d'`, `'1y'`, or milliseconds. From the
     * wall clock this also FREEZES, because a moving clock plus an offset is a
     * clock that is still moving and the assertion after it would be a race.
     */
    advance(by) {
      refuseOwned('advance')
      const ms = typeof by === 'number' ? by : parseDuration(by, 'clock')
      if (ms == null) throw new Error(`createTestEnv: clock.advance() needs a duration — '90m', '2d', or milliseconds`)
      fixed = new Date((fixed ?? new Date()).getTime() + ms)
      return fixed
    },

    /** Is time standing still? False for the wall clock and for a caller's own source. */
    get frozen() { return !owned && fixed !== null },
  }
}

function toDate(at) {
  if (at == null) return null
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime()))
    throw new Error(`createTestEnv: '${at}' is not a date — pass a Date or an ISO-8601 string`)
  return d
}

export async function makeTestClient(schemaText, opts = {}) {
  const { db, factories } = await _buildEnv(schemaText, opts)
  return { db, factories }
}

// Everything makeTestClient does, plus what createTestEnv needs to open a
// SECOND client on the same files (the paths, and the options it was given).
async function _buildEnv(schemaText, opts = {}) {
  const {
    seed,
    factories: factoryClasses = {},
    autoFactories = false,
    data: seederFn,
    migrations,
    now,
    ...clientOpts
  } = opts

  // The clock is built here rather than passed straight through, because what a
  // suite needs is not a frozen instant but a MOVABLE one: the bugs this exists
  // for are crossings — a window that opens, a retention that expires — and a
  // value can only ever assert one side of one. Every client this env opens
  // reads the same holder, so moving it moves the level clients too.
  const clock = makeTestClock(now)

  const result = parse(schemaText)
  if (!result.valid) throw new Error(`makeTestClient: schema errors:\n${result.errors.join('\n')}`)

  // Unique tmpdir — parallel test runs never collide. tempDir() also reaps the
  // previous runs': nothing here can delete its own directory (tmp-dirs.js),
  // and this helper is called once per test, so the leak was one directory per
  // test in every app that uses it — 28,546 of them on the machine that found
  // it (FJS-361).
  const dir  = tempDir('litestone-test-')
  const path = join(dir, 'test.db')

  // A `database` block WINS over the `db:` option (documented litestone behaviour),
  // so a schema declaring `database main { path "./db/app.db" }` used to make this
  // helper open the PROJECT'S REAL DATABASE and write test rows into it. Every
  // declared path is overridden into the tmpdir so a test can never reach outside.
  //
  // The tables arrive as a file copy from a template this process built once
  // (`testdb.js`) — from the schema's DDL, or by replaying `migrations` when the
  // caller wants the database a deploy actually produces.
  const { dbOverrides } = cloneInto(dir, result.schema, schemaText, migrations ?? null)

  const db = await createClient({
    parsed: result,
    db:     path,
    ...clientOpts,
    now:       () => clock.now(),
    databases: { ...dbOverrides, ...(clientOpts.databases ?? {}) },
  })

  if (seederFn) await seederFn(db)

  const factories = {}

  // Auto-factories: generate for all sqlite models first (lowest priority)
  if (autoFactories) {
    const modelDbMap = {}
    for (const model of result.schema.models) {
      const dbAttr = model.attributes?.find(a => a.kind === 'db')
      modelDbMap[model.name] = dbAttr?.name ?? 'main'
    }
    for (const model of result.schema.models) {
      const dbName = modelDbMap[model.name] ?? 'main'
      const dbDef  = result.schema.databases.find(d => d.name === dbName)
      const driver = dbDef?.driver ?? 'sqlite'
      if (driver === 'jsonl' || driver === 'logger') continue
      const writableFields = model.fields.filter(f => !_shouldSkipField(f, model))
      if (!writableFields.length) continue
      // `factories` is passed as the registry BEFORE it is filled — the object
      // identity is what matters, so has()/attach()/withParents() resolve against
      // whatever it holds at call time, including factories defined after this one.
      factories[modelToAccessor(model.name)] = factoryFrom(result.schema, model.name, db, factories)
    }
  }

  // Explicit factory classes (override auto-generated for same model name)
  for (const [name, FactoryClass] of Object.entries(factoryClasses)) {
    let f = new FactoryClass(db)
    // Hand-written factories get the same relation powers as generated ones.
    f._schema   = result.schema
    f._registry = factories
    if (seed != null) f = f.seed(seed)
    factories[name] = f
  }

  // Apply seed to any auto-generated factories not overridden
  if (seed != null) {
    for (const [name, f] of Object.entries(factories)) {
      if (!factoryClasses[name]) factories[name] = f.seed(seed)
    }
  }

  return { db, factories, parsed: result, dir, path, dbOverrides, clientOpts, clock }
}

// ─── readOnly ─────────────────────────────────────────────────────────────────
//
// A view of a client that can read and cannot write.
//
// The assert phase of a test wants two properties and they are separate: it must
// be GRADED, so "the row exists" is not mistaken for "this user can see it", and
// it must not WRITE, because an assertion that mutates state is what makes a
// retry unsound. `actingAs` gives the first; this gives the second.
//
// The method list is an ALLOW-list, not a deny-list of the writes. A write added
// to litestone later would pass straight through a deny-list, silently, and the
// whole value of this is that it cannot.

const READ_METHODS = new Set([
  'aggregate', 'count', 'exists', 'findFirst', 'findFirstOrThrow', 'findMany',
  'findManyAndCount', 'findManyCursor', 'findUnique', 'findUniqueOrThrow',
  'groupBy', 'query', 'search', 'transitions',
])

// `$` members that answer a question. `$rawDbs` hands out the raw WRITE
// connections and `sql` can write, so neither is here; `asSystem` and
// `$setAuth` would hand back a fresh writable client, which is the same hole.
const READ_MEMBERS = new Set([
  '$schema', '$databases', '$checkWhere', '$checkOrderBy',
])

export function readOnly(client) {
  const refuse = (what) => {
    throw new Error(
      `readOnly: ${what} is not available on a read-only client. This is the assert ` +
      `phase — arrange writes through the system client, and the act is the one ` +
      `mutation a scenario makes.`
    )
  }

  const table = (accessor, real) => new Proxy({}, {
    get(_, method) {
      if (typeof method !== 'string') return undefined
      if (READ_METHODS.has(method)) return real[method]
      // A method the client does not have at all is the client's error to give,
      // not ours — it names the model and lists what exists.
      if (!(method in real)) return real[method]
      return () => refuse(`${accessor}.${method}()`)
    },
    has: (_, p) => p in real,
  })

  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === '$readOnly')      return true
      if (READ_MEMBERS.has(prop))    return client[prop]
      // `asSystem` and `sql` are the two client members that are not
      // `$`-prefixed and must still be refused: one hands back a fresh writable
      // client, the other writes directly and enforces no policy. Named rather
      // than caught by the `$` rule, which does not cover them.
      if (prop.startsWith('$') || prop === 'sql' || prop === 'asSystem') return refuse(prop)
      // Anything else is an accessor. Reading it off the client throws by name
      // when it is a typo, which is the behaviour a caller already relies on.
      return table(prop, client[prop])
    },
    has: (_, p) => p === '$readOnly' || p in client,
  })
}

// ─── createTestEnv ────────────────────────────────────────────────────────────
//
// A migrated database, a client, factories and a principal, in one call.
//
//   const env = await createTestEnv({ schema: 'db/schema.lite', plugins: [...] })
//   const lead = await env.factories.lead.createOne()
//   await expect(env.actingAs(viewer).lead.delete({ where: { id: lead.id } })).rejects.toThrow()
//   await env.close()
//
// `schema` takes the text or a path to a `.lite` file. Everything else is
// forwarded to createClient.
//
// `migrations` builds the template by replaying committed migration files —
// a directory, a `.sql` path, or an array of either — instead of generating DDL
// from the schema. Every test then runs against the database a deploy actually
// produces, and the two drifting apart becomes something a test can see rather
// than something a deploy finds out.
//
// ── The two auth doors are separate on purpose ───────────────────────────────
//
//   actingAs(user)  the principal, through whatever getLevel the app installed
//   atLevel(n)      a synthetic standing, for walking the gate grid
//
// Conflating them is the failure this exists to prevent: a matrix driven by
// atLevel passes in full while the app's own resolver is broken, because the
// resolver was never called. atLevel is for the grid; every test about
// behaviour uses actingAs.
//
// atLevel builds a SECOND client whose GatePlugin answers `n` — the level is
// fixed when a client is constructed, so it cannot be a property of a call —
// and it drops any GatePlugin the caller installed while keeping every other
// plugin. Clients are cached per level and closed with the env.

export async function createTestEnv(opts = {}) {
  const { schema, ...rest } = opts

  if (!schema) throw new Error('createTestEnv: pass `schema` — the .lite text, or a path to it')

  // Imports are spliced in rather than left for parseFile, because ONE text is
  // what the rest of this needs: it is the template cache key (`cloneInto`) and
  // what `atLevel` re-parses. Read the root file alone and two things break
  // together — every executed check grades a schema with the imported models
  // MISSING and passes, so `verifyGateLadder` reports a clean ladder over models
  // it never saw; and the cache key does not cover the imported file, so editing
  // one reuses the previous run's database.
  const isPath = !schema.includes('\n') && existsSync(schema)
  const { text: schemaText, missing } = isPath
    ? inlineImportsFromDisk(schema)
    : { text: schema, missing: [] }

  // Refused, not warned. An unreadable import is a set of models that silently
  // will not be graded, and this is the thing whose whole job is grading them.
  if (missing.length)
    throw new Error(
      `createTestEnv: ${schema} imports ${missing.map(m => `'${m}'`).join(', ')}, ` +
      `which could not be read — those models would go untested.`
    )

  const built  = await _buildEnv(schemaText, rest)
  const levels = new Map()     // level → client
  let   sealed = null

  // The hoisted arrange. Separate from `sealed` on purpose: seal/reset is the
  // manual pair a caller drives, and a suite using both must not have one
  // overwrite the other's snapshot.
  let baseline  = null
  let scenarios = 0

  const env = {
    db:        built.db,
    system:    built.db.asSystem(),
    factories: built.factories,
    // The clock every client this env opened reads. Movable — see makeTestClock.
    clock:     built.clock,
    schema:    built.parsed.schema,
    dir:       built.dir,
    // The main database file. A test that reads the bytes on disk — "is this
    // column actually ciphertext" — needs the path, not the client.
    path:      built.path,

    // The principal your app's getLevel receives. In the Data realm that is the
    // object itself; above the boundary Junction derives it (`toDataPrincipal`)
    // and this is the seam those two have to agree on.
    actingAs: (user) => built.db.$setAuth(user),

    atLevel: async (n, principal = null) => {
      if (!levels.has(n)) {
        const others = (built.clientOpts.plugins ?? []).filter(p => !(p instanceof GatePlugin))
        // Re-parsed rather than sharing the first client's AST: a plugin's
        // onInit may decorate the schema it is given, and two clients quietly
        // sharing one object is not a thing to find out later.
        levels.set(n, await createClient({
          parsed:    parse(schemaText),
          db:        built.path,
          ...built.clientOpts,
          now:       () => built.clock.now(),
          plugins:   [...others, new GatePlugin({ getLevel: () => n })],
          databases: { ...built.dbOverrides, ...(built.clientOpts.databases ?? {}) },
        }))
      }
      // SYSTEM is not reachable through getLevel — the plugin clamps to 0–7.
      // `principal` is for a caller that needs the gate held at a level AND a
      // real `auth()` for the row policies to compare against — the gate grid
      // does not care who the principal is, and `verifyRowPolicies` cares about
      // nothing else.
      if (n === 8) return levels.get(n).asSystem()
      // The synthetic caller holds every capability the schema declares, so a
      // refusal at this level came from the GATE. The grid is ANDed with the
      // ladder (`FJS-D146`) and refuses with the same AccessDeniedError, so a
      // caller holding none would report every write on an opted-in model as a
      // deny no gate issued — the same isolation problem `@guarded` columns and
      // row policies already have here, and the same answer: take the other
      // rule out of the way rather than grade two rules with one assertion
      // (`FJS-351`). A stated `principal` is left exactly as given: a caller
      // building one is asking about a specific person, and a set injected
      // under them is a grant they did not write.
      return levels.get(n).$setAuth(
        principal ?? { id: 'test-principal', capabilities: [...capabilityNames(built.parsed.schema)] })
    },

    // Every gated model's ladder, model name attached. The axis, not the run.
    gateMatrix: (modelName = null) =>
      deriveAccess(built.parsed.schema).models
        .filter(m => m.gate && (!modelName || m.name === modelName))
        .flatMap(m => gateLadder(m).map(row => ({ model: m.name, ...row }))),

    /**
     * Every gated model's ladder, actually executed: each declared level against
     * a real client, for each of the four operations.
     *
     * Read needs no fixture — it either refuses or answers. The other three do,
     * which is why they arrived later: create needs a valid row, update and
     * delete need one already there. The factory machinery `verifyConstraints`
     * proved out supplies all three, so `ops` defaults to all four now.
     *
     * `against` supplies the expectations from a DIFFERENT schema than the one
     * this client was built from — which is the whole of schema mutation
     * testing. Deriving the ladder from the mutant is the oracle problem at its
     * purest: drop a `@@gate` and the rows that would have caught it disappear
     * with it, so the mutant survives and the score reads 100%.
     */
    verifyGateLadder: async ({ against = null, ops = ['read', 'create', 'update', 'delete'] } = {}) => {
      const schema = against ?? built.parsed.schema
      const wanted = new Set(ops)
      const access = deriveAccess(schema)
      const rows   = access.models.filter(m => m.gate)
        .flatMap(m => gateLadder(m).map(r => ({ model: m.name, ...r })))
        .filter(r => wanted.has(r.op))
      if (!rows.length) return []

      // A gate REFUSES and a policy FILTERS, and on a write both arrive as the
      // same AccessDeniedError — so an operation a row policy covers cannot have
      // its gate isolated by a synthetic principal, which by construction
      // matches no predicate. Named rather than skipped: `Server.create` on
      // basecamp reports `allow` from the schema and `deny` from the client, and
      // the policy is the correct answer.
      const policied = (model, op) => {
        const m = access.models.find(x => x.name === model)
        return Boolean(m?.policies?.[op]?.allows?.length || m?.policies?.[op]?.denies?.length)
      }

      // The same problem one layer down. @guarded is a system-context lock on
      // the write as well as the read, so a payload naming one is refused
      // before the gate is reached — and the refusal is an AccessDeniedError,
      // indistinguishable here from the gate itself. The column is dropped from
      // the fixture where it can be; where the schema requires it, no
      // non-system caller can create the model at all and the row is reported
      // ungraded rather than as a deny no gate issued.
      const _guardedFields = (model) =>
        (schema.models.find(x => x.name === model)?.fields ?? [])
          .filter(f => f.attributes?.some(a => a.kind === 'guarded'))

      const sys        = built.db.asSystem()
      const mismatches = []
      const before     = snapshot(built.db)
      const { chain }  = _chains(schema, sys)

      // Grouped by model so ONE factory clone serves every row of that model and
      // its sequence advances across them. Re-cloning per row restarts the seq,
      // and the fifth write of a model with a `@unique` column then collides —
      // 22 error rows on a five-field schema, none of them about the gate.
      const byModel = new Map()
      for (const row of rows) {
        if (!byModel.has(row.model)) byModel.set(row.model, [])
        byModel.get(row.model).push(row)
      }

      try {
        for (const [modelName, modelRows] of byModel) {
        const factory = chain(modelName)
        const guarded = _guardedFields(modelName)
        // Required means the create cannot be assembled without it: no default,
        // no `?`. An optional one is simply left out.
        const guardedRequired = guarded.filter(f =>
          !f.type.optional && !f.attributes.some(a => a.kind === 'default'))
        const guardedOptional = guarded.filter(f => !guardedRequired.includes(f))

        for (const row of modelRows) {
          const acc    = modelToAccessor(row.model)
          const client = await env.atLevel(row.level)

          // Every WRITE row starts from the same rows. The alternative is to
          // make thirty-six fixtures per model distinct from each other, and the
          // two paths that build them — fresh parents for create, a seeded child
          // for update/delete — hold SEPARATE parent factories that each count
          // from one. They collide on the parent's `@unique`, and a UNIQUE error
          // at this layer is indistinguishable from the gate refusing; getting
          // it wrong cost 134 rows of noise that looked like findings.
          //
          // A read builds no fixture and cannot be confused by leftovers — it
          // either refuses or answers, whatever is in the table — so it skips
          // the restore, which is a quarter of the ladder's whole cost.
          if (row.op !== 'read') restore(built.db, before)

          // The fixture each operation needs, built as SYSTEM so a gate refusing
          // the principal cannot refuse the setup — the same split `arrange` and
          // `act` make. Anything that fails HERE is the harness, not the gate,
          // and lands as `error` below rather than as a verdict.
          let run
          try {
            if (row.op === 'read')   run = () => client[acc].findMany({ limit: 1 })
            const idKey = _idField(schema, row.model)

            if (row.op === 'create') {
              // Fresh PARENTS, and no child. Taking the FKs off an existing
              // child instead points the new row at the same parents, which a
              // `@@unique([aId, bId])` join model refuses — 20 error rows on
              // basecamp, every one of them a join table and none of them about
              // the gate. `buildOne` alone is not enough either: its FKs point
              // at nothing, and the write fails on the constraint rather than
              // reaching the gate.
              const data = factory.buildOne(await _freshParents(schema, row.model, chain))
              // The id comes out only where something else will make one. A key
              // with no `@default` is CALLER-supplied and required, so stripping
              // it fails the required check and the gate is never asked — which
              // is what `OutpostNonce` (`nonce String @id`) reported at every
              // level. `_columnPayload` already draws this line for the tenancy
              // checker; drawing it differently here is how one harness grades a
              // model the other cannot build.
              if (_hasDefault(schema, row.model, idKey)) delete data[idKey]
              // The optional ones come out: they are refused below level 8 and
              // the row does not need them. A REQUIRED one stays in, so the
              // write reaches the field lock and is classified below — stripping
              // it would fail the required check instead, which says nothing
              // about either lock. Level 8 IS asSystem() and writes them all.
              if (row.level < 8) for (const f of guardedOptional) delete data[f.name]
              run = () => client[acc].create({ data })
            } else if (row.op !== 'read') {
              // Update and delete need a row that is already there, made as
              // SYSTEM so a gate refusing the principal cannot refuse the setup.
              const seeded = await factory.createOne()
              const id     = seeded[idKey]
              const patch = _touch(schema, row.model, seeded)
              if (row.level < 8) for (const f of guarded) delete patch[f.name]   // an update names only what it changes
              run = row.op === 'update'
                ? () => client[acc].update({ where: { [idKey]: id }, data: patch })
                : () => client[acc].delete({ where: { [idKey]: id } })
            }
          } catch (err) {
            mismatches.push({
              ...row, got: 'error', thrown: err.message,
              message: `${row.model}.${row.op} at level ${row.level} (${row.label}) — no fixture could be built, so the gate was never asked: ${err.message}`,
            })
            continue
          }

          let got, thrown = null
          try { await run(); got = 'allow' }
          catch (err) {
            // Only a refusal counts as a refusal. Treating every throw as `deny`
            // is a false green: a model whose read fails because its table does
            // not exist would then PASS at every level the gate refuses, which is
            // most of them.
            const refused = err instanceof AccessDeniedError || err?.name === 'AccessDeniedError'
            got    = refused ? 'deny' : 'error'
            thrown = refused ? null   : (err?.message ?? String(err))
          }

          if (got === 'error') mismatches.push({
            ...row, got, thrown,
            message: `${row.model}.${row.op} at level ${row.level} (${row.label}) — expected ${row.expect}, but the call threw something that is not a refusal: ${thrown}`,
          })
          // Only in the direction a policy can cause. A policy filters, so it
          // can turn an allow into a deny and never the other way — an `allow`
          // where the schema said `deny` is the gate letting something through
          // and no policy explains it. Skipping both directions cost a real
          // kill: lowering a read gate on a model that happens to declare an
          // `@@allow` stopped being graded at all.
          else if (row.expect === 'allow' && got === 'deny' && policied(row.model, row.op)) mismatches.push({
            ...row, got: 'skipped', thrown,
            message: `${row.model}.${row.op} at level ${row.level} (${row.label}) — not graded: the model declares a row policy for ${row.op}, which refuses a synthetic principal before the gate is reached`,
          })
          // A required @guarded column cannot be dropped from a create the way an
          // optional one is, so no non-system caller can assemble the row at all
          // and the gate is never reached. Reported rather than skipped silently:
          // the model IS uncreatable below level 8, which is a fact about the
          // schema somebody should see.
          else if (row.expect === 'allow' && got === 'deny' && row.op === 'create' && guardedRequired.length) mismatches.push({
            ...row, got: 'skipped', thrown,
            message: `${row.model}.${row.op} at level ${row.level} (${row.label}) — not graded: ` +
                     `"${guardedRequired.map(f => f.name).join('", "')}" ${guardedRequired.length > 1 ? 'are' : 'is'} ` +
                     `@guarded and required, so the field lock refuses the write before the gate is asked`,
          })
          else if (got !== row.expect) mismatches.push({
            ...row, got, thrown,
            message: `${row.model}.${row.op} at level ${row.level} (${row.label}) — the schema says ${row.expect}, the client says ${got}`,
          })
        }

        // Between models, not between rows. Rows of one model accumulate on
        // purpose — the factory's sequence keeps them distinct — but two models
        // sharing a parent each build one from their own seq 1 and collide.
        restore(built.db, before)
        }
      } finally {
        restore(built.db, before)
      }

      return mismatches
    },

    // The read column alone — no fixture needed, and the position where being
    // wrong is a disclosure rather than a failed write.
    verifyReadLadder: async (opts = {}) => env.verifyGateLadder({ ...opts, ops: ['read'] }),

    /**
     * Every `@@allow`/`@@deny` read policy, actually executed against rows on
     * both sides of its predicate.
     *
     * **A gate refuses and a policy filters**, which is why this needed its own
     * runner and why it was the last mutant nothing could see: deleting an
     * `@@allow` raises nothing anywhere. It returns MORE rows, and more rows is
     * not an error — it is a disclosure, with a 200 on it.
     *
     * ── The oracle ───────────────────────────────────────────────────────────
     *
     * Litestone compiles a policy TWICE, into two languages: `compileSql` for
     * reads (a WHERE) and `evalJs` for creates (JavaScript). They are
     * independent implementations of one rule, so one can grade the other —
     * this reads rows through the compiled WHERE and asks `evalJs` which of
     * them should have come back. A disagreement means one of the two is wrong.
     *
     * That is not the oracle problem, it is the opposite of it: the exact
     * comparison found `field == null` compiling to `"col" = NULL` while the JS
     * side got it right, so a row could be created and then be invisible to its
     * own author (FJS-195).
     *
     * ── What it refuses ──────────────────────────────────────────────────────
     *
     * A `check(relation)` predicate delegates to another model's policy and is
     * reported rather than guessed at. Same for a model gated above SYSADMIN(7):
     * no principal can read it, so no principal can exercise its policy.
     */
    verifyRowPolicies: async ({ against = null, principal = null,
                                ops = ['read', 'update', 'delete'] } = {}) => {
      const schema     = against ?? built.parsed.schema
      const who        = withDeclaredCapabilities(principal ?? DEFAULT_POLICY_PRINCIPAL, schema)
      const policyMap  = buildPolicyMap(schema, buildRelationMap(schema))
      const access     = deriveAccess(schema)
      const sys        = built.db.asSystem()
      const mismatches = []
      const before     = snapshot(built.db)
      const { chain }  = _chains(schema, sys)
      const ctx        = { auth: who }

      try {
        for (const model of schema.models) {
          if (!_isValidatable(model, schema)) continue

          const acc  = modelToAccessor(model.name)
          const gate = access.models.find(m => m.name === model.name)?.gate

          for (const op of ops) {
            const rules = model.attributes.filter(a =>
              (a.kind === 'allow' || a.kind === 'deny') && a.operations?.includes(op))
            if (!rules.length) continue

            if (gate && gate[op] > 7) {
              mismatches.push({
                model: model.name, op, got: 'skipped', row: null,
                message: `${model.name}.${op} — not graded: gated at ${gate[op]} (${levelLabel(gate[op])}), which no principal can hold, so its ${rules.length} polic(ies) cannot be exercised`,
              })
              continue
            }

            if (rules.some(r => _hasCheckNode(r.expr))) {
              mismatches.push({
                model: model.name, op, got: 'skipped', row: null,
                message: `${model.name}.${op} — not graded: the policy uses check(), which delegates to another model's policy. Reported rather than guessed at`,
              })
              continue
            }

            const idKey   = _idField(schema, model.name)
            const factory = chain(model.name)
            const seeded  = []

            // One row per interesting value, not a cross-product. The values
            // come off the predicate itself — the principal's own value for an
            // `auth()` comparison, the literal for a literal one, null — so
            // there is at least one row on each side of the rule rather than
            // whatever the factory happened to generate.
            //
            // A candidate the column refuses is skipped, not fatal. Whether the
            // rows actually landed on both sides is asserted below, which is
            // the check that matters.
            let lastRefusal = null
            const seed = async (overrides) => {
              try { seeded.push(await factory.createOne(overrides)) }
              catch (err) { lastRefusal = err.message }
            }
            await seed({})
            for (const [field, candidates] of Object.entries(_interestingValues(rules, who, model))) {
              for (const { value } of candidates) {
                // The field a policy compares is very often a FOREIGN KEY —
                // `workspaceId == auth().workspaceId` is the whole of basecamp's
                // tenancy — so a made-up value breaks the FK and the row never
                // exists. Every candidate on the matching side was lost that
                // way, leaving one row, all of it excluded.
                await _ensureParent(schema, model, field, value, chain)
                await seed({ [field]: value })
              }
            }

            if (!seeded.length) {
              mismatches.push({
                model: model.name, op, got: 'error', row: null,
                message: `${model.name}.${op} — no rows could be built, so the policy was never exercised: ${lastRefusal}`,
              })
              restore(built.db, before)
              continue
            }

            // The stored rows BEFORE the operation runs — `delete` removes them
            // and `update` moves them, so the values the policy is compared
            // against have to be captured first.
            const stored = new Map()
            for (const row of seeded) {
              const s = await sys[acc].findUnique({ where: { [idKey]: row[idKey] } })
              if (s) stored.set(row[idKey], s)
            }

            let admitted
            try { admitted = await _runPolicyOp(op, await env.atLevel(7, who), acc, schema, model, idKey, [...stored.values()]) }
            catch (err) {
              mismatches.push({
                model: model.name, op, got: 'error', row: null,
                message: `${model.name}.${op} — the call threw rather than filtering, which a policy never does: ${err.message}`,
              })
              restore(built.db, before)
              continue
            }

            const sides = new Set()
            for (const [id, row] of stored) {
              const expected = _policyAdmits(rules, ctx, row, model.name, policyMap)
              const got      = admitted.has(id)
              sides.add(expected)
              if (expected === got) continue

              mismatches.push({
                model: model.name, op, got: got ? 'admitted' : 'filtered', row: id,
                message: expected
                  ? `${model.name}#${id} — the ${op} policy admits this row and the ${op} did not reach it`
                  : `${model.name}#${id} — the ${op} policy excludes this row and the ${op} reached it anyway`,
              })
            }

            // Rows on ONE side only prove nothing: a policy that admits
            // everything and a policy that is not applied at all are the same
            // observation when every row matches. Said out loud rather than
            // counted as a pass, because a green run over one-sided data is the
            // exact shape this whole realm exists to stop.
            if (sides.size < 2) mismatches.push({
              model: model.name, op, got: 'error', row: null,
              message: `${model.name}.${op} — not graded: all ${stored.size} seeded row(s) fall on the same side of the policy (${sides.has(true) ? 'all admitted' : 'all excluded'}), so the filter was never distinguished from no filter at all`,
            })

            restore(built.db, before)
          }
        }
      } finally {
        restore(built.db, before)
      }

      return mismatches
    },

    /**
     * Every tenant-scoped model, actually crossed.
     *
     * `verifyRowPolicies` grades a compiled WHERE against litestone's own JS
     * evaluator, which is sound for a rule it can evaluate and reports a rule
     * holding a `check()` as not-graded by name. Declared tenancy generates both
     * kinds — a column comparison for a model carrying the column, a `check()`
     * delegation for one scoped through a parent — so on basecamp that grader
     * covers 18 models and declines 14, and `FJS-382` is what the declined half
     * costs: the two implementations of `check()` disagreed about a null foreign
     * key, every scoped read dropped the row, and the grader called the policy
     * correct throughout.
     *
     * This asks the question the other way round and needs no second
     * implementation to compare against: seed a row for tenant A, then have
     * tenant B and a caller with no tenant at all try to reach it. A row B can
     * see is a finding whether the rule naming it is one comparison or six
     * delegations deep.
     *
     * Both sides are asserted. A run where B reaches nothing proves nothing on
     * its own — a policy that admits nobody and a model nothing was seeded into
     * are the same observation — so A must reach its own row or the row is
     * reported `unreachable` rather than counted as isolation.
     *
     * Five moves, and the last two are the ones a column comparison alone does
     * not cover: `create` is B placing a row in A's tenant, `post-update` is B
     * moving a row it legitimately owns into A's, which is the move the
     * generated `post-update` deny exists for.
     *
     * **A model nothing scopes is a finding, not a skip.** The desugar errors on
     * `@@tenant(via:)` naming an unscoped parent and stays silent for a model
     * that names no `via` and has no scoped parent to infer one from — so the
     * shape that reaches production is the quiet one, and it is exactly the
     * shape this reports.
     *
     * `actors` overrides the two principals for a membership the declaration
     * cannot describe — a standing that is a join, a claim minted by a resolver.
     * The default is derived from `tenancy { }` alone, which is what every app
     * on the feature already has.
     */
    verifyTenantIsolation: async ({ against = null, actors = null,
                                   ops = ['read', 'create', 'update', 'delete', 'post-update'] } = {}) => {
      const schema  = against ?? built.parsed.schema
      const t       = schema.tenancy
      const wanted  = new Set(ops)
      const out     = []

      // Said out loud rather than answered with an empty array, which reads as
      // a pass everywhere it is asserted.
      if (!t) return [{
        model: null, op: null, actor: null, got: 'skipped',
        message: 'not graded: this schema declares no `tenancy { }` block, so there is no tenant for one caller to cross into',
      }]

      // Under `strategy database` a tenant is a FILE and isolation is the
      // filesystem: there is no query that reaches two tenants because there is
      // no connection that holds two. This env builds one client over one
      // database, so the crossing it would grade cannot be expressed here — and
      // grading the predicate that does not exist would be a green run over
      // nothing. The drive that can see it holds two registries.
      if (t.strategy !== 'row') return [{
        model: null, op: null, actor: null, got: 'skipped',
        message: `not graded: strategy '${t.strategy}' isolates tenants by database file, not by a predicate — one client cannot reach two, so there is nothing here to cross. A drive holding the registry proves that strategy (example: verify:tenants)`,
      }]

      const sys       = built.db.asSystem()
      const access    = deriveAccess(schema)
      const { chain } = _chains(schema, sys)

      // Two snapshots, and the distinction is load-bearing. The two tenants are
      // FIXTURE — every model's seed points at them — so the per-model restore
      // must land after they exist. Rolling back past them instead means the
      // first model that finishes cleanly takes the tenants with it, and every
      // model after it fails to seed with a foreign key error that says nothing
      // about tenancy. Measured on basecamp: 28 of 29 scoped models reported
      // `error` because the first one passed.
      const origin = snapshot(built.db)
      let   before = origin

      try {
        const [va, vb] = actors
          ? [actors[0]?.[t.claim], actors[1]?.[t.claim]]
          : await _tenantValues(schema, chain, sys)

        if (va == null || vb == null) return [{
          model: null, op: null, actor: null, got: 'error',
          message: `not graded: could not establish two tenants — the '${t.column}' column is ${t.column in (schema.models[0] ?? {}) ? 'present' : 'declared'} but no value for it could be built. Pass actors: [a, b] to state them`,
        }]

        const who = (label, value) => actors && label !== 'nobody'
          ? (label === 'A' ? actors[0] : actors[1])
          : withDeclaredCapabilities(
              { ...DEFAULT_POLICY_PRINCIPAL, id: `tenant-${label}`, userId: `tenant-${label}`, [t.claim]: value }, schema)

        const A        = who('A', va)
        const B        = who('B', vb)
        const NOBODY   = withDeclaredCapabilities(
          { ...DEFAULT_POLICY_PRINCIPAL, id: 'tenant-nobody', userId: 'tenant-nobody', [t.claim]: null }, schema)
        const clientA  = await env.atLevel(7, A)
        const clientB  = await env.atLevel(7, B)
        const clientN  = await env.atLevel(7, NOBODY)

        before = snapshot(built.db)

        for (const model of schema.models) {
          if (!_isValidatable(model, schema)) continue

          const kind = _tenantKind(schema, model)

          if (kind === 'exempt') {
            out.push({ model: model.name, op: null, actor: null, got: 'exempt',
              message: `${model.name} — @@tenant(none): declared to span tenants, so no crossing is graded` })
            continue
          }

          // The silent shape. A model with no tenant column and no scoped parent
          // to delegate to is not exempt and not scoped — every caller of every
          // tenant reads every row, and the schema says nothing about it.
          if (kind === 'unscoped') {
            out.push({ model: model.name, op: null, actor: null, got: 'unscoped',
              message: `${model.name} — nothing scopes this model: it carries no '${t.column}' column and no required relation to a model that does, and it does not declare @@tenant(none). Every tenant reads every row. Give it the column, scope it through a parent with @@tenant(via: rel), or declare the exemption` })
            continue
          }

          const acc   = modelToAccessor(model.name)
          const idKey = _idField(schema, model.name)
          const gate  = access.models.find(m => m.name === model.name)?.gate

          // A model that isolates correctly produces no finding, which is
          // exactly what a model nothing ran against produces. `FJS-513` is a
          // checker declining 14 models in silence, so this one says which ones
          // it crossed — the coverage is the result, not the absence of one.
          out.push({ model: model.name, op: null, actor: null, got: 'graded',
            message: `${model.name} — scoped by ${kind === 'column' ? `'${_tenantColumn(schema, model)}'` : 'delegation'}, crossed on ${[...wanted].join(', ')} as tenant B and as a caller holding no claim` })

          // One seeding pass per model, reused by every read-shaped assertion.
          // The destructive moves re-seed, because a delete that correctly
          // refuses and a delete that removed the row are the same absence on
          // the next assertion.
          const parents = new Map()
          let rowA
          try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
          catch (err) {
            out.push({ model: model.name, op: null, actor: null, got: 'error',
              message: `${model.name} — no row could be seeded for tenant A, so nothing about this model was crossed: ${err.message}` })
            restore(built.db, before)
            continue
          }

          const id = rowA[idKey]

          // ── read ────────────────────────────────────────────────────────────
          if (wanted.has('read')) {
            if (gate && gate.read > 7) {
              out.push({ model: model.name, op: 'read', actor: null, got: 'uncheckable',
                message: `${model.name}.read — gated at ${gate.read} (${levelLabel(gate.read)}), which no principal can hold: the row boundary refuses before the tenant one is reached` })
            } else {
              const reach = async (client) => {
                try { return new Set((await client[acc].findMany({ limit: 50 })).map(r => r[idKey])) }
                catch (err) {
                  if (err instanceof AccessDeniedError || err?.name === 'AccessDeniedError') return null
                  throw err
                }
              }
              const seenB = await reach(clientB)
              const seenN = await reach(clientN)
              const seenA = await reach(clientA)

              if (seenB?.has(id)) out.push({ model: model.name, op: 'read', actor: 'B', got: 'leaked',
                message: `${model.name}#${id} belongs to tenant A and a caller in tenant B read it` })
              if (seenN?.has(id)) out.push({ model: model.name, op: 'read', actor: 'nobody', got: 'leaked',
                message: `${model.name}#${id} belongs to tenant A and a caller holding no '${t.claim}' at all read it` })

              // The vacuity guard. Without it a model whose rows nobody can see
              // reports perfect isolation.
              if (seenA && !seenA.has(id)) out.push({ model: model.name, op: 'read', actor: 'A', got: 'unreachable',
                message: `${model.name}#${id} was seeded for tenant A and tenant A cannot read it, so the isolation asserted above is not distinguished from a model nothing can reach` })
            }
          }


          // ── the unparented row ──────────────────────────────────────────────
          //
          // A delegated rule is `!check(rel)`, and `check()` answers TRUE for a
          // null foreign key — a row naming no parent is not a row naming
          // somebody else's (`FJS-382`, and the JS half is the one that matches
          // what the declaration says). So where the scoping relation is
          // OPTIONAL, a row that never got a parent belongs to no tenant and
          // every tenant can reach it.
          //
          // Reported under its own name rather than as a leak, because it is
          // the ruled behaviour and the fix is a schema decision: make the
          // relation required, or give the model the column. A verdict here
          // would be this checker overruling a decision record; silence would
          // be the same hole `unscoped` exists to close.
          if (kind === 'delegated' && wanted.has('read') && (!gate || gate.read <= 7)) {
            const optionalScoped = model.fields.filter(f => {
              if (f.type.kind !== 'relation' || f.type.array) return false
              const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
              if (!rel) return false
              if (!model.fields.find(x => x.name === rel.fields[0])?.type.optional) return false
              return _tenantKind(schema, schema.models.find(m => m.name === f.type.name)) !== 'unscoped'
            }).map(f => f.name)

            if (optionalScoped.length) {
              let orphan = null
              try { orphan = await _seedForTenant(schema, model.name, va, chain, new Map(), { optional: false }) }
              catch { /* it cannot exist unparented, which is the answer this asks for */ }

              if (orphan) {
                let seenB = null
                try { seenB = new Set((await clientB[acc].findMany({ limit: 50 })).map(r => r[idKey])) }
                catch (err) { if (!(err instanceof AccessDeniedError || err?.name === 'AccessDeniedError')) throw err }

                if (seenB?.has(orphan[idKey])) out.push({ model: model.name, op: 'read', actor: 'B', got: 'unparented',
                  message: `${model.name} is scoped through ${optionalScoped.map(r => `'${r}'`).join(' + ')}, which is optional — a row created without one belongs to no tenant and every tenant reads it. Make the relation required, or give ${model.name} the '${t.column}' column` })
              }

              restore(built.db, before)
              parents.clear()
              try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
              catch { rowA = null }
            }
          }

          // ── create — B places a row in A's tenant ───────────────────────────
          if (wanted.has('create') && rowA && (!gate || gate.create <= 7)) {
            const payload = _columnPayload(schema, model, rowA)
            if (payload) {
              // The probe row is removed first so its @unique values are free:
              // a create refused by a UNIQUE constraint is not a create refused
              // by tenancy, and the two are the same throw from here.
              try { await sys[acc].delete({ where: { [idKey]: id } }) } catch { /* a @@softDelete model keeps it; the retry below still tells us */ }

              let made = null
              let threw = null
              try { made = await clientB[acc].create({ data: payload }) }
              catch (err) { threw = err }

              if (made) out.push({ model: model.name, op: 'create', actor: 'B', got: 'leaked',
                message: `${model.name} — a caller in tenant B created a row carrying tenant A's ${kind === 'column' ? `'${_tenantColumn(schema, model)}'` : 'parent'}, so a row can be placed inside a tenant its author does not belong to` })

              // A refusal is only evidence when it is the ACCESS boundary
              // refusing. A UNIQUE violation, a missing column, a check
              // constraint — each is a create that did not happen for a reason
              // that has nothing to say about tenancy, and counting one as
              // isolation is the shape this whole check exists to refuse.
              else if (threw && !(threw instanceof AccessDeniedError || threw?.name === 'AccessDeniedError'))
                out.push({ model: model.name, op: 'create', actor: 'B', got: 'error',
                  message: `${model.name}.create — not graded: the write was refused by something other than access, so whether tenancy would have refused it is unknown: ${threw.message}` })

              restore(built.db, before)
              parents.clear()
              try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
              catch { rowA = null }
            }
          }

          // ── post-update — B moves its OWN row into A's tenant ───────────────
          if (wanted.has('post-update') && rowA && (!gate || gate.update <= 7)) {
            let rowB = null
            try { rowB = await _seedForTenant(schema, model.name, vb, chain, new Map()) }
            catch { /* B's own row could not be built; the move below is unaskable */ }

            if (rowB) {
              const move = _tenantMove(schema, model, va, parents)
              if (move) {
                let moved = null
                try { moved = await clientB[acc].update({ where: { [idKey]: rowB[idKey] }, data: move }) }
                catch { /* refused */ }

                // A refusal and a no-match are both acceptable; what is not is
                // the row arriving in A's tenant.
                const after = moved ? await sys[acc].findUnique({ where: { [idKey]: rowB[idKey] } }) : null
                const key   = Object.keys(move)[0]
                if (after && String(after[key]) === String(move[key])) out.push({
                  model: model.name, op: 'post-update', actor: 'B', got: 'leaked',
                  message: `${model.name}#${rowB[idKey]} started in tenant B and a caller in tenant B moved it into tenant A by writing '${key}'` })
              }
            }
            restore(built.db, before)
            parents.clear()
            try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
            catch { rowA = null }
          }

          // ── update / delete — B reaches into A ──────────────────────────────
          for (const op of ['update', 'delete']) {
            if (!wanted.has(op) || !rowA) continue
            if (gate && gate[op] > 7) {
              out.push({ model: model.name, op, actor: null, got: 'uncheckable',
                message: `${model.name}.${op} — gated at ${gate[op]} (${levelLabel(gate[op])}), which no principal can hold` })
              continue
            }

            const stored = await sys[acc].findUnique({ where: { [idKey]: rowA[idKey] } })
            if (!stored) continue

            for (const [label, client] of [['B', clientB], ['nobody', clientN]]) {
              let reached
              try { reached = await _runPolicyOp(op, client, acc, schema, model, idKey, [stored]) }
              catch (err) {
                if (err instanceof AccessDeniedError || err?.name === 'AccessDeniedError') { reached = new Set() }
                else throw err
              }
              if (reached.has(stored[idKey])) out.push({ model: model.name, op, actor: label, got: 'leaked',
                message: label === 'B'
                  ? `${model.name}#${stored[idKey]} belongs to tenant A and a caller in tenant B ${op}d it`
                  : `${model.name}#${stored[idKey]} belongs to tenant A and a caller holding no '${t.claim}' ${op}d it` })

              restore(built.db, before)
              parents.clear()
              try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
              catch { rowA = null }
              if (!rowA) break
            }

            // The other side: A must still reach its own row, or the two
            // refusals above are indistinguishable from a model no write reaches.
            if (rowA) {
              const mine = await sys[acc].findUnique({ where: { [idKey]: rowA[idKey] } })
              let ownReach
              try { ownReach = await _runPolicyOp(op, clientA, acc, schema, model, idKey, mine ? [mine] : []) }
              catch { ownReach = new Set() }
              if (mine && !ownReach.has(mine[idKey])) out.push({ model: model.name, op, actor: 'A', got: 'unreachable',
                message: `${model.name}#${mine[idKey]} was seeded for tenant A and tenant A cannot ${op} it, so the refusals asserted above are not distinguished from a model no ${op} reaches` })
              restore(built.db, before)
              parents.clear()
              try { rowA = await _seedForTenant(schema, model.name, va, chain, parents) }
              catch { rowA = null }
            }
          }

          restore(built.db, before)
        }
      } finally {
        // The tenants themselves go too — they are this check's fixture, not
        // the caller's data.
        restore(built.db, origin)
      }

      return out
    },

    /**
     * Every `@guarded` / `@encrypted` / `@secret` field, actually read.
     *
     * The gate ladder says who may read the ROW; this says which COLUMNS come
     * back when they do. They are separate boundaries and a model can pass one
     * while failing the other — basecamp's `Secret.data` is `@guarded` under a
     * gate that admits ADMINISTRATOR(5), so the field policy is the only thing
     * between an admin and a private key.
     *
     * Asserts absence, not nullity: `@guarded` removes the key, and a `null`
     * would be a value the caller could still act on.
     */
    verifyFieldProtection: async ({ against = null, principal = null } = {}) => {
      const schema     = against ?? built.parsed.schema
      const who        = withDeclaredCapabilities(principal ?? DEFAULT_POLICY_PRINCIPAL, schema)
      const sys        = built.db.asSystem()
      const mismatches = []
      const before     = snapshot(built.db)
      const { chain }  = _chains(schema, sys)

      try {
        for (const model of schema.models) {
          if (!_isValidatable(model, schema)) continue
          const protectedFields = model.fields.filter(f =>
            f.attributes.some(a => a.kind === 'guarded' || a.kind === 'encrypted' || a.kind === 'secret' || a.kind === 'hashed'))
          if (!protectedFields.length) continue

          const acc = modelToAccessor(model.name)

          // Seeded to SATISFY the model's own read policy. A policy filters, so
          // an ordinary generated row is invisible to the reader below and the
          // whole model reports as unchecked — which is what happened the
          // moment a model in the fixtures gained an `@@allow`.
          const readRules = model.attributes.filter(a =>
            (a.kind === 'allow') && a.operations?.includes('read'))
          const matching = {}

          // Row tenancy generates a DENY, and only allows are read above — so a
          // scoped model was seeded with an arbitrary tenant, the reader below
          // could not see it, and every protected field on it reported as
          // unchecked. Silent for `@@allow` apps and total for declared ones:
          // basecamp's whole schema stopped being covered the moment it adopted
          // the block (`FJS-381`).
          Object.assign(matching, _tenantStamp(schema, model, who))

          for (const [field, candidates] of Object.entries(_interestingValues(readRules, who, model))) {
            // Only a TARGETED value — one taken off the predicate — puts the row
            // on the matching side. The others exist to put a row on the other
            // one, and seeding with those hid the row from the very reader this
            // is about to check.
            const hit = candidates.find(c => c.targeted)
            if (hit) matching[field] = hit.value
          }

          // The field a policy compares is very often a FOREIGN KEY, so the
          // targeted value names a parent that does not exist and the child is
          // refused by the constraint rather than by anything about access.
          // Same call `verifyRowPolicies` makes, for the same reason.
          for (const [field, value] of Object.entries(matching))
            await _ensureParent(schema, model, field, value, chain)

          let seeded
          try { seeded = await chain(model.name).createOne(matching) }
          catch (err) {
            mismatches.push({
              model: model.name, field: null, level: null, got: 'error', thrown: err.message,
              message: `${model.name} — no row could be built, so none of its ${protectedFields.length} protected field(s) were checked: ${err.message}`,
            })
            continue
          }

          // SYSADMIN(7) is the highest standing `getLevel` can answer, and the
          // one that matters: `@guarded` keys on asSystem(), not on a level, so
          // the whole claim is that no place on the ladder reaches the column.
          //
          // A model gated at SYSTEM refuses the read outright, which is the row
          // boundary answering before the field one is reached. Not an exposure
          // and not a miss — there is no reader to hide the column from.
          let row
          try { [row] = await (await env.atLevel(7, who))[acc].findMany({ limit: 1 }) }
          catch (err) {
            if (!(err instanceof AccessDeniedError || err?.name === 'AccessDeniedError')) throw err
            restore(built.db, before)
            continue
          }

          // A row policy filters, so the seeded row can be invisible to the
          // level-7 reader even though the gate admitted it — and then the loop
          // below checks nothing and reports nothing. Silent, and it turned a
          // caught `guarded-drop` mutant into a surviving one the moment the
          // model gained an `@@allow`.
          if (!row) {
            mismatches.push({
              model: model.name, field: null, level: 7, got: 'error', thrown: null,
              message: `${model.name} — the seeded row was not visible to a SYSADMIN(7) reader, so none of its ${protectedFields.length} protected field(s) were checked. A row policy is the usual reason`,
            })
            restore(built.db, before)
            continue
          }

          for (const field of protectedFields) {
            if (field.name in row) mismatches.push({
              model: model.name, field: field.name, level: 7, got: 'exposed', thrown: null,
              message: `${model.name}.${field.name} is protected in the schema and came back to a SYSADMIN(7) reader`,
            })
          }

          // The other half, and not symmetry for its own sake: a column that is
          // absent for EVERYONE is a broken column, and it would pass the check
          // above perfectly.
          const [asSys] = await sys[acc].findMany({ limit: 1 })
          for (const field of protectedFields) {
            if (asSys && !(field.name in asSys)) mismatches.push({
              model: model.name, field: field.name, level: 8, got: 'hidden', thrown: null,
              message: `${model.name}.${field.name} did not come back to asSystem() either — the column is unreadable, not protected`,
            })
          }

          restore(built.db, before)
          void seeded
        }
      } finally {
        restore(built.db, before)
      }

      return mismatches
    },

    /**
     * Arrange / Act / Assert, enforced by what each phase can reach rather than
     * by three comments.
     *
     *   const t = env.phases({ as: developer })
     *   const lead = await t.arrange(({ factories }) => factories.lead.createOne())
     *   await t.act(as => as.lead.remove({ where: { id: lead.id } }))
     *   await t.assert(read => expect(read.lead.count()).resolves.toBe(0))
     *
     * The body stays linear — no callbacks threading state, and a line can still
     * be commented out to bisect. What the phases buy is not tidiness:
     *
     *   arrange  the SYSTEM client and the factories. Writes freely, below the
     *            boundary, announcing nothing.
     *   act      the principal's client, graded by the app's own getLevel.
     *            Exactly one per scenario, and arrange may not follow it.
     *   assert   the principal's READ-ONLY client. Graded, so "the row exists"
     *            cannot stand in for "this user can see it"; read-only, so a
     *            retry of the scenario is sound.
     *
     * Not tied to any runner: this is called inside whatever `test()` the
     * package uses, so bun and Vitest both get it without an adapter.
     *
     * Calling it BEGINS a scenario, which is why it restores `setup()`'s rows
     * when a setup exists — two calls in one test are two scenarios, and the
     * second starting from the fixture is the definition rather than a surprise.
     */
    /**
     * Executes `generateValidationCases` against the real write path and returns
     * the cases that disagreed. The read ladder's sibling: `gateMatrix` and
     * `generateValidationCases` both DESCRIBE a schema, and describing is where
     * a generator's value stops — this is the half that finds out.
     *
     * The oracle is sound because the claim is structural, not textual: the
     * schema declares a constraint, so a value violating it must be refused. The
     * message is not asserted. A rule that reaches the browser and is ignored by
     * the server is exactly the shape this catches (FJS-194 is its cousin — same
     * rule, two different sentences).
     *
     * Runs as SYSTEM. The question is whether the constraint is enforced, and a
     * `@@gate` refusing the write first would answer *rejected* for every case,
     * including the ones nothing validates.
     *
     * Non-destructive: the rows it writes are rolled back by snapshot/restore, so
     * it is safe to call mid-suite.
     */
    verifyConstraints: async (modelName = null, { against = null } = {}) => {
      // `against` states the RULES; the client under test stays this env's.
      // Same reason as verifyReadLadder: a mutant that widens a `@length` also
      // widens the cases generated from it, so both sides move together and
      // nothing disagrees.
      const schema     = against ?? built.parsed.schema
      const sys        = built.db.asSystem()
      const mismatches = []
      const before     = snapshot(built.db)
      // Every model up front, not on demand: `withParents()` resolves a required
      // belongsTo out of the registry, so a lazily-filled one has no parent
      // factory at the moment the first child needs it — and the whole model
      // reports as *the write failed before validation could refuse it*.
      const { chain } = _chains(schema, sys)

      try {
        for (const model of schema.models) {
          if (modelName && model.name !== modelName) continue
          if (!_isValidatable(model, schema)) continue

          let cases
          try { cases = generateValidationCases(schema, model.name) }
          catch { continue }
          if (!cases.invalid.length && !cases.boundary.length && !cases.uncheckable?.length) continue

          // A boundary the generator could not build is REPORTED, never
          // dropped. It is not a defect in the schema and it does not claim to
          // be one — `expect: 'accepted'` with `got: 'uncheckable'` — but a
          // rule that silently stops being asked about is the failure this
          // whole runner exists to prevent, one layer up (`FJS-351`).
          for (const u of cases.uncheckable ?? []) {
            mismatches.push({
              model: model.name, field: u.field, rule: u.rule, value: u.value,
              expect: 'accepted', got: 'uncheckable', thrown: null,
              message: u.message,
            })
          }

          // ── Two collision guards, both measured on basecamp's 37 models ────
          //
          // ONE clone for the whole model, so its sequence advances across
          // cases: every chain method clones from the ORIGINAL, whose seq never
          // moves, so re-cloning per case writes seq 1 every time.
          //
          // `fresh: true` so each create builds NEW parents. Reused parents
          // give every case of a model identical FK values, which collides on
          // any `@@unique` over them — one case on basecamp (`FlagOverride`,
          // `@@unique([flagId, environmentId])`).
          //
          // Both failures look like the validator working, and a UNIQUE error
          // is indistinguishable from a refusal unless it is checked for — which
          // is what the `error` outcome below is.
          // Building the chain can refuse outright — a required self-reference
          // or an A→B→A cycle cannot be satisfied by creating more rows, and
          // `withParents()` says so by name. That is one model this cannot
          // check, not a reason to abandon the other thirty-six, so it is
          // reported the same way an unreachable case is.
          let factory
          try { factory = chain(model.name) }
          catch (err) {
            mismatches.push({
              model: model.name, field: null, rule: null, value: null,
              expect: 'rejected', got: 'error', thrown: err.message,
              message: `${model.name} — no valid row could be built, so none of its ${cases.invalid.length + cases.boundary.length} case(s) ran: ${err.message}`,
            })
            restore(built.db, before)
            continue
          }

          const attempt = async (c, expected) => {
            // A fresh base row per case, never one shared `cases.valid`: the
            // second write of one row collides on the model's own `@unique`.
            let thrown = null
            try {
              await factory.createOne({ [c.field]: c.value })
            } catch (err) { thrown = err }

            // What counts as a refusal depends on which rule is under test, and
            // narrowly: a `@unique` violation IS the refusal here, and is an
            // `error` for every other rule — it is the collision that makes a
            // dead validator look alive. Matching it by rule keeps both true.
            const refused = thrown?.name === 'ValidationError'
              || (c.rule === '@unique' && (thrown?.name === 'UniqueConflictError'
                  || thrown?.name === 'SoftDeletedUniqueError'
                  || /UNIQUE constraint failed/i.test(thrown?.message ?? '')))
            const got = thrown === null ? 'accepted' : (refused ? 'rejected' : 'error')

            // Refused — but by WHICH rule? Every case carries the message its
            // own rule raises, and until `FJS-351` nothing compared it, so a
            // case refused by a DIFFERENT rule on the same field counted as
            // proof of the one it names. `@length(3, 200)`'s `''` on an
            // `@email` column is rejected by `@email`, so deleting `@length`
            // from the implementation left this green — and a mutant that
            // widens it survived, which is the one thing `litestone mutate`
            // exists to catch.
            //
            // A value violating two rules legitimately raises both, and the
            // whole error text is searched, so that case still passes.
            if (got === expected && expected === 'rejected' && c.message
                && !(thrown?.message ?? '').includes(c.message)) {
              mismatches.push({
                model: model.name, field: c.field, rule: c.rule, value: c.value,
                expect: 'rejected', got: 'rejected-by-another-rule', thrown: thrown?.message ?? null,
                message: `${model.name}.${c.field} — ${c.rule} was not what refused this: expected `
                       + `${JSON.stringify(c.message)}, got ${JSON.stringify(thrown?.message ?? null)}. `
                       + `The case proves nothing about the rule it names`,
              })
              return
            }

            if (got === expected) return

            mismatches.push({
              model: model.name, field: c.field, rule: c.rule, value: c.value,
              expect: expected, got, thrown: thrown?.message ?? null,
              message: got === 'error'
                // Not a mismatch about the schema — the case never reached the
                // validator, so it proves nothing either way. Reported rather than
                // swallowed: a case that cannot run is a hole in the coverage the
                // count implies.
                ? `${model.name}.${c.field} — ${c.rule}: the write failed before validation could refuse it: ${thrown.message}`
                : expected === 'rejected'
                  ? `${model.name}.${c.field} — the schema declares ${c.rule} and the write was ACCEPTED`
                  : `${model.name}.${c.field} — ${c.rule} allows this value and the write was refused: ${thrown.message}`,
            })
          }

          // `@unique` is a declared constraint like any other, and the only one
          // whose failing value cannot be generated — it has to be taken off a
          // row that already exists. Left out, dropping a `@unique` was a
          // mutant nothing noticed.
          for (const field of model.fields.filter(f => f.attributes.some(a => a.kind === 'unique'))) {
            let first
            try { first = await factory.createOne() }
            catch (err) {
              mismatches.push({
                model: model.name, field: field.name, rule: '@unique', value: null,
                expect: 'rejected', got: 'error', thrown: err.message,
                message: `${model.name}.${field.name} — @unique could not be checked, no first row: ${err.message}`,
              })
              continue
            }
            // SQLite accepts any number of NULLs in a UNIQUE column, so a
            // nullable `@unique` whose generated value came out null has no
            // duplicate to try. Reported as a false finding on `example`'s
            // `Product.barcode`, whose own doc comment says exactly this.
            if (first[field.name] === null || first[field.name] === undefined) continue
            await attempt({ field: field.name, value: first[field.name], rule: '@unique' }, 'rejected')
          }

          for (const c of cases.invalid)  await attempt(c, 'rejected')
          for (const c of cases.boundary) await attempt(c, 'accepted')

          // Back to the starting rows before the next model — the third guard,
          // and independently load-bearing: 57 errors on basecamp without it,
          // none of them about basecamp. Two models sharing a parent each build
          // a chain from their own factory's seq 1, so the second model's parent
          // is byte-identical to the first's and collides on the parent's
          // `@unique`. Correct on its own terms too: whether model A's rows
          // exist has nothing to do with whether model B's rules are enforced.
          restore(built.db, before)
        }
      } finally {
        restore(built.db, before)
      }

      return mismatches
    },

    /**
     * The arrange every scenario shares, run once.
     *
     *   const fx = await env.setup(({ factories }) => factories.account.createOne())
     *   test('…', async () => {
     *     const t = env.phases({ as: dev })      // ← rows are back at fx
     *     …
     *   })
     *
     * Takes the SAME tools `phases().arrange` takes, so hoisting a line out of a
     * test is a move rather than a rewrite. The rows it wrote are snapshotted,
     * and every later `phases()` restores them — a truncate + bulk re-insert,
     * which beats re-running factories through validation, hooks, gates and FTS.
     *
     * The value it returns stays valid across restores: rows go back with the
     * ids they had, so a captured `fx.account.id` still names that row.
     */
    setup: async (fn) => {
      if (baseline)  throw new Error(
        'setup: already declared. A second setup would replace the baseline the first ' +
        'one established, and every scenario after it would restore to the wrong rows. ' +
        'Put both fixtures in one setup, or build a second env.'
      )
      if (scenarios) throw new Error(
        `setup: ${scenarios} scenario(s) have already run. A setup declared after the ` +
        'first phases() call never applied to them, so the suite would pass or fail ' +
        'depending on file order. Declare it before any test runs.'
      )
      const value = await fn({ system: env.system, factories: built.factories, db: built.db })
      baseline = snapshot(built.db)
      return value
    },

    phases: ({ as = null } = {}) => {
      // A scenario starts from the fixture. Without this the hoist is not a
      // hoist — the first test's writes are still there for the second.
      if (baseline) restore(built.db, baseline)
      scenarios++

      let acted = false
      const principal = () => (as ? env.actingAs(as) : built.db)

      return {
        arrange: async (fn) => {
          if (acted) throw new Error(
            'phases: arrange cannot follow act — setup after the act is part of the act, ' +
            'and the two being separable is what lets arrange be hoisted and cached.'
          )
          return fn({ system: env.system, factories: built.factories, db: built.db })
        },

        act: async (fn) => {
          if (acted) throw new Error(
            'phases: one act per scenario. A test with two acts cannot say which one the ' +
            'assertion is about, and neither can its failure message.'
          )
          acted = true
          return fn(principal())
        },

        assert: async (fn) => fn(readOnly(principal())),
      }
    },

    // Seed once, restore between tests. Cheaper than re-seeding and it keeps
    // @encrypted columns as the exact ciphertext they already are.
    seal:  () => { sealed = snapshot(built.db) },
    reset: () => {
      if (!sealed) throw new Error('createTestEnv: call seal() before reset()')
      restore(built.db, sealed)
    },

    close: () => {
      for (const client of levels.values()) client.$close()
      levels.clear()
      built.db.$close()
    },
  }

  return env
}

// ─── truncate ─────────────────────────────────────────────────────────────────

export async function truncate(db, modelName) {
  await db.asSystem()[modelToAccessor(modelName)].deleteMany({})
}

// ─── snapshot / restore ───────────────────────────────────────────────────────
//
// Seed once, restore between tests — the Laravel `RefreshDatabase` shape, without
// re-running the seed. Restoring is a truncate + bulk re-insert of the exact rows,
// which for test-sized data is far cheaper than seeding again.
//
//   const { db, factories } = await makeTestClient(schema, { autoFactories: true })
//   await seedEverything(db)
//   const snap = snapshot(db)
//   beforeEach(() => restore(db, snap))
//
// Deliberately raw: rows are read and written through the write connection, not
// the ORM. That keeps `@encrypted`/`@secret` columns as the exact ciphertext they
// already are (a round trip through the ORM would re-encrypt them), and skips
// gates, policies, hooks and audit logging — a restore is not an application write.
//
// NOT a substitute for a transaction: it does not isolate concurrent work. It is a
// point-in-time copy of every table in every SQLite database the client holds.

export function snapshot(db) {
  const raws = db.$rawDbs
  if (!raws) throw new Error('snapshot() requires a Litestone client with $rawDbs')

  const out = {}
  for (const [dbName, raw] of Object.entries(raws)) {
    if (!raw) continue
    const tables = _userTables(raw)
    const perDb  = {}
    for (const t of tables) perDb[t] = raw.query(`SELECT * FROM "${t}"`).all()
    out[dbName] = perDb
  }
  return out
}

export function restore(db, snap) {
  const raws = db.$rawDbs
  if (!raws) throw new Error('restore() requires a Litestone client with $rawDbs')
  if (!snap) throw new Error('restore(db, snapshot) — pass the value snapshot() returned')

  for (const [dbName, perDb] of Object.entries(snap)) {
    const raw = raws[dbName]
    if (!raw) continue

    // FKs off for the duration: rows go back in table order, not dependency order,
    // and the snapshot was consistent when taken.
    raw.run('PRAGMA foreign_keys = OFF')
    raw.run('BEGIN IMMEDIATE')
    try {
      for (const t of _userTables(raw)) raw.run(`DELETE FROM "${t}"`)
      for (const [table, rows] of Object.entries(perDb)) {
        if (!rows.length) continue
        const cols        = Object.keys(rows[0])
        const colList     = cols.map(c => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const stmt        = raw.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`)
        for (const row of rows) stmt.run(...cols.map(c => row[c]))
      }
      raw.run('COMMIT')
    } catch (e) {
      raw.run('ROLLBACK')
      throw e
    } finally {
      raw.run('PRAGMA foreign_keys = ON')
    }
  }
}

/** Tables a restore may touch — excludes sqlite internals and FTS shadow tables. */
function _userTables(raw) {
  const rows = raw.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).all()
  const names = rows.map(r => r.name)
  // An FTS5 virtual table owns shadow tables (<name>_data, _idx, _content, …).
  // Writing those directly corrupts the index; deleting the virtual table's rows
  // is what maintains them, and litestone rebuilds from triggers on the base table.
  const ftsRoots = names.filter(n => names.includes(`${n}_data`) && names.includes(`${n}_idx`))
  const shadowed = new Set(ftsRoots.flatMap(root =>
    names.filter(n => n.startsWith(`${root}_`))).concat(ftsRoots))
  return names.filter(n => !shadowed.has(n))
}

// ─── reset ────────────────────────────────────────────────────────────────────

export async function reset(db) {
  const schema = db.$schema
  if (!schema) throw new Error('reset() requires a Litestone client with $schema')
  const childFirst = _topoSort(schema.models, schema)
  const sys = db.asSystem()
  for (const name of childFirst) {
    try { await sys[modelToAccessor(name)].deleteMany({}) } catch { /* table may not exist */ }
  }
}

// ─── factoryFrom ─────────────────────────────────────────────────────────────
//
// Zero-config factory. No subclass needed.
//
//   const users = factoryFrom(schema, 'users', db)
//   const admin = await users.state({ role: 'admin' }).createOne()
//
// For traits or afterCreate, extend Factory with a subclass instead.

export function factoryFrom(schema, modelName, db, registry = null) {
  const defFn = generateFactory(schema, modelName)
  const f     = new Factory(db)
  f.model      = modelName
  f.definition = defFn
  f._schema    = schema      // enables has() / attach() / withParents()
  f._registry  = registry
  return f
}

// ─── generateFactory ─────────────────────────────────────────────────────────
//
// Returns a definition(seq, rng) function compatible with Factory.definition.
// Reads field types, attributes, and constraints from parsed schema AST.
//
// Decisions baked in:
//   @default(auth().field) → emits 1 (FK sentinel). Document: callers must
//     override or use `data` seeder to ensure FK parent with id=1 exists.
//   @secret → included (ORM encrypts on write transparently)
//   Type[]  → [] for required, null for optional

export function generateFactory(schema, modelName, options = {}) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateFactory: model "${modelName}" not found in schema`)

  const { fkDefaults = {} } = options

  // Build set of FK field names from relation declarations
  const fkFields = new Set()
  for (const field of model.fields) {
    if (field.type.kind !== 'relation') continue
    const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue
    const fkName = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
    if (fkName) fkFields.add(fkName)
  }

  return function definition(seq, rng) {
    const out = {}
    for (const field of model.fields) {
      if (_shouldSkipField(field, model)) continue

      const name  = field.name
      const type  = field.type
      const attrs = field.attributes
      const opt   = type.optional

      // Array types — honour @minItems, else [] for required / null for optional
      if (type.array) {
        const minItems = attrs.find(a => a.kind === 'minItems')?.value ?? 0
        if (minItems > 0) {
          out[name] = Array.from({ length: minItems }, (_, i) =>
            _scalarSample(type.name, name, seq + i))
        } else {
          out[name] = opt ? null : []
        }
        continue
      }

      // @id on String → '{modelName}-{seq}'
      const isId = attrs.some(a => a.kind === 'id')
      if (isId && type.name === 'String') {
        out[name] = rng ? `${modelName}-${rng.str(6)}` : `${modelName}-${seq}`
        continue
      }

      // @default — check before type-based rules
      const defAttr = attrs.find(a => a.kind === 'default')
      if (defAttr) {
        const v = defAttr.value
        if (v.kind === 'string')  { out[name] = v.value;    continue }
        if (v.kind === 'number')  { out[name] = v.value;    continue }
        if (v.kind === 'boolean') { out[name] = v.value;    continue }
        if (v.kind === 'enum')    { out[name] = v.value;    continue }
        if (v.kind === 'call') {
          // auth().field → emit 1 (FK sentinel, caller must seed parent)
          // NOTE: ensure a row with id=1 exists in the referenced table,
          //       or override this field via .state() / fkDefaults.
          if (v.fn === 'auth') { out[name] = fkDefaults[name] ?? 1; continue }
          // now(), uuid(), ulid(), cuid(), nanoid() → skip (db or client generates)
          continue
        }
      }

      // Enum type — first value unseeded (stable), rng.pick when seeded (variety)
      if (type.kind === 'enum' || (type.kind === 'scalar' && type.name !== 'String' && type.name !== 'Int' &&
          type.name !== 'Float' && type.name !== 'Boolean' && type.name !== 'DateTime' &&
          type.name !== 'Json' && type.name !== 'Bytes')) {
        const enumDef = schema.enums.find(e => e.name === type.name)
        if (enumDef) {
          if (!enumDef.values.length) throw new Error(`generateFactory: enum "${type.name}" has no values`)
          out[name] = rng ? rng.pick(enumDef.values).name : enumDef.values[0].name
          continue
        }
      }

      switch (type.name) {
        case 'String': {
          if (opt && !_hasTextConstraint(attrs) && !attrs.some(a => a.kind === 'phone')) {
            out[name] = null
            break
          }
          const token   = rng ? rng.str(4) : String(seq)   // uniqueness carrier
          const lenAttr = attrs.find(a => a.kind === 'length')
          const min     = lenAttr?.min ?? null
          const max     = lenAttr?.max ?? null
          let value

          const regexAttr = attrs.find(a => a.kind === 'regex')
          if (attrs.some(a => a.kind === 'email')) {
            // Keep it inside @length(max) when one is declared — a truncated
            // address would fail @email, which is the rule we are serving.
            const natural = fakeEmail(rng, seq) ?? `${modelName}${token}@test.com`
            value = max != null && max < natural.length
              ? _fitLength(`${token}@t.co`, min, max)
              : natural
          } else if (attrs.some(a => a.kind === 'url')) {
            value = `https://example.com/${modelName}/${token}`
          } else if (regexAttr) {
            // A pattern cannot be inverted in general. Generate a candidate for the
            // common subset, then CHECK it — an unsatisfiable pattern warns loudly
            // instead of writing data the schema will reject on every create.
            value = _sampleFromRegex(regexAttr.pattern, seq)
            if (value == null) {
              value = rng ? `${name}-${token}` : `${name}-${seq}`
              if (!_matchesRegex(regexAttr.pattern, value)) {
                console.warn(`generateFactory: cannot generate a value matching @regex("${regexAttr.pattern}") ` +
                  `for ${modelName}.${name} — override it with .state({ ${name}: … })`)
              }
            }
          } else if (attrs.some(a => a.kind === 'phone')) {
            value = _phoneSample(seq)
          } else if (attrs.some(a => a.kind === 'time')) {
            // These three are string FORMATS, not column types — `day String
            // @date` is a TEXT column the validator holds to a shape. Without
            // them the field fell through to the generic `Name 1` string, so
            // `cases.valid` was itself invalid and EVERY generated case for the
            // model failed naming this field rather than the rule under test.
            value = _timeSample(seq, attrs.find(a => a.kind === 'time').seconds === true)
          } else if (attrs.some(a => a.kind === 'date')) {
            value = _dateSample(seq)
          } else if (attrs.some(a => a.kind === 'datetime')) {
            value = `${_dateSample(seq)}T${_timeSample(seq, true)}Z`
          } else {
            const starts   = attrs.find(a => a.kind === 'startsWith')?.text ?? ''
            const ends     = attrs.find(a => a.kind === 'endsWith')?.text   ?? ''
            const contains = attrs.find(a => a.kind === 'contains')?.text
            if (contains != null) {
              value = `${starts}${contains}-${token}${ends}`
            } else if (starts || ends) {
              value = `${starts}${token}${ends}`
            } else {
              // A well-known field name gets a catalogue value when seeded, so a
              // generated row reads like a row. Unseeded output is unchanged —
              // schema-derived test CASES must stay stable.
              const fake = fakeFor(name, rng)
              if (fake != null) {
                // The catalogue is a small pool — two rows CAN draw the same name.
                // A @unique column carries the seq token so it still cannot collide.
                value = attrs.some(a => a.kind === 'unique') ? `${fake} ${token}` : fake
              } else {
                // Plain text — capitalize field name
                const label = name.charAt(0).toUpperCase() + name.slice(1)
                value = rng ? `${label} ${token}` : `${label} ${seq}`
              }
            }
          }

          // @length is a hard boundary. Fitting keeps the seq/token, so a @unique
          // column still gets a distinct value per row — 'x'.repeat(min) did not,
          // and the second insert hit the UNIQUE constraint.
          out[name] = _fitLength(value, min, max, token)
          break
        }

        case 'Int': {
          if (opt) { out[name] = null; break }
          if (fkFields.has(name) || name.endsWith('Id')) {
            out[name] = fkDefaults[name] ?? 1
            break
          }
          const { low, high } = _numericBounds(attrs, 1)
          out[name] = _pickInRange(low, high, seq, true)
          break
        }

        case 'Float': {
          if (opt) { out[name] = null; break }
          const { low, high } = _numericBounds(attrs, 1)
          out[name] = _pickInRange(low, high, seq, false)
          break
        }

        case 'Boolean':
          out[name] = false
          break

        case 'DateTime': {
          if (opt) { out[name] = null; break }
          // Derived from seq, not the wall clock — the same seed must produce the
          // same row, and `new Date()` broke that for every DateTime column.
          out[name] = new Date(FACTORY_EPOCH + (seq % 3650) * 86_400_000).toISOString()
          break
        }

        case 'Json': {
          // A required column cannot take null — the write fails validation, which
          // made autoFactories unusable for any model carrying a required Json.
          out[name] = opt ? null : {}
          break
        }

        case 'Bytes': {
          out[name] = opt ? null : new Uint8Array([seq % 256])
          break
        }

        default:
          out[name] = null
          break
      }
    }
    return out
  }
}

// ─── generateGateMatrix ───────────────────────────────────────────────────────
//
// Returns array of test cases for @@gate on a model.
// Each case: { op, required, level, label, expect }
//
// modelName is the MODEL name — PascalCase singular (Invariant 2), not the
// accessor. `generateGateMatrix(schema, 'Post')`, never 'posts'.
//
//   levels: 'full'  (default) every operation against every reachable level
//   levels: 'edges'           the required level and the one below it
//
// Full is the default because the edges only prove the comparison operator. A
// gate that grants at 6 and again at 2 passes an edge pair and is a hole.
//
// Usage:
//   const matrix = generateGateMatrix(schema, 'Post')
//   for (const { op, level, label, expect } of matrix) {
//     test(`${op} as ${label} → ${expect}`, async () => { ... })
//   }

export function generateGateMatrix(schema, modelName, { levels = 'full' } = {}) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateGateMatrix: model "${modelName}" not found in schema`)

  if (levels !== 'full' && levels !== 'edges')
    throw new Error(`generateGateMatrix: levels must be "full" or "edges", got "${levels}"`)

  const gateAttr = model.attributes?.find(a => a.kind === 'gate')
  if (!gateAttr) return []

  const gate = parseGateString(gateAttr.value)
  const ops  = ['read', 'create', 'update', 'delete']

  const cases = []
  for (const op of ops) {
    const required = gate[op]

    // The expected verdict is stated in access.js rather than read off the gate
    // plugin: an expectation taken from the code under test cannot fail. The two
    // statements are pinned to each other by one exhaustive test.
    const at = (level) => cases.push({
      op, required, level, label: levelLabel(level),
      expect: expectedVerdict(required, level),
    })

    if (levels === 'full') {
      for (const level of REACHABLE_LEVELS) at(level)
      continue
    }

    if (required === 9) { at(8); continue }        // LOCKED — nothing passes
    at(required)                                   // the allow edge
    if (required > 0) at(required - 1)             // and the deny below it
  }

  return cases
}

// ─── generateValidationCases ──────────────────────────────────────────────────
//
// Returns { valid, invalid, boundary } for a model.
//
//   valid    — complete valid record (from generateFactory)
//   invalid  — one failing case per constraint
//   boundary — boundary values that should pass
//
// modelName is the MODEL name, not the accessor — 'Lead', never 'leads'.
//
// Usage:
//   const cases = generateValidationCases(schema, 'Lead')
//   test('valid data passes', async () => {
//     await db.lead.create({ data: cases.valid })
//   })
//   for (const c of cases.invalid) {
//     test(`${c.field}: ${c.rule} rejects ${c.value}`, async () => {
//       const data = { ...cases.valid, [c.field]: c.value }
//       await expect(db.lead.create({ data })).rejects.toThrow(c.message)
//     })
//   }

// ─── sampleWrites ─────────────────────────────────────────────────────────────
//
// One seeded row per model, plus the payloads a create and a patch would carry
// — every required FK pointed at a parent this call made.
//
// The Data-realm half of deriving a call list. Mapping a model onto the service
// that exposes it is an API-realm fact this package cannot see (Invariant 1), so
// what comes back is keyed by MODEL name and the caller does the mapping.
//
//   const s = await sampleWrites(schema, db.asSystem())
//   s.Lead  // → { idField: 'id', row: {…}, create: {…}, patch: {…} }
//
// A model that cannot be seeded gets `{ error }` rather than being dropped: an
// absent key reads as "this model has nothing to test", which is how a derived
// suite silently stops covering the model whose fixture broke.

export async function sampleWrites(schema, system, { models = null } = {}) {
  const { chain } = _chains(schema, system)
  const out = {}

  for (const model of schema.models) {
    if (!_isValidatable(model, schema)) continue
    if (models && !models.includes(model.name)) continue

    const idField = _idField(schema, model.name)
    try {
      const row     = await chain(model.name).createOne()
      // Parents for the CREATE payload are made fresh, because the payload is
      // for a row that does not exist yet and may be created more than once.
      const parents = await _freshParents(schema, model.name, chain)
      const built   = chain(model.name).buildOne()

      // A create arriving over the wire is validated against the model's own
      // JSON Schema, where a server-owned column is `readOnly`. Sending one is
      // a 400 that says nothing about the transport under test.
      const create = { ...parents }
      for (const field of model.fields) {
        if (_shouldSkipField(field, model)) continue
        if (built[field.name] === undefined)  continue
        if (create[field.name] !== undefined) continue
        create[field.name] = built[field.name]
      }

      out[model.name] = { idField, row, create, patch: _touch(schema, model.name, row) }
    } catch (err) {
      out[model.name] = { idField, error: err?.message ?? String(err) }
    }
  }

  return out
}

export function generateValidationCases(schema, modelName) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateValidationCases: model "${modelName}" not found in schema`)

  const defFn = generateFactory(schema, modelName)
  const valid  = defFn(1, null)
  const invalid  = []
  const boundary = []

  // The message the field actually declares, falling back to the shared default.
  // Ignoring `attr.message` made every generated case for a field with an
  // authored message expect the DEFAULT wording, so the test failed against a
  // correct implementation — and a schema's own message is the one thing here
  // that IS an independent statement of intent.
  //
  // Reading the default table is not the oracle problem the gate matrix had:
  // the claim under test is *this value is rejected*, which is stated here from
  // the attribute's presence. The message is a label, and the table is the one
  // definition of it that Junction and Sierra also read through `x-messages`.
  const msg = (attr, fallback) => attr.message ?? fallback

  for (const field of model.fields) {
    if (field.type.kind === 'relation') continue

    // A @transient field's rules are real and this is not the layer that holds
    // them: it has no column, so every generated case would write a value the
    // Data boundary refuses by name — the rule reading as broken because the
    // field is doing exactly what it says. The API is where it is enforced, and
    // `@frontierjs/testing` is the tier that can reach it.
    if (field.attributes.some(a => a.kind === 'transient')) continue

    // ── Array validators ──────────────────────────────────────────────────
    // Same table as every other family, and for the same reason: the generator
    // restating the wording is a second copy, and it was the copy that noticed
    // the server was ignoring an authored message (FJS-194).
    if (field.type.array) {
      const name = field.name
      for (const attr of field.attributes) {
        if (attr.kind === 'minItems' && attr.value > 0) {
          invalid.push({ field: name, value: [], rule: `@minItems(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.minItems(attr.value)) })
          boundary.push({ field: name, value: _arrayOf(field, attr.value), rule: `@minItems(${attr.value})`,
            expect: 'pass', message: '' })
        }
        if (attr.kind === 'maxItems') {
          invalid.push({ field: name, value: _arrayOf(field, attr.value + 1), rule: `@maxItems(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.maxItems(attr.value)) })
          boundary.push({ field: name, value: _arrayOf(field, attr.value), rule: `@maxItems(${attr.value})`,
            expect: 'pass', message: '' })
        }
        if (attr.kind === 'uniqueItems') {
          invalid.push({ field: name, value: _arrayOf(field, 1).concat(_arrayOf(field, 1)), rule: '@uniqueItems',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.uniqueItems()) })
        }
      }
      continue
    }

    const name  = field.name
    const isInt = field.type.name === 'Int'
    const isOpt = field.type.optional

    for (const attr of field.attributes) {
      // Which attribute a case came from, recorded at the loop boundary rather
      // than at each of the fifteen pushes below. The post-pass needs it to ask
      // the one question that makes a case worth running: does this value
      // isolate the rule it names, or is some OTHER rule on the field deciding
      // the outcome (`FJS-351`)?
      const mark = { i: invalid.length, b: boundary.length }
      switch (attr.kind) {
        case 'email':
          invalid.push({ field: name, value: 'not-an-email', rule: '@email',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.email()) })
          break

        case 'url':
          invalid.push({ field: name, value: 'not-a-url', rule: '@url',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.url()) })
          break

        case 'date':
          invalid.push({ field: name, value: 'not-a-date', rule: '@date',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.date()) })
          break

        case 'datetime':
          invalid.push({ field: name, value: 'not-a-datetime', rule: '@datetime',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.datetime()) })
          break

        case 'phone':
          invalid.push({ field: name, value: 'not-a-phone', rule: '@phone',
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.phone()) })
          break

        case 'time': {
          // @time is HH:MM, or HH:MM:SS with `seconds: true`. `25:00` is
          // rejected by both, which is what makes it usable as the one invalid
          // value; the boundary is the widest thing the field still accepts.
          const seconds = attr.seconds === true
          invalid.push({ field: name, value: '25:00', rule: `@time${seconds ? '(seconds: true)' : ''}`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.time(seconds)) })
          boundary.push({ field: name, value: seconds ? '23:59:59' : '23:59', rule: '@time',
            expect: 'pass', message: '' })
          break
        }

        case 'regex': {
          invalid.push({ field: name, value: '!!!', rule: `@regex(${attr.pattern})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.regex(attr.pattern)) })
          break
        }

        case 'length': {
          const { min, max } = attr
          const rule = `@length(${min ?? ''},${max ?? ''})`
          if (min != null && min > 0) {
            invalid.push({ field: name, value: '', rule,
              expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.length(min, max)) })
            boundary.push({ field: name, value: 'x'.repeat(min), rule,
              expect: 'pass', message: '' })
          }
          if (max != null) {
            invalid.push({ field: name, value: 'x'.repeat(max + 1), rule,
              expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.length(min, max)) })
            boundary.push({ field: name, value: 'x'.repeat(max), rule,
              expect: 'pass', message: '' })
          }
          break
        }

        case 'gte': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value - delta, rule: `@gte(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.gte(attr.value)) })
          boundary.push({ field: name, value: attr.value, rule: `@gte(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'gt': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value, rule: `@gt(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.gt(attr.value)) })
          boundary.push({ field: name, value: attr.value + delta, rule: `@gt(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'lte': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value + delta, rule: `@lte(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.lte(attr.value)) })
          boundary.push({ field: name, value: attr.value, rule: `@lte(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'lt': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value, rule: `@lt(${attr.value})`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.lt(attr.value)) })
          boundary.push({ field: name, value: attr.value - delta, rule: `@lt(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'startsWith':
          invalid.push({ field: name, value: `wrong${attr.text}`, rule: `@startsWith("${attr.text}")`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.startsWith(attr.text)) })
          break

        case 'endsWith':
          invalid.push({ field: name, value: `${attr.text}wrong`, rule: `@endsWith("${attr.text}")`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.endsWith(attr.text)) })
          break

        case 'contains':
          invalid.push({ field: name, value: 'nope', rule: `@contains("${attr.text}")`,
            expect: 'fail', message: msg(attr, DEFAULT_MESSAGES.contains(attr.text)) })
          break
      }
      for (let i = mark.i; i < invalid.length;  i++) { invalid[i].attr  = attr; invalid[i].fieldRef  = field }
      for (let i = mark.b; i < boundary.length; i++) { boundary[i].attr = attr; boundary[i].fieldRef = field }
    }
  }

  // ── Does each case ISOLATE the rule it names? ─────────────────────────────
  //
  // Every case above is built from ONE attribute with no idea what else sits on
  // the field, and both halves of that are wrong once a field carries two rules
  // (`FJS-351`):
  //
  //   a boundary claims a value the field ACCEPTS — `@length(3, 200)` on an
  //   `@email` column produced `'xxx'`, which is not an email, so the write was
  //   refused and the runner reported *@length allows this value and the write
  //   was refused*: a correct schema graded as broken, and the fix a reader
  //   reaches for is deleting a rule.
  //
  //   an invalid case claims the NAMED rule refuses it — `''` on that same
  //   column is refused by `@email`, so the case passed while proving nothing,
  //   and a mutant that widened `@length` survived.
  //
  // The judge is `validateField`, the function that decides this on a real
  // write, rather than a table of formats here — which would be a second
  // definition of every rule, drifting the moment one is tuned.
  //
  // Repair first: a value of the same length that the rest of the field accepts
  // usually exists, and is found by growing or trimming the factory's own valid
  // sample. Where none is found the case is DROPPED and SAID — `uncheckable` —
  // because a rule that quietly stops being asked about is this runner's own
  // failure mode, one layer up.
  const uncheckable = []

  // The field's OTHER rules, and only ever those.
  //
  // Whether a value satisfies or breaks the rule the case NAMES is established
  // by construction — a boundary is built at the bound, an invalid case outside
  // it — and asking `validateField` about it instead would make the runner its
  // own oracle: disable `@length` in `validate.js` and every `@length` case
  // reports *not checked* rather than *the write was ACCEPTED*, which is the
  // one finding this whole runner exists to produce. Measured, after getting it
  // wrong that way first.
  const others = (c) => c.fieldRef.attributes.filter(a => a !== c.attr)
  const clear  = (c, v) => validateField(c.field, v, others(c)).length === 0

  const keep = (list, label) => {
    const out = []
    for (const c of list) {
      if (!c.fieldRef) { out.push(c); continue }
      if (clear(c, c.value)) { out.push(c); continue }

      const fixed = _isolate(c, valid[c.field], v => clear(c, v))
      if (fixed !== null) { out.push({ ...c, value: fixed }); continue }

      const why = validateField(c.field, c.value, others(c)).map(e => e.message)
      uncheckable.push({
        field: c.field, rule: c.rule, value: c.value, blockedBy: why,
        message: `${model.name}.${c.field} — ${c.rule}'s ${label} was NOT checked: no value isolates `
               + `it from the field's other rules`
               + (why.length ? ` (${why.join('; ')})` : ''),
      })
    }
    list.length = 0
    list.push(...out)
  }

  // One rule for both halves, which is what the reasoning above collapses to:
  // nothing on the field except the rule under test may have an opinion about
  // the value.
  keep(boundary, 'boundary')
  keep(invalid,  'invalid case')

  return { valid, invalid, boundary, uncheckable }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * A value that isolates the rule a case names, or null if none was found.
 *
 * Which dimension is free depends on the rule. A `@length` case IS its length —
 * the violation and the boundary are both the count — so only the content may
 * move. Every other rule's case has a length that is incidental, and when the
 * field also declares `@length` that incidental length is what stops the case
 * running: `@url`'s `'not-a-url'` is nine characters, so on a `@length(10, 60)`
 * column it is refused by the wrong rule. Padding it to ten leaves it just as
 * far from being a URL.
 *
 * `ok` decides in both cases, so a candidate that accidentally satisfies the
 * rule it is supposed to break is never returned.
 */
function _isolate(c, sample, ok) {
  const target = c.value
  if (typeof target !== 'string') return null

  if (c.attr?.kind === 'length') {
    // A boundary IS its length — that is the whole claim, so only the content
    // may move. An invalid case only has to sit OUTSIDE the bound, and which
    // side is the one thing that must not change: `@length(6, 200)` on an email
    // column is broken by `a@b.c` at five, and by nothing at zero.
    const { min, max } = c.attr
    if (c.expect === 'pass') return _ofLength(target.length, sample, ok)

    const lengths = target.length < (min ?? 0)
      ? Array.from({ length: min }, (_, i) => min - 1 - i)          // min-1 … 0
      : [target.length, (max ?? target.length) + 2]
    for (const n of lengths) {
      const v = _ofLength(n, sample, ok)
      if (v !== null) return v
    }
    return null
  }

  const bound   = c.fieldRef.attributes.find(a => a.kind === 'length')
  const lengths = [...new Set([bound?.min, bound?.max, typeof sample === 'string' ? sample.length : null]
    .filter(n => typeof n === 'number' && n > 0))]

  for (const n of lengths) {
    const v = target.length >= n ? target.slice(0, n) : target + 'a'.repeat(n - target.length)
    if (ok(v)) return v
  }
  return null
}

/**
 * A string of exactly `n` characters that `ok` accepts, or null.
 *
 * Format-blind on purpose. It grows or trims the factory's own valid sample —
 * already the right shape for the column — and lets the caller's predicate,
 * which is `validateField` over the real attributes, judge each candidate. So
 * an `@email @length(_, 200)` boundary comes out as a long local part in front
 * of the sample's own domain without this function knowing what an `@` is, and
 * a rule litestone gains tomorrow is handled the day it lands.
 *
 * Insertion is tried at every index because where a format's padding may go is
 * the one thing that differs between them: an email grows before the `@`, a URL
 * after the last `/`, a prefixed reference after its prefix. Trimming is tried
 * from both ends for the same reason — a prefix rule needs the head kept, a
 * suffix rule the tail.
 */
function _ofLength(n, sample, ok) {
  if (typeof sample !== 'string' || n < 0) return null
  if (sample.length === n) return ok(sample) ? sample : null

  const candidates = []
  if (n < sample.length) {
    // Trimming from an end is the cheap try — a prefix rule needs the head
    // kept, a suffix rule the tail — and it is not enough on its own: the
    // shortest email litestone accepts is `a@b.c`, and neither end of
    // `email1@example.com` is an email at five characters. So the real strategy
    // is to shrink the sample's WORDS and leave its punctuation where it is,
    // which is what carries a format through a size change without knowing what
    // the format is.
    candidates.push(sample.slice(0, n), sample.slice(sample.length - n), ..._shrunk(sample, n))
  } else {
    const pad = 'a'.repeat(n - sample.length)
    for (let i = 0; i <= sample.length; i++)
      candidates.push(sample.slice(0, i) + pad + sample.slice(i))
  }

  for (const v of candidates) if (ok(v)) return v
  return null
}

/**
 * `sample` cut down to exactly `n` characters by shortening its alphanumeric
 * runs and leaving everything between them alone.
 *
 * Two orders are offered because either can be the one a format survives:
 * longest-run-first keeps the shape balanced, left-to-right keeps the tail
 * intact for a rule that reads the end. Every run keeps at least one character,
 * so `email1@example.com` at five is `e@e.c` — an email, arrived at without
 * this function containing the word.
 */
function _shrunk(sample, n) {
  const runs = [...sample.matchAll(/[A-Za-z0-9]+/g)]
  if (!runs.length) return []

  const build = (order) => {
    const lens = runs.map(r => r[0].length)
    let need   = sample.length - n
    for (const i of order) {
      if (need <= 0) break
      const cut = Math.min(need, lens[i] - 1)
      lens[i] -= cut
      need    -= cut
    }
    if (need > 0) return null                     // cannot get there without emptying a run

    let out = '', at = 0
    runs.forEach((r, i) => {
      out += sample.slice(at, r.index) + r[0].slice(0, lens[i])
      at   = r.index + r[0].length
    })
    return out + sample.slice(at)
  }

  const byLength = runs.map((r, i) => i).sort((a, b) => runs[b][0].length - runs[a][0].length)
  const inOrder  = runs.map((_, i) => i)
  return [build(byLength), build(inOrder)].filter(v => v !== null)
}


// n elements an array column will actually accept. `Int[]` and `String[]` are
// type-checked element by element on write, so a String[] filled with numbers
// fails the type rule rather than the count rule the case is about.
function _arrayOf(field, n) {
  return Array.from({ length: n }, (_, i) =>
    field.type.name === 'Int' ? i + 1 : `${field.name}${i + 1}`)
}

// ─── row policies ─────────────────────────────────────────────────────────────

// The principal `verifyRowPolicies` compares against. Carries the keys an
// `auth().x` predicate is realistically written over in this repo, because a
// principal missing the key a policy names makes every row fail to match — and
// an empty result is what a broken policy looks like, so the runner would be
// reporting its own gap as a finding.
const DEFAULT_POLICY_PRINCIPAL = {
  id:          'policy-principal',
  userId:      'policy-principal',
  workspaceId: 'ws-policy',
  accountId:   'acct-policy',
  tenantId:    'tenant-policy',
  role:        'member',
}

/**
 * The same caller, holding every capability the schema declares.
 *
 * A verifier grades ONE rule and has to take the others out of the way, or a
 * refusal proves nothing about the rule it names (`FJS-351`). The grid is ANDed
 * with the gate and throws the same `AccessDeniedError` a policy violation
 * would, so a caller holding no grants makes every write on an opted-in model
 * report *the call threw rather than filtering, which a policy never does* —
 * a true sentence about the grid that says nothing about the policy.
 *
 * A set the caller already stated is left alone: they are asking about a
 * specific person, and a grant injected under one is a grant nobody wrote.
 */
function withDeclaredCapabilities(who, schema) {
  if (who?.capabilities) return who
  return { ...who, capabilities: [...capabilityNames(schema)] }
}

// Which of these rows the operation actually reached, as a Set of ids.
//
// All three compile the policy into a WHERE, so "reached" is observable without
// a throw: a read omits the row, an update or delete matches nothing and answers
// null. `create` is deliberately absent — it is checked by `evalJs` and nothing
// else, so grading it with `evalJs` would be the oracle problem, and there is no
// second implementation to compare against.
async function _runPolicyOp(op, client, acc, schema, model, idKey, rows) {
  if (op === 'read') {
    const seen = await client[acc].findMany({ limit: rows.length + 10 })
    return new Set(seen.map(r => r[idKey]))
  }

  const reached = new Set()
  for (const row of rows) {
    const where = { [idKey]: row[idKey] }
    const hit = op === 'update'
      ? await client[acc].update({ where, data: _touch(schema, model.name, row) })
      : await client[acc].delete({ where })
    // A hard delete answers the row it removed; `remove()` on a @@softDelete
    // model is a different call, and the D gate covers both, so `delete` is the
    // one that isolates the policy rather than the soft-delete filter.
    if (hit != null && (!Array.isArray(hit) || hit.length)) reached.add(row[idKey])
  }
  return reached
}

// If `field` is a FK, make the parent row it would point at exist, carrying the
// id the policy is about to compare. Best-effort: a value the parent's own key
// will not take (a string id on an Int key) just leaves the candidate
// unseedable, which the one-sided check reports.
async function _ensureParent(schema, model, field, value, chain) {
  if (value === null || value === undefined) return
  const rel = model.fields.find(f =>
    f.type.kind === 'relation' && !f.type.array &&
    f.attributes.some(a => a.kind === 'relation' && a.fields?.[0] === field))
  if (!rel) return

  const parentKey = _idField(schema, rel.type.name)
  const factory   = chain(rel.type.name)
  if (!factory) return
  try { await factory.createOne({ [parentKey]: value }) } catch { /* already there, or refused */ }
}

function _hasCheckNode(node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'check') return true
  return Object.values(node).some(v => (Array.isArray(v) ? v.some(_hasCheckNode) : _hasCheckNode(v)))
}

// Values that put a row on a KNOWN side of the predicate, taken off the
// predicate itself. Generated values land wherever they land; these are chosen
// so at least one row matches and at least one does not.
function _interestingValues(rules, who, model) {
  const out = {}
  // `targeted` means the value was taken off the predicate — the principal's own
  // value, or the literal it compares against — so a row carrying it is on the
  // MATCHING side by construction. The others are there to put a row on the
  // other side, and handing one to a caller that wanted a matching row is how
  // `verifyFieldProtection` came to seed rows its own model then hid.
  const add = (field, value, targeted) => {
    const def = model.fields.find(f => f.name === field)
    if (!def) return
    // A candidate the COLUMN would refuse is not a row on either side of the
    // predicate — it is a failed insert. `null` into a non-optional column and
    // a string into an Int are the two that actually occur.
    if (value === null && !def.type.optional) return
    if (typeof value === 'string' && def.type.name !== 'String' && !def.type.optional) return
    if (typeof value === 'string' && ['Int', 'Float', 'Boolean', 'DateTime'].includes(def.type.name)) return
    // A generated sentinel still has to satisfy the column's own rules, or the
    // insert fails and the row is on neither side.
    if (!targeted && typeof value === 'string' && !_fitsFieldRules(def, value)) return
    ;(out[field] ??= []).push({ value, targeted })
  }

  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    // A ternary's branches are where the interesting values live —
    // `level > 5 ? ownerId == auth().id : true` needs a row on each side of the
    // CONDITION and each side of the branch it selects. The generic descent
    // below reaches them by object-walking, but the condition's own field would
    // only ever get its comparison values, never a value chosen to make the
    // condition false, so every seeded row landed on one side and the policy
    // was reported ungraded.
    if (node.type === 'ternary') { walk(node.cond); walk(node.then); walk(node.else); return }
    // Membership seeds differently from a comparison, and getting it wrong is
    // not a wrong grade but NO grade: the generic branch below would put the
    // principal's scalar id into an `Int[]` column, the insert fails, and the
    // run reports one row all on the excluded side. The list is always the
    // RIGHT operand; which column to seed depends on which side holds it.
    if (node.type === 'compare' && node.op === 'in') {
      const { left, right } = node
      if (right.type === 'field') {
        // the list is a column — a matching row is one whose list holds the value
        const val = left.type === 'auth'    ? (left.field ? who[left.field] : who.id)
                  : left.type === 'literal' ? left.value
                  : undefined
        if (val !== undefined && val !== null) add(right.name, [val], true)
        add(right.name, [], false)
      } else if (left.type === 'field') {
        // the list is the caller's or written literally — a matching row is one
        // whose column holds a member of it
        const items = right.type === 'list' ? right.items
                    : right.type === 'auth' ? (right.field ? who[right.field] : who.id)
                    : null
        const list = Array.isArray(items) ? items : items == null ? [] : [items]
        if (list.length) add(left.name, list[0], true)
        // The excluded side needs a value the column will actually accept: the
        // string sentinel is refused by an Int column, `null` by a required one,
        // and the factory's own row is only excluded by luck — a `@default(0)`
        // against a list holding 0 leaves every row admitted and the policy
        // ungraded.
        const def = model.fields.find(f => f.name === left.name)
        if (def && ['Int', 'Float'].includes(def.type?.name)) {
          const nums = list.filter(v => typeof v === 'number')
          add(left.name, (nums.length ? Math.max(...nums) : 0) + 9973, false)
        }
        add(left.name, '__no_policy_match__', false)
        add(left.name, null, false)
      }
      return
    }
    if (node.type === 'compare') {
      const { left, right } = node
      const pair = (fieldNode, otherNode) => {
        if (fieldNode?.type !== 'field') return
        if (otherNode?.type === 'auth')    add(fieldNode.name, otherNode.field ? who[otherNode.field] : who.id, true)
        if (otherNode?.type === 'literal') add(fieldNode.name, otherNode.value, true)
        // An ORDERING comparison is not satisfied by the literal it names:
        // `level > 5` seeded `level = 5`, which is on the excluded side, so the
        // only admitted rows were whatever the factory happened to generate —
        // and a policy graded by luck reports "all on one side" the day the
        // factory changes. Seed the neighbours and mark whichever one the
        // operator actually admits, evaluated rather than assumed.
        if (otherNode?.type === 'literal' && typeof otherNode.value === 'number' &&
            ['<', '>', '<=', '>='].includes(node.op)) {
          const L = otherNode.value
          // fieldNode on the left means `field OP literal`; on the right the
          // comparison reads the other way round.
          const onLeft = fieldNode === left
          for (const v of [L - 1, L + 1]) {
            const holds = onLeft
              ? (node.op === '<' ? v < L : node.op === '>' ? v > L : node.op === '<=' ? v <= L : v >= L)
              : (node.op === '<' ? L < v : node.op === '>' ? L > v : node.op === '<=' ? L <= v : L >= v)
            add(fieldNode.name, v, holds)
          }
        }
        add(fieldNode.name, null, false)
        add(fieldNode.name, '__no_policy_match__', false)
      }
      pair(left, right)
      pair(right, left)
      return
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  rules.forEach(r => walk(r.expr))

  // Deduped by value so a predicate naming one field twice does not seed the
  // same row twice; a value that is targeted anywhere stays targeted.
  for (const field of Object.keys(out)) {
    const seen = new Map()
    for (const c of out[field]) {
      const prev = seen.get(c.value)
      seen.set(c.value, { value: c.value, targeted: (prev?.targeted ?? false) || c.targeted })
    }
    out[field] = [...seen.values()]
  }
  return out
}

// Would this generated value survive the column's own validators? The sentinel
// is 19 characters, so a `@length(3, 12)` refuses it and the row is on neither
// side of the policy — reported as "no rows could be built", which is true and
// useless.
function _fitsFieldRules(def, value) {
  for (const a of def.attributes) {
    if (a.kind === 'length' && (value.length < (a.min ?? 0) || value.length > (a.max ?? Infinity))) return false
    if (a.kind === 'email' || a.kind === 'url' || a.kind === 'phone' ||
        a.kind === 'date'  || a.kind === 'datetime' || a.kind === 'time' || a.kind === 'regex') return false
  }
  return true
}

// Does the declared rule set admit this row? `@@deny` overrides, an operation
// with no `@@allow` is unrestricted — the same precedence buildPolicyFilter
// compiles into SQL, stated here over the JS evaluator instead.
function _policyAdmits(rules, ctx, row, modelName, policyMap) {
  const denies = rules.filter(r => r.kind === 'deny')
  const allows = rules.filter(r => r.kind === 'allow')
  const ev = (r) => Boolean(evalJs(r.expr, ctx, row, modelName, policyMap, {}))

  if (denies.some(ev)) return false
  if (!allows.length)  return true
  return allows.some(ev)
}

// ─── tenancy ──────────────────────────────────────────────────────────────────
//
// `tenancy { strategy row }` desugars into generated `@@deny` rules and a
// `@default(auth().claim)` stamp, and every rule it writes carries
// `generated: 'tenancy'`. These read that marker rather than re-deriving the
// desugar, because a second derivation of one rule is how the two halves of
// `check()` came to disagree (`FJS-382`).

/** The column this model carries its tenant in, or null where it carries none. */
function _tenantColumn(schema, model) {
  const t = schema.tenancy
  if (!t || t.strategy !== 'row') return null
  const tag = model?.attributes?.find(a => a.kind === 'tenant')
  if (tag?.mode === 'none') return null
  const column = tag?.column ?? t.column
  return model?.fields?.some(f => f.name === column) ? column : null
}

/**
 * How this model is scoped: `exempt` · `column` · `delegated` · `unscoped`.
 *
 * `unscoped` is the one worth having a name for. The desugar errors on a
 * `@@tenant(via:)` naming a parent that is not itself scoped, and says nothing
 * about a model that names no `via` and has no scoped parent to infer one from
 * — so the model every tenant can read is the one nobody was told about.
 */
function _tenantKind(schema, model) {
  if (model?.attributes?.some(a => a.kind === 'tenant' && a.mode === 'none')) return 'exempt'
  if (_tenantColumn(schema, model)) return 'column'
  return model?.attributes?.some(a => a.kind === 'deny' && a.generated === 'tenancy')
    ? 'delegated'
    : 'unscoped'
}

/**
 * The tenancy claim, stamped for the principal a row is being seeded for.
 *
 * Row tenancy generates a DENY, so a seeder that satisfies only the model's
 * `@@allow` rules builds a row the reader below cannot see — and every check
 * downstream then reports its own blind spot as a clean result (`FJS-381`).
 * One definition, because two seeders stamping this differently is the same
 * class of defect one level up.
 */
function _tenantStamp(schema, model, principal) {
  const column = _tenantColumn(schema, model)
  return column ? { [column]: principal?.[schema.tenancy.claim] } : {}
}

/**
 * Two tenants to cross between.
 *
 * The declared column is very often a FOREIGN KEY to the model the tenant IS,
 * and then a made-up value is refused by the constraint rather than by the rule
 * under test — which reads as isolation working. So where it is a relation the
 * two tenants are real rows.
 */
async function _tenantValues(schema, chain) {
  const t = schema.tenancy
  const carrier = schema.models.find(m =>
    _isValidatable(m, schema) && _tenantColumn(schema, m) === t.column)
  if (!carrier) return [null, null]

  const rel = carrier.fields.find(f =>
    f.type.kind === 'relation' && !f.type.array &&
    f.attributes.some(a => a.kind === 'relation' && a.fields?.[0] === t.column))

  if (rel) {
    const pk  = rel.attributes.find(a => a.kind === 'relation')?.references?.[0]
             ?? _idField(schema, rel.type.name)
    const one = await chain(rel.type.name).createOne()
    const two = await chain(rel.type.name).createOne()
    return [one[pk], two[pk]]
  }

  const field = carrier.fields.find(f => f.name === t.column)
  return field?.type.name === 'Int' ? [900001, 900002] : ['tenant-a', 'tenant-b']
}

/**
 * One row of this model, inside one tenant, parents included.
 *
 * `withParents()` builds a parent chain and knows nothing about tenancy, so a
 * delegated child seeded through it points at a parent in no tenant at all and
 * the `check()` it delegates to answers about the wrong row. The FK overrides
 * built here win over the ones `createOne` derives from its own parents, which
 * is what lets the shared chain keep its sequence — two chains per model would
 * both write seq 1 and collide on every `@unique`.
 *
 * `parents` is memoised per tenant so a diamond gets ONE parent: two would be
 * legitimate rows and would also leave a delegated child ambiguous about which
 * of them its rule delegated through.
 */
async function _seedForTenant(schema, modelName, tenant, chain, parents = new Map(), opts = {}) {
  const { seen = new Set(), depth = 8, optional = true } = opts
  const model     = schema.models.find(m => m.name === modelName)
  const column    = _tenantColumn(schema, model)
  const overrides = column ? { [column]: tenant } : {}

  for (const field of model?.fields ?? []) {
    if (field.type.kind !== 'relation' || field.type.array) continue
    const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue

    const fk = rel.fields[0]
    if (fk === column) continue

    // An OPTIONAL scoping relation is filled by default, and that is the whole
    // difference between grading a delegated model and grading a degenerate
    // case of one. A delegated rule reads `check(rel)`, and a row whose `rel` is
    // null is in no tenant at all (`FJS-382`) — so seeding it unparented tests
    // the one shape the rule deliberately does not cover, reports every tenant
    // reaching it, and says nothing about the rows the app actually holds.
    // `optional: false` seeds that shape on purpose, once, to report it as what
    // it is.
    if (!optional && model.fields.find(f => f.name === fk)?.type.optional) continue

    // Only a SCOPED parent has to be in this tenant. An exempt or unscoped one
    // is shared by construction and `withParents` builds it for free.
    const kind = _tenantKind(schema, schema.models.find(m => m.name === field.type.name))
    if (kind === 'unscoped' || kind === 'exempt') continue
    if (seen.has(field.type.name) || depth <= 0) continue

    const key = `${field.type.name}|${tenant}`
    let   row = parents.get(key)
    if (!row) {
      row = await _seedForTenant(schema, field.type.name, tenant, chain, parents,
                                 { seen: new Set([...seen, modelName]), depth: depth - 1, optional })
      parents.set(key, row)
    }
    overrides[fk] = row[rel.references?.[0] ?? _idField(schema, field.type.name)]
  }

  return chain(modelName).createOne(overrides)
}

/**
 * A create payload taken off a row that already exists, so the values satisfy
 * every rule but the one being asked about.
 *
 * The `@id` rides along only where the column has no default — the probe row is
 * deleted before the attempt, so the value is free, and without it a model with
 * a caller-supplied key cannot be created at all and the move reports nothing.
 */
function _columnPayload(schema, model, row) {
  if (!row) return null
  const data = {}
  for (const field of model.fields) {
    if (field.type.array || field.type.kind === 'relation') continue
    const attrs = field.attributes
    if (attrs.some(a => a.kind === 'computed' || a.kind === 'generated' || a.kind === 'from' || a.kind === 'version')) continue
    if (attrs.some(a => a.kind === 'id') && attrs.some(a => a.kind === 'default')) continue
    if (row[field.name] === undefined || row[field.name] === null) continue
    data[field.name] = row[field.name]
  }
  return Object.keys(data).length ? data : null
}

/**
 * What a caller writes to move a row into another tenant.
 *
 * The column where the model carries one; where it does not, re-pointing the
 * relation its delegation reads — which is the delegated spelling of the same
 * move, and the reason the generated denies cover `post-update` at all.
 */
function _tenantMove(schema, model, tenant, parents) {
  const column = _tenantColumn(schema, model)
  if (column) return { [column]: tenant }

  for (const field of model.fields) {
    if (field.type.kind !== 'relation' || field.type.array) continue
    const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue
    const parent = parents.get(`${field.type.name}|${tenant}`)
    if (!parent) continue
    return { [rel.fields[0]]: parent[rel.references?.[0] ?? _idField(schema, field.type.name)] }
  }
  return null
}

// ─── factory chains ───────────────────────────────────────────────────────────
//
// The one place a `withParents()` chain is built, because building one twice is
// the trap that has now cost three separate rounds of false results.
//
// Every Factory chain method returns a CLONE carrying the original's sequence,
// and the original's never advances. So `registry.workspace.withParents()`
// called twice hands back two factories that both write seq 1 — the same
// `@unique` slug, the same composite key — and the second write fails with a
// UNIQUE error that is indistinguishable from the rule under test working.
// Memoised per accessor, one chain per model per run, sequence advancing.

function _chains(schema, sys) {
  const registry = {}
  const cache    = {}
  for (const m of schema.models) {
    if (!_isValidatable(m, schema)) continue
    registry[modelToAccessor(m.name)] = factoryFrom(schema, m.name, sys, registry)
  }
  return {
    registry,
    chain(modelName) {
      const acc = modelToAccessor(modelName)
      return cache[acc] ??= registry[acc]?.withParents({ fresh: true })
    },
  }
}

// Does this column carry a `@default`? The question the id strip turns on: a key
// the database or the client mints is absent from a create, a key the caller
// states is required in one.
function _hasDefault(schema, modelName, fieldName) {
  return Boolean(schema.models.find(m => m.name === modelName)
    ?.fields.find(f => f.name === fieldName)
    ?.attributes.some(a => a.kind === 'default'))
}

// The model's `@id` column. Not assumed to be `id`: `@@map`ped and renamed keys
// exist, and a `where: { id }` against a model whose key is `code` refuses every
// row — which would read as a gate denial at every level.
function _idField(schema, modelName) {
  const model = schema.models.find(m => m.name === modelName)
  return model?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
}

// One new parent row per required belongsTo, and the FK values pointing at
// them. Parents only — the child is what the caller is about to try to create,
// and creating it here would be answering the question.
async function _freshParents(schema, modelName, chain) {
  const model = schema.models.find(m => m.name === modelName)
  const out   = {}
  for (const field of model?.fields ?? []) {
    if (field.type.kind !== 'relation' || field.type.array) continue
    const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue
    const fk    = rel.fields[0]
    const fkDef = model.fields.find(f => f.name === fk)
    if (fkDef?.type.optional) continue
    const parent = chain(field.type.name)
    if (!parent) continue
    const row = await parent.createOne()
    out[fk] = row[rel.references?.[0] ?? _idField(schema, field.type.name)]
  }
  return out
}

// A patch that changes nothing observable but is still a real update. An empty
// `data` is not a write every model accepts, and picking a column at random can
// violate a `@unique`; re-stating a scalar the row already holds does neither.
// `@version` rides along because it is read off the row, which is exactly what
// an optimistic-concurrency update requires.
function _touch(schema, modelName, row) {
  const model = schema.models.find(m => m.name === modelName)
  const patch = {}
  for (const field of model?.fields ?? []) {
    if (_shouldSkipField(field, model)) continue
    if (field.type.array || field.type.kind !== 'scalar') continue
    if (row[field.name] === undefined) continue
    patch[field.name] = row[field.name]
    break
  }
  const version = model?.fields.find(f => f.attributes.some(a => a.kind === 'version'))
  if (version && row[version.name] !== undefined) patch[version.name] = row[version.name]
  return patch
}

// Can a constraint on this model be exercised by a real write at all?
// `@@external` emits no DDL, and the jsonl/logger drivers run no validation —
// their "failures" would be *no such table*, which says nothing about a rule.
function _isValidatable(model, schema) {
  if (model.attributes?.some(a => a.kind === 'external')) return false
  const dbName = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
  const driver = schema.databases.find(d => d.name === dbName)?.driver ?? 'sqlite'
  return driver === 'sqlite'
}

function _shouldSkipField(field, model) {
  const attrs = field.attributes
  const name  = field.name
  const type  = field.type

  if (type.kind === 'relation' || type.kind === 'implicitM2M') return true   // virtual
  if (type.name === 'File')     return true   // file upload concern

  if (attrs.some(a => a.kind === 'computed')) return true
  if (attrs.some(a => a.kind === 'transient')) return true  // no column — the API lifts it off the payload
  if (attrs.some(a => a.kind === 'from'))     return true  // subquery — not writable
  if (attrs.some(a => a.kind === 'generated')) return true
  if (attrs.some(a => a.kind === 'funcCall'))  return true
  // @sequence — the db owns this counter. An explicit value IS honoured and moves
  // the counter forward, so emitting one both defeats the feature and collides
  // with any @@unique([scope, seqField]) declared alongside it.
  if (attrs.some(a => a.kind === 'sequence')) return true

  // @id on Int → auto-increment
  const isId  = attrs.some(a => a.kind === 'id')
  if (isId && type.name === 'Int') return true

  const defAttr = attrs.find(a => a.kind === 'default')
  if (defAttr) {
    // @updatedAt implies DEFAULT in DDL — skip
    if (attrs.some(a => a.kind === 'updatedAt')) return true
    // @default(now()), uuid(), ulid(), cuid(), nanoid() — db or client generates
    if (defAttr.value?.kind === 'call' && defAttr.value.fn !== 'auth') return true
  }
  if (attrs.some(a => a.kind === 'updatedAt')) return true

  // @createdBy / @updatedBy are stamped from ctx.auth — a factory value would
  // be overwritten under $setAuth and is meaningless without it
  if (attrs.some(a => a.kind === 'createdBy' || a.kind === 'updatedBy')) return true

  // @version is owned by the client — always 1 on create, bumped by SQL after
  if (attrs.some(a => a.kind === 'version')) return true

  // A NULLABLE foreign key. `_freshParents` seeds a parent for the REQUIRED
  // relations only, so there is nothing for this column to point at and a
  // generated value is refused by the CONSTRAINT rather than by whatever rule
  // the caller is grading — `FOREIGN KEY constraint failed`, reported as *the
  // call threw something that is not a refusal*. Null is always legal in an
  // optional FK, so leaving it out is the honest fixture. The shape that
  // reaches here is row tenancy over a nullable claim column: `expandTenancy`
  // stamps it `@default(auth().<claim>)`, and the `auth` carve-out above
  // deliberately does not skip those.
  if (type.optional && model?.fields?.some(f =>
        f.type.kind === 'relation' && !f.type.array &&
        f.attributes?.some(a => a.kind === 'relation' && a.fields?.includes(name))))
    return true

  // Well-known auto-timestamp fields
  if (name === 'createdAt') return true
  if (name === 'updatedAt') return true
  if (name === 'deletedAt') return true   // soft delete marker, never set on create

  return false
}

function _hasTextConstraint(attrs) {
  const constraintKinds = new Set(['email','url','regex','length','startsWith','endsWith','contains'])
  return attrs.some(a => constraintKinds.has(a.kind))
}

// Fixed base date for generated DateTime values — 2024-01-01T00:00:00.000Z.
const FACTORY_EPOCH = Date.UTC(2024, 0, 1)

/** Pad to `min`, truncate to `max`. Padding carries `token` so the value stays unique. */
function _fitLength(value, min, max, token = '') {
  let out = String(value)
  if (min != null && out.length < min) {
    // Pad with the token first (keeps uniqueness), then filler.
    while (out.length < min && token) out += token
    while (out.length < min) out += 'x'
  }
  if (max != null && out.length > max) out = out.slice(0, max)
  return out
}

/**
 * Resolve @gte/@gt/@lte/@lt into an inclusive [low, high]. `step` converts an
 * exclusive bound into an inclusive one. Either end may be null (unbounded).
 */
function _numericBounds(attrs, step) {
  const gte = attrs.find(a => a.kind === 'gte')
  const gt  = attrs.find(a => a.kind === 'gt')
  const lte = attrs.find(a => a.kind === 'lte')
  const lt  = attrs.find(a => a.kind === 'lt')

  let low  = gte ? gte.value : (gt ? gt.value + step : null)
  let high = lte ? lte.value : (lt ? lt.value - step : null)

  // Exclusive bounds on both ends of a narrow range can cross — fall back to the
  // midpoint of the raw bounds, which satisfies both.
  if (low != null && high != null && low > high) {
    const mid = ((gte ?? gt).value + (lte ?? lt).value) / 2
    low = high = mid
  }
  return { low, high }
}

/** A value inside [low, high] that still varies with seq, so @unique survives. */
function _pickInRange(low, high, seq, isInt) {
  if (low == null && high == null) return isInt ? seq : seq * 1.0
  if (low != null && high != null) {
    if (low === high) return low
    // Midpoint when seq is the first row (pins the documented @gte(0)@lte(100) → 50),
    // then walk the range so repeated creates do not collide.
    const span = high - low
    if (!isInt) return low + span / 2
    const offset = Math.floor(span / 2) + (seq - 1)
    return low + (offset % (span + 1))
  }
  if (low  != null) return isInt ? low  + ((seq - 1) % 1000) : low
  return isInt ? high - ((seq - 1) % 1000) : high
}

/** E.164-ish value that satisfies litestone's @phone rule and varies with seq. */
function _phoneSample(seq) {
  return `+1555${String(seq % 10_000_000).padStart(7, '0')}`
}

// A strict 24-hour clock with leading zeros, which is what @time accepts. The
// seq walks the day rather than repeating, so a @unique @time column still gets
// distinct values.
// A real calendar date, walked by seq rather than repeated, so a @unique @date
// column still gets distinct values. Fixed epoch: an unseeded factory's output
// has to be stable, because schema-derived test cases are compared against it.
function _dateSample(seq) {
  const d = new Date(Date.UTC(2020, 0, 1) + (seq % 3650) * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function _timeSample(seq, seconds) {
  const pad = (n) => String(n).padStart(2, '0')
  const hh  = pad(Math.floor(seq / 60) % 24)
  const mm  = pad(seq % 60)
  return seconds ? `${hh}:${mm}:${pad(seq % 60)}` : `${hh}:${mm}`
}

function _matchesRegex(pattern, value) {
  try { return new RegExp(pattern).test(String(value)) } catch { return false }
}

/** One element for an array field, typed by the element's scalar type. */
function _scalarSample(typeName, fieldName, i) {
  switch (typeName) {
    case 'Int':      return i
    case 'Float':    return i * 1.0
    case 'Boolean':  return false
    case 'DateTime': return new Date(FACTORY_EPOCH + (i % 3650) * 86_400_000).toISOString()
    case 'Json':     return {}
    default:         return `${fieldName}-${i}`
  }
}

// ─── _sampleFromRegex ─────────────────────────────────────────────────────────
//
// Generates a string matching the common subset of regex used in schemas:
// anchors, literals, escapes (\d \w \s \. …), character classes with ranges and
// negation, groups, alternation, and the {n} {n,m} ? + * quantifiers.
//
// Returns null for anything outside that subset (lookarounds, backreferences) or
// when the generated candidate does not actually match — the caller warns rather
// than emitting a value the validator will reject.

function _sampleFromRegex(pattern, seq) {
  let out
  try { out = _regexGen(pattern, seq) } catch { return null }
  if (out == null) return null
  return _matchesRegex(pattern, out) ? out : null
}

function _regexGen(pattern, seq) {
  let src = pattern
  if (src.startsWith('^')) src = src.slice(1)
  if (src.endsWith('$') && !src.endsWith('\\$')) src = src.slice(0, -1)

  let i = 0
  const parseAlternation = (stop) => {
    const branches = [parseSequence(stop)]
    while (i < src.length && src[i] === '|') { i++; branches.push(parseSequence(stop)) }
    return branches[0]   // first branch — deterministic and always valid
  }

  const parseSequence = (stop) => {
    let out = ''
    while (i < src.length && src[i] !== '|' && !(stop && src[i] === stop)) {
      out += parseQuantified()
    }
    return out
  }

  const parseQuantified = () => {
    const atom = parseAtom()
    let min = 1
    if (src[i] === '{') {
      const close = src.indexOf('}', i)
      if (close === -1) throw new Error('unbalanced {')
      const body = src.slice(i + 1, close)
      i = close + 1
      min = parseInt(body.split(',')[0], 10)
      if (Number.isNaN(min)) throw new Error('bad quantifier')
    } else if (src[i] === '?') { i++; min = 0 }
    else if (src[i] === '*')   { i++; min = 0 }
    else if (src[i] === '+')   { i++; min = 1 }
    if (src[i] === '?') i++    // lazy modifier — same output
    return atom.repeat(min)
  }

  const parseAtom = () => {
    const ch = src[i]
    if (ch === '(') {
      i++
      if (src.slice(i, i + 2) === '?:') i += 2
      else if (src[i] === '?') throw new Error('lookaround unsupported')
      const inner = parseAlternation(')')
      if (src[i] !== ')') throw new Error('unbalanced (')
      i++
      return inner
    }
    if (ch === '[') {
      i++
      let neg = false
      if (src[i] === '^') { neg = true; i++ }
      const members = []
      while (i < src.length && src[i] !== ']') {
        let c = src[i]
        if (c === '\\') { i++; members.push(..._escapeChars(src[i])); i++; continue }
        if (src[i + 1] === '-' && src[i + 2] && src[i + 2] !== ']') {
          for (let k = src.charCodeAt(i); k <= src.charCodeAt(i + 2); k++) members.push(String.fromCharCode(k))
          i += 3
          continue
        }
        members.push(c); i++
      }
      if (src[i] !== ']') throw new Error('unbalanced [')
      i++
      const pool = neg ? 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').filter(c => !members.includes(c)) : members
      if (!pool.length) throw new Error('empty class')
      return pool[seq % pool.length]
    }
    if (ch === '\\') {
      i++
      const chars = _escapeChars(src[i]); i++
      return chars[seq % chars.length]
    }
    if (ch === '.') { i++; return 'a' }
    if (ch === undefined) throw new Error('unexpected end')
    i++
    return ch
  }

  const out = parseAlternation(null)
  if (i < src.length) throw new Error('trailing input')
  return out
}

function _escapeChars(c) {
  switch (c) {
    case 'd': return '0123456789'.split('')
    case 'w': return 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')
    case 's': return [' ']
    case 'D': return 'abcdefghijklmnopqrstuvwxyz'.split('')
    case 'W': return ['-']
    case 'S': return 'abcdefghijklmnopqrstuvwxyz'.split('')
    case 'n': return ['\n']
    case 't': return ['\t']
    default:  return [c]
  }
}

function _topoSort(models, schema) {
  const deps = new Map(models.map(m => [m.name, new Set()]))
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      const relAttr = field.attributes.find(a => a.kind === 'relation')
      const target  = field.type.name
      if (target && deps.has(target) && target !== model.name) {
        if (relAttr?.fields?.length || (!relAttr && !field.type.array)) {
          deps.get(model.name).add(target)
        }
      }
    }
  }
  const result   = []
  const inDegree = new Map(models.map(m => [m.name, 0]))
  for (const [, depSet] of deps)
    for (const dep of depSet)
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1)
  const queue = [...models.map(m => m.name).filter(n => inDegree.get(n) === 0)]
  while (queue.length) {
    const name = queue.shift()
    result.push(name)
    for (const dep of (deps.get(name) ?? [])) {
      const d = (inDegree.get(dep) ?? 1) - 1
      inDegree.set(dep, d)
      if (d === 0) queue.push(dep)
    }
  }
  for (const m of models) if (!result.includes(m.name)) result.push(m.name)
  return result
}
