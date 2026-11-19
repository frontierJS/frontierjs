/**
 * build/page-reads.js — which prerendered pages a write reaches (`FJS-D1262`).
 *
 * A prerendered page is a function of the rows its `load()` read, and nothing
 * the app declares says which: a post feeds its own page, every index page, its
 * tags' pages, the feed and the sitemap. The build already taps every read to
 * grade it (`static-safety.js`) and keeps only the models, per ROUTE. Here the
 * reads are kept per emitted URL — model, the key a read pins, and the columns
 * it selects, filters on or orders by — as a manifest the build writes beside
 * its output, and `affectedPages(manifest, write)` names the pages one write
 * would change. Derived rather than declared, so it cannot drift from a page.
 *
 * Fail-closed throughout. A read whose rows or columns cannot be told — raw
 * SQL, a `$raw` filter, a relation the client's map does not carry — matches
 * every write to its model, or to any model, so the answer can name a page
 * that did not change but never misses one that did.
 */

/** A read whose filter or result names no column it could be narrowed by. */
const ALL = null

/** Verbs whose result is a count or a flag: only the filter decides it. */
const COUNTS = new Set(['count', 'exists', 'include:count'])

/** Where-clause keys that combine clauses rather than name a column. */
const COMBINATORS = new Set(['AND', 'OR', 'NOT'])

/** `blog_post`, `BlogPost` and `blogPost` are one model to the matcher. */
const norm = name => String(name ?? '').replace(/_/g, '').toLowerCase()

const safe = fn => { try { return fn() } catch { return null } }

/**
 * Open a per-page tap on a Litestone client.
 *
 * Returns null when the client has no `$tapQuery`. Otherwise each call opens a
 * tap and returns its `stop()`, which closes it and answers the reads it saw.
 *
 * @param {object|null} client
 * @returns {null | (() => () => PageRead[])}
 */
export function pageReadTap(client) {
  if (!client || typeof client.$tapQuery !== 'function') return null
  const relations = safe(() => client.$relations) ?? null
  const models    = safe(() => client.$schema?.models) ?? []

  const byNorm = new Map()
  for (const m of models) {
    byNorm.set(norm(m.name), m)
    byNorm.set(norm(m.name) + 's', m)
  }
  const modelOf = table => byNorm.get(norm(table)) ?? null
  const uniques = model => (model?.fields ?? [])
    .filter(f => f.attributes?.some(a => a.kind === 'id' || a.kind === 'unique'))
    .map(f => f.name)

  return function watch() {
    const reads = []
    const off = client.$tapQuery(event => {
      for (const read of readsOf(event, { modelOf, uniques, relations })) reads.push(read)
    })
    let open = true
    return function stop() {
      if (open && typeof off === 'function') off()
      open = false
      return dedupe(reads)
    }
  }
}

/**
 * @typedef {{ model: string|null, columns: string[]|null,
 *   key?: { field: string, values: unknown[] } }} PageRead
 *
 * `model` null is a read the build could not attribute — any write reaches it.
 * `columns` null is every column. `key` is a unique field the read's filter
 * pins to a value or an `in` list.
 */

/** The reads one tap event stands for. */
function readsOf(event, { modelOf, uniques, relations }) {
  if (!event) return []
  if (event.operation === 'sql') return [{ model: ALL, columns: ALL }]
  if (!event.model) return []

  const model = modelOf(event.model)
  const name  = model?.name ?? String(event.model)
  const args  = event.args

  // An include's child statement carries no arguments of its own. The parent's
  // event expands the relation below with the columns it selected; this one
  // is kept only when there is no relation map to expand it with.
  if (!args) return relations ? [] : [{ model: name, columns: ALL }]

  const out = []
  const read = { model: name, columns: [] }
  const add = cols => {
    if (read.columns === ALL) return
    if (cols === ALL) read.columns = ALL
    else for (const c of cols) if (!read.columns.includes(c)) read.columns.push(c)
  }

  add(whereColumns(name, args.where, relations, out))
  add(orderColumns(args.orderBy))
  if (event.operation === 'aggregate' || event.operation === 'groupBy') {
    add(Array.isArray(args.by) ? args.by : [])
    for (const k of ['_min', '_max', '_sum', '_avg'])
      add(Object.keys(args[k] ?? {}).filter(c => args[k][c]))
  } else if (!COUNTS.has(event.operation)) {
    add(resultColumns(name, args, relations, out))
  }

  const key = pinnedKey(args.where, uniques(model))
  if (key) read.key = key
  return [read, ...out]
}

/**
 * The columns a filter reads. A relation filter (`tags: { some: … }`) is a read
 * of the target model too, whose rows decide which of these rows match.
 */
function whereColumns(model, where, relations, out) {
  if (!where || typeof where !== 'object') return []
  const cols = []
  let raw = false
  const walk = node => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (COMBINATORS.has(k)) { walk(v); continue }
      if (k === '$raw') { raw = true; continue }
      const rel = relations?.[model]?.[k]
      if (rel?.targetModel) { out.push({ model: rel.targetModel, columns: ALL }); cols.push(...joinColumns(rel)); continue }
      cols.push(k)
    }
  }
  walk(where)
  return raw ? ALL : cols
}

