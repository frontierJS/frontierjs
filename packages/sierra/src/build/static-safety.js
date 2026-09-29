/**
 * build/static-safety.js — prove a prerendered page is safe to publish.
 *
 * ── The hole this closes (ISSUES.md FJS-081) ──────────────────────────────
 *
 * Two shipped features, combined the obvious way, published private data:
 *
 *   - a route declares `render: static` and is emitted as HTML at build time
 *   - every model declares who may read it (`@@gate`)
 *
 * Nothing connected them. A `render: static` route whose `load()` read a model
 * gated at level 4 wrote that data into a public file, which was then served,
 * CDN-cached and indexed. The build succeeded. The page looked right. Nothing
 * warned. It is the worst class of bug this framework can have — silent,
 * permanent, and produced by using two correct features together.
 *
 * ── Where the read actually happens ───────────────────────────────────────
 *
 * `IDEAS/static-safety.md` proposed watching the RENDER, on the grounds that
 * "the prerenderer knows which resources a route touched (it renders them)".
 * That is not where the data comes from. A static route's data arrives from
 * `load()` / `getStaticPaths()` in the `.meta.js` companion, BEFORE render, and
 * reaches the component as a plain `data` prop. Watching the render would have
 * observed an empty set and passed everything — a green check proving nothing,
 * which is worse than no check.
 *
 * So the read set is collected around the companion, not around the render.
 *
 * ── How the read set is collected ─────────────────────────────────────────
 *
 * Litestone already emits it. `$tapQuery(fn)` fires a `QueryEvent` per query
 * carrying `{ model, operation }` and returns an unsubscribe. That covers the
 * case a build-time analysis structurally cannot see — a `load()` that imports
 * a Litestone client directly and queries it, which is how a real app is
 * written. Junction uses the same tap for telemetry.
 *
 * One wrinkle, established by running it rather than reading: the tap reports
 * the TABLE name (`product`) and `$defs` is keyed by the MODEL name
 * (`Product`). They are not the same string. `modelNameFor()` already owns that
 * resolution — including the regular-plural rules — so this file resolves
 * through it rather than lower-casing by hand and drifting.
 *
 * A second wrinkle, and it was a hole rather than a wrinkle: the tap fires per
 * TABLE, from inside `makeTable`'s closure. A child resolved by `include:` is
 * read inside the PARENT's own statement and reaches no child table, so the
 * read set held the parent alone and a gated child was published while the
 * report called the page proven (`FJS-781`). The query's `include`/`select` is
 * expanded through `client.$relations` here, and a relation that cannot be
 * expanded is refused rather than scored.
 *
 * ── Fail closed ───────────────────────────────────────────────────────────
 *
 * A route whose reads cannot be OBSERVED is not a route that is known to be
 * safe. If a route pulls data and no tap could be installed, the build fails
 * asking for the client to be wired rather than assuming the best. Fail-open
 * would have let exactly the clever route we are worried about slip through
 * silently, which is the failure mode being fixed.
 *
 * `publishes:` is NOT the escape from that branch. It says which columns of
 * which gated models this page may publish, and answers nothing about whether
 * the build could see them (`FJS-782`).
 *
 * It is a written, per-route acknowledgement — never a global flag — so
 * publishing gated data becomes a thing somebody wrote down and a reviewer can
 * see in a diff:
 *
 *   ---
 *   render: static
 *   publishes:
 *     User: [id, name, timeZone]   # these columns of User may be public
 *   ---
 *
 * A column set and not a gate level (`FJS-D496`): a level covered every column
 * of the model, including one added after the line was written, so a later edit
 * putting `email` on the page raised nothing and changed nothing a reviewer
 * diffs. A model gated at 0 needs no entry — it is public already. There is no
 * wildcard, for the same reason there is no level.
 *
 * ── When the check does not run ───────────────────────────────────────────
 *
 * No `.lite` schema means no gates, so there is nothing to prove and the check
 * is skipped entirely. A Sierra app without a database is unaffected.
 */

import { registerSchemas, modelNameFor, schemaFor } from '../junction/schema-registry.js'
import { buildGate } from '../junction/field-rules.js'

/**
 * Install the generated defs so `modelNameFor` can resolve a table name.
 *
 * The registry is a module singleton designed for the browser, where
 * `virtual:sierra` calls this once before any route module runs. Calling it
 * here reuses the ONE owner of accessor/plural/model-name resolution instead of
 * growing a second copy in the build that would drift from it — and in a build
 * process nothing else reads the registry.
 *
 * @param {object|null} defs    the whole `$defs` table
 * @param {string[]|null} models which entries are models
 */
export function installSchemas(defs, models) {
  registerSchemas(defs ?? {}, models ?? undefined)
}

/**
 * The `read` level a model's gate demands, or 0 when it declares none.
 *
 * An undeclared gate is genuinely ungated at the Data boundary, so 0 is the
 * accurate answer here and not a permissive guess.
 *
 * @param {string} tableOrModel  either spelling — the tap reports the table
 * @returns {{ model: string|null, level: number }}
 */
export function gateReadLevel(tableOrModel) {
  const model = modelNameFor(tableOrModel)
  if (!model) {
    // A read of something the schema does not describe. Not resolvable, so not
    // provable — reported as unknown and handled by the caller's fail-closed
    // branch rather than quietly scored 0.
    return { model: null, level: NaN }
  }
  const need = buildGate(schemaFor(model))?.read
  return { model, level: typeof need === 'number' ? need : 0 }
}

/** How deep a nested include/select is followed before it is called unresolved. */
const MAX_RELATION_DEPTH = 12

/**
 * Follow a query's `include`/`select` through the schema's relation map.
 *
 * `$tapQuery` used to fire once per CALL, for the table the verb was called on.
 * A child resolved by `include:` is a SEPARATE statement against the child
 * table — measured — but it was reported nowhere, so `db.customer.findMany({
 * include: { invoices: true } })` recorded `customer` alone and a level-4
 * `Invoice` was published while the build's own report called the page proven
 * (`FJS-781`). The recorder has the client, so the relation is expanded here.
 *
 * Litestone reports those statements now (`FJS-891`), so an include target
 * arrives on its own event as well. This expansion is kept and is not
 * redundant: it is a DERIVATION from the relation map where the event is an
 * OBSERVATION, it follows a `select` that names a relation, and it is what
 * records an unresolvable key as unresolved rather than silently unscored.
 * Two sources for one fact, and this is the fail-closed one.
 *
 * Anything that cannot be expanded is recorded as unresolved rather than
 * scored. An `include` key names a relation by construction, so a key the map
 * does not carry — an older client with no `$relations`, a table whose model
 * cannot be resolved, a relation added since — is a read whose gate is unknown.
 * A `select` key is usually a scalar column and is only followed when the map
 * says it is a relation, or every ordinary `select` would be refused.
 */
function expandRelations(model, node, relations, models, unresolved, depth = 0) {
  if (!node || typeof node !== 'object') return
  if (depth > MAX_RELATION_DEPTH) { unresolved.add(`${model ?? '?'}: include nested deeper than ${MAX_RELATION_DEPTH}`); return }

  for (const key of ['include', 'select']) {
    const sub = node[key]
    if (!sub || typeof sub !== 'object') continue

    for (const [name, value] of Object.entries(sub)) {
      if (value === false || value == null) continue

      // `_count: { select: { orders: true } }` reads the child rows to count
      // them. A count over a gated table is a fact about that table, so its
      // keys are expanded the same way the relation itself would be.
      if (name === '_count') {
        expandRelations(model, value, relations, models, unresolved, depth + 1)
        continue
      }

      const rel = model && relations ? relations[model]?.[name] : undefined
      if (rel && rel.targetModel) {
        models.add(rel.targetModel)
        expandRelations(rel.targetModel, value, relations, models, unresolved, depth + 1)
        continue
      }

      // An `include` key is a relation or it is nothing. A `select` key that
      // carries a nested object is one too — a scalar is `true`.
      if (key === 'include' || (value && typeof value === 'object'))
        unresolved.add(`${model ?? '?'}.${name}`)
    }
  }
}