/** Both sides' join columns: which side holds the foreign key differs by kind. */
const joinColumns = rel => [...(rel.foreignKeys ?? []), ...(rel.referencedKeys ?? [])]

function orderColumns(orderBy) {
  if (!orderBy) return []
  const list = Array.isArray(orderBy) ? orderBy : [orderBy]
  return list.flatMap(o => typeof o === 'string' ? [o] : Object.keys(o ?? {}))
}

/**
 * The columns a read puts in its result, expanding `include`/`select` through
 * the relation map into reads of the child models. A child read is never
 * keyed: which child rows came back is the parent's join, not a filter here.
 */
function resultColumns(model, node, relations, out, depth = 0) {
  const select  = node?.select && typeof node.select === 'object' ? node.select : null
  const include = node?.include && typeof node.include === 'object' ? node.include : null
  const cols = []
  const child = (name, value) => {
    const rel = relations?.[model]?.[name]
    if (!rel?.targetModel) return false
    cols.push(...joinColumns(rel))
    const columns = depth > 12 ? ALL : resultColumns(rel.targetModel, value && typeof value === 'object' ? value : {}, relations, out, depth + 1)
    out.push({ model: rel.targetModel, columns: columns === ALL ? ALL : [...columns, ...joinColumns(rel)] })
    return true
  }
  const follow = (name, value) => {
    if (value === false || value == null) return
    if (name === '_count') {
      for (const n of Object.keys(value?.select ?? {})) {
        const rel = relations?.[model]?.[n]
        out.push({ model: rel?.targetModel ?? ALL, columns: rel?.targetModel ? joinColumns(rel) : ALL })
      }
      return
    }
    if (child(name, value)) return
    // A relation key the map does not carry names a model this read cannot.
    if (value && typeof value === 'object') { out.push({ model: ALL, columns: ALL }); return }
    cols.push(name)
  }
  if (select) for (const [k, v] of Object.entries(select)) follow(k, v)
  if (include) for (const [k, v] of Object.entries(include)) if (v !== false && v != null) {
    if (k === '_count') follow(k, v)
    else if (!child(k, v)) out.push({ model: ALL, columns: ALL })
  }
  return select ? cols : ALL
}

/** A top-level `where` entry pinning a unique field: `{ slug: 'a' }`, `{ id: { in: [1, 2] } }`. */
function pinnedKey(where, uniqueFields) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return null
  for (const field of uniqueFields) {
    if (!(field in where)) continue
    const v = where[field]
    if (v === null || ['string', 'number', 'bigint', 'boolean'].includes(typeof v)) return { field, values: [v] }
    if (v && typeof v === 'object') {
      if ('equals' in v && Object.keys(v).length === 1) return { field, values: [v.equals] }
      if (Array.isArray(v.in) && Object.keys(v).length === 1) return { field, values: v.in }
    }
  }
  return null
}

function dedupe(reads) {
  const seen = new Set()
  return reads.filter(r => {
    const k = JSON.stringify(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ─── Matching a write ───────────────────────────────────────────────────────

/**
 * The prerendered pages one write would change.
 *
 * `write` is `{ model, before?, after?, changed? }`: a create carries `after`,
 * a delete `before`, an update both or the column names in `changed`. Without
 * the row the key a read pins cannot be compared, so every keyed read of the
 * model is reached; without the columns, every column is.
 *
 * `routes` are the routes whose `getStaticPaths()` read is reached — their page
 * LIST may change, so a page this manifest never held (a newly published post)
 * is named by its route, and the sitemap is reached whenever one is.
 *
 * @param {{ routes: Array<{ route: string, paths: PageRead[],
 *   pages: Array<{ url: string, reads: PageRead[] }> }> }} manifest
 * @param {{ model: string, before?: object, after?: object, changed?: string[] }} write
 * @returns {{ urls: string[], routes: string[], sitemap: boolean }}
 */
export function affectedPages(manifest, write) {
  if (!write?.model) throw new TypeError('affectedPages: a write names its model — { model, before?, after?, changed? }')
  const model   = norm(write.model)
  const rows    = [write.before, write.after].filter(r => r && typeof r === 'object')
  const changed = changedColumns(write)

  const reaches = read => {
    if (read.model !== ALL && norm(read.model) !== model) return false
    if (changed && read.columns && !read.columns.some(c => changed.includes(c))) return false
    if (read.key && rows.length) {
      const { field, values } = read.key
      return rows.some(r => !(field in r) || values.some(v => String(v) === String(r[field])))
    }
    return true
  }

  const urls = [], routes = []
  for (const r of manifest?.routes ?? []) {
    if ((r.paths ?? []).some(reaches)) routes.push(r.route)
    for (const p of r.pages ?? []) if ((p.reads ?? []).some(reaches)) urls.push(p.url)
  }
  return { urls, routes, sitemap: routes.length > 0 }
}

/** Null is every column: a create or delete changes the row set itself. */
function changedColumns({ before, after, changed }) {
  if (Array.isArray(changed)) return changed
  if (!before || !after) return null
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}