/** Verbs whose result carries no column value — a count, a flag, `{ count }`. */
const VALUELESS = new Set([
  'count', 'exists', 'include', 'include:count',
  'createMany', 'updateMany', 'deleteMany', 'removeMany', 'upsertMany',
])

/** Aggregate keys that return a column's VALUE; `_count` returns a number. */
const VALUE_AGGREGATES = ['_min', '_max', '_sum', '_avg']

/** Add `names` to `model`'s entry in a model → columns map. */
function addColumns(out, model, names) {
  if (!out.has(model)) out.set(model, new Set())
  for (const n of names) out.get(model).add(n)
}

/**
 * Which columns of which models a read put in its result.
 *
 * `publishes:` is graded against this (`FJS-D496`), and so is the protected
 * check (`FJS-D504`). A node with no `select` returns every column the model
 * reads back, so it counts as all of them; a `select` narrows it to the keys
 * named. Relations are followed the way `expandRelations` follows them — `true`
 * is the whole child row — so a column two includes down is recorded against
 * its own model. A relation the map does not carry is not followed here:
 * `expandRelations` already records it as unresolved, and that refuses the
 * route. A `_count` reads a relation's rows and returns none of their columns;
 * the model is in the read set through `expandRelations` all the same.
 */
function collectColumns(model, node, relations, columnsOf, out, depth = 0) {
  if (!model || depth > MAX_RELATION_DEPTH) return
  const shape  = node && typeof node === 'object' ? node : {}
  const select = shape.select && typeof shape.select === 'object' ? shape.select : null
  const follow = (name, value) => {
    const rel = relations?.[model]?.[name]
    if (!rel?.targetModel) return false
    collectColumns(rel.targetModel, value, relations, columnsOf, out, depth + 1)
    return true
  }

  if (select) {
    addColumns(out, model, [])
    for (const [name, value] of Object.entries(select)) {
      if (value === false || value == null || name === '_count') continue
      if (!follow(name, value)) addColumns(out, model, [name])
    }
  } else {
    addColumns(out, model, columnsOf(model))
  }

  if (shape.include && typeof shape.include === 'object') {
    for (const [name, value] of Object.entries(shape.include)) {
      if (value === false || value == null || name === '_count') continue
      follow(name, value)
    }
  }
}

/** The columns an aggregate or groupBy returns the values of. */
function aggregateColumns(model, args, out) {
  const named = new Set(Array.isArray(args?.by) ? args.by : [])
  for (const key of VALUE_AGGREGATES)
    for (const [name, on] of Object.entries(args?.[key] ?? {})) if (on) named.add(name)
  addColumns(out, model, named)
}

/**
 * Create a recorder that collects every model a Litestone client reads.
 *
 * `taps` is a COUNT and not a boolean because the two facts it was carrying are
 * different: *a client was watched* and *this route's reads were seen*. The tap
 * is installed on the one client the build config named, so a `load()` that
 * constructs its own reads with a tap still installed and an empty read set —
 * a pass that proves nothing (`FJS-782`). A count lets the caller report that
 * state instead of scoring it.
 *
 * @param {object|null} client  a Litestone client, or null when none is wired
 * `columns` is every column read, by model, for `publishes:`; `exposed` is the
 * protected ones among them that a SYSTEM read returned. `asSystem()` is the
 * only flavor that returns a `@guarded` or `@encrypted` value — a bare or
 * `$setAuth` read strips both — and it is the flavor a gated catalog is built
 * through, so a model-level check handed `token` to the page with nothing on
 * the path looking (`FJS-1411`). Graded at the READ rather than in the HTML: a
 * column renamed into a prop, or interpolated into markup, reaches the page all
 * the same, and only the read knows it was there.
 *
 * @param {object|null} client  a Litestone client, or null when none is wired
 * @returns {{ taps: number, models: Set<string>, unresolved: Set<string>,
 *   columns: Map<string, Set<string>>, exposed: Set<string>,
 *   columnsOf: (model: string) => string[] | null, stop: () => void }}
 */
export function createReadRecorder(client) {
  const models = new Set()
  const unresolved = new Set()
  const columns = new Map()
  const exposed = new Set()

  if (!client || typeof client.$tapQuery !== 'function') {
    return { taps: 0, models, unresolved, columns, exposed, columnsOf: () => null, stop() {} }
  }

  // Read once: it is a schema-derived constant, and asking per query would be
  // a proxy trap on every read of every page.
  let relations = null
  try { relations = client.$relations ?? null } catch { relations = null }

  // What a whole-row read returns: every scalar field but an `@omit(all)`,
  // which no read selects. Null for a model the schema does not describe.
  let schemaModels = []
  try { schemaModels = client.$schema?.models ?? [] } catch { schemaModels = [] }
  const columnsOf = model => {
    const m = schemaModels.find(x => x.name === model)
    if (!m) return null
    return m.fields
      .filter(f => f.type?.kind !== 'relation')
      .filter(f => !f.attributes?.some(a => a.kind === 'omit' && a.level === 'all'))
      .map(f => f.name)
  }

  const protectedCache = new Map()
  const protectedOf = model => {
    if (!protectedCache.has(model)) {
      let fields = {}
      try { fields = client.$protectedFields?.(model) ?? {} } catch { fields = {} }
      protectedCache.set(model, fields)
    }
    return protectedCache.get(model)
  }

  const stop = client.$tapQuery(event => {
    if (!event) return
    // Raw SQL names no model, so no gate or protected column can be graded;
    // dropping it let `asSystem().sql` publish anything (`FJS-1471`).
    if (event.operation === 'sql') { unresolved.add(`sql: ${String(event.sql ?? '').trim()}`); return }
    if (!event.model) return
    const table = String(event.model)
    const model = modelNameFor(table)
    models.add(table)
    expandRelations(model, event.args, relations, models, unresolved)
    if (VALUELESS.has(event.operation)) return
    const read = new Map()
    if (event.operation === 'aggregate' || event.operation === 'groupBy')
      aggregateColumns(model, event.args, read)
    else
      collectColumns(model, event.args, relations, m => columnsOf(m) ?? [], read)
    for (const [m, names] of read) {
      addColumns(columns, m, names)
      if (event.system !== true) continue
      const guarded = protectedOf(m)
      for (const n of names) if (guarded[n]) exposed.add(`${m}.${n} (@${guarded[n]})`)
    }
  })

  return { taps: 1, models, unresolved, columns, exposed, columnsOf, stop: typeof stop === 'function' ? stop : () => {} }
}

/**
 * Parse a route's `publishes:` — the columns, per model, this page may publish
 * from a gated model.
 *
 * Anything but a map of model to a list of column names is refused by TYPE
 * rather than coerced: a bare `true` or a number says the author wanted the
 * check quieter, not which data the page contains, and the whole point is that
 * the decision is legible in the diff. An empty list declares a read that
 * returns no column, like a count.
 *
 * @returns {{ models: Map<string, Set<string>>, error: string|null }}
 */
export function declaredPublishes(meta) {
  const raw = meta?.publishes ?? meta?.frontmatter?.publishes
  const models = new Map()

  if (raw === undefined || raw === null) return { models, error: null }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      models,
      error: `publishes names the columns this page may publish, per model — ` +
             `publishes: { User: [id, name] } — got ${JSON.stringify(raw)}`,
    }
  }

  for (const [model, cols] of Object.entries(raw)) {
    if (!Array.isArray(cols) || cols.some(c => typeof c !== 'string'))
      return { models, error: `publishes.${model} must be a list of column names, got ${JSON.stringify(cols)}` }
    models.set(model, new Set(cols))
  }

  return { models, error: null }
}

/**
 * Decide whether a route may be published.
 *
 * `publishes:` answers ONE question — which columns of a gated model this
 * page's contents may include. An UNPROVABLE route is refused whatever it
 * says: a declaration about what a page contains cannot stand in for the
 * ability to see what it contains (`FJS-782`).
 *
 * @param {object}  o
 * @param {string}  o.routeId     for the message
 * @param {object}  o.meta        route frontmatter
 * @param {Set<string>} o.models  table/model names read while building it
 * @param {Set<string>|string[]} [o.unresolved]  reads whose gate could not be resolved
 * @param {Map<string, Set<string>>} [o.columns]  columns read, by model
 * @param {Set<string>|string[]} [o.exposed]  protected columns a system read returned
 * @param {(model: string) => string[]|null} [o.columnsOf]  a model's columns, to check the declaration against
 * @param {number}  o.taps        how many clients a recorder was installed on
 * @param {boolean} o.readsData   does the route have a load/getStaticPaths?
 * @returns {{ ok: boolean, message: string|null, published: Array<{model:string, level:number}>, observedNothing?: boolean }}
 */
export function checkRoute({
  routeId, meta, models, unresolved = [], columns = new Map(), exposed = [],
  columnsOf = () => null, taps = 0, readsData,
}) {
  const declared = declaredPublishes(meta)

  if (declared.error)
    return { ok: false, message: `${routeId}: ${declared.error}`, published: [] }

  // A misspelt model or column in the declaration matches nothing, so it would
  // read as a page publishing less than it does. Refused by name instead.
  for (const [model, cols] of declared.models) {
    if (modelNameFor(model) !== model)
      return { ok: false, published: [], message:
        `${routeId}: publishes names \`${model}\`, which is not a model in the schema` +
        (modelNameFor(model) ? ` — write \`${modelNameFor(model)}\`` : '') }
    const known = columnsOf(model)
    const stray = known ? [...cols].filter(c => !known.includes(c)) : []
    if (stray.length)
      return { ok: false, published: [], message:
        `${routeId}: publishes.${model} names ${stray.map(c => `\`${c}\``).join(', ')}, ` +
        `which ${stray.length === 1 ? 'is not a column' : 'are not columns'} of ${model}` }
  }

  // ── Unprovable ──────────────────────────────────────────────────────
  // The route pulls data and nothing watched it. There is no basis on which to
  // call the output safe, and no declaration can supply one — `publishes:` says
  // what the author believes is in the page, which is the claim being checked.
  if (readsData && taps === 0) {
    return {
      ok: false,
      published: [],
      message:
        `${routeId} — render: static\n` +
        `   reads data in its .meta.js, and the build could not observe what it read,\n` +
        `   so it cannot be shown to be safe to publish.\n` +
        `   Wire the Litestone client into the build (sierra config \`db\`) so reads can\n` +
        `   be checked.\n` +
        `   \`publishes:\` does not answer this — it says which columns this page may\n` +
        `   publish, which is the claim the build has no way to check here.\n`,
    }
  }

  // ── Observed reads ──────────────────────────────────────────────────
  const published = []
  const unknown   = [...unresolved]

  for (const raw of models) {
    const { model, level } = gateReadLevel(raw)
    if (!model || Number.isNaN(level)) { unknown.push(raw); continue }
    published.push({ model, level })
  }

  // Refused whatever `publishes:` says, for the reason above: a read the build
  // cannot resolve to a gate is a read it cannot grade, and a number about the
  // page's contents is not an answer to *what did this page read*.
  if (unknown.length) {
    return {
      ok: false,
      published,
      message:
        `${routeId} — render: static\n` +
        `   read ${unknown.map(u => `\`${u}\``).join(', ')}, whose gate the build could not\n` +
        `   resolve, so the page cannot be shown to be safe.\n` +
        `   A relation named in \`include:\` that the schema does not carry, or a table the\n` +
        `   schema does not describe, or raw SQL, which names no model. Read it as a plain query on the model instead, so the\n` +
        `   build can see which model it is.\n`,
    }
  }

  // Refused whatever `publishes:` says: `@guarded` is system-only both ways
  // and takes no level, so no declaration can make one public (`FJS-D504`).
  const leaked = [...exposed]
  if (leaked.length) {
    return {
      ok: false,
      published,
      message:
        `${routeId} — render: static\n` +
        `   reads ${leaked.map(c => `\`${c}\``).join(', ')} through asSystem(), which\n` +
        `   returns protected columns as their values — so the page could publish them.\n` +
        `   Name the columns the page needs with \`select:\` (nested selects for an\n` +
        `   include), leaving the protected ones out. \`publishes:\` does not lift this:\n` +
        `   no declaration makes a protected column public.\n`,
    }
  }

  // ── Gated columns ───────────────────────────────────────────────────
  // Every column read from a gated model must be named in `publishes:` for
  // that model; a model gated at 0 is public and needs no entry.
  const over = []
  const graded = new Set()
  for (const { model, level } of published) {
    if (level <= 0 || graded.has(model)) continue
    graded.add(model)
    const read  = [...(columns.get(model) ?? [])]
    const allow = declared.models.get(model)
    const extra = allow ? read.filter(c => !allow.has(c)) : read
    if (!allow || extra.length) over.push({ model, level, read, extra, declared: !!allow })
  }

  if (over.length) {
    const whole = over.some(o => {
      const all = columnsOf(o.model)
      return all && all.length && all.every(c => o.read.includes(c))
    })
    const entries = new Map(declared.models)
    for (const o of over) entries.set(o.model, new Set([...(entries.get(o.model) ?? []), ...o.read]))
    return {
      ok: false,
      published,
      message:
        `${routeId} — render: static\n` +
        over.map(o => o.declared
          ? `   reads ${o.extra.map(c => `\`${o.model}.${c}\``).join(', ')}, which \`publishes:\` does not ` +
            `name — \`${o.model}\` is @@gate read ${o.level}.`
          : `   reads \`${o.model}\`, which is @@gate read ${o.level} — level ${o.level} required to read.`
        ).join('\n') + '\n' +
        `   A prerendered page is public: whatever it contains is served to anyone,\n` +
        `   cached by a CDN and indexed, and cannot be recalled.\n` +
        `\n` +
        `   Change the route to \`render: spa\`, move the data into a client:* island\n` +
        `   (an island fetches at runtime with the viewer's own session), or — if these\n` +
        `   columns really are meant to be public — name them in the route:\n` +
        `\n` +
        `       ---\n` +
        `       render: static\n` +
        `       publishes:\n` +
        [...entries].map(([m, cols]) => `         ${m}: [${[...cols].join(', ')}]\n`).join('') +
        `       ---\n` +
        (whole
          ? `\n   A read with no \`select:\` counts as every column of the model. Narrow it to\n` +
            `   the columns the page shows, and declare those.\n`
          : ''),
    }
  }

  // Reads data, a tap was installed, and nothing was seen. Reported rather than
  // refused: a `load()` that fetches an absolute URL and touches no database is
  // legitimate and common, and refusing it would refuse the majority case to
  // catch the minority one. But the minority one is real — a `load()` that
  // constructs its OWN Litestone client reads with the build's tap installed
  // and contributes nothing to this set — and it looked exactly like a pass.
  const observedNothing = !!readsData && taps > 0 && published.length === 0

  return { ok: true, message: null, published, observedNothing }
}

/**
 * Format the per-route table.
 *
 * A check nobody has run is a rule nobody trusts, so the build reports what it
 * proved rather than only what it rejected.
 */
export function formatReport(rows) {
  if (!rows.length) return ''
  const w = Math.max(...rows.map(r => r.route.length), 5)
  const line = r => {
    const models = r.published.length
      ? r.published.map(p => `${p.model}(${p.level})`).join(' ')
      : '—'
    return `    ${r.route.padEnd(w)}  ${models}`
  }
  return [
    `    ${'route'.padEnd(w)}  models read (gate)`,
    ...rows.map(line),
  ].join('\n')
}
