// src/domain/prototypes/candidates.ts — pairs of prototypes that might merge, for the owner to judge.
//
// Two signals (`IDEAS/prototypes-catalog.md` § Phase 3, step 3.2):
//   related   a record links to the other, in either direction, of any kind.
//   shared    the same kind, and both `db/schema.lite` files declare at least
//             MIN_SHARED of the same model names.
//
// Every scaffolded app declares AuditTrail, User and Notification, so a name
// declared in a quarter or more of the schemas read is furniture, not
// evidence. Left in, it would pair every app with every other. The names left
// out are returned so the page can say what was ignored.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandPath, readCatalog, type Record_ } from './catalog.ts'

export const MIN_SHARED = 2

// A declaration starts the line. Indented `model` is a field of that name (`model String`).
const MODEL = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm

/** The model names a schema declares itself; an imported file's models are the framework's, not the app's. */
export function declaredModels(schema: string): string[] {
  return [...new Set([...schema.matchAll(MODEL)].map(m => m[1]))]
}

export type Candidate = {
  a:       string
  b:       string
  /** The shared kind, or null when only a related link joins them. */
  kind:    string | null
  related: Array<{ from: string, to: string, why: string }>
  shared:  string[]
}

/**
 * `schemaOf` returns a record's schema text, or null when it has none.
 * Linked and overlapping pairs come first, then overlap by size, then links alone.
 */
export function findCandidates(records: Record<string, Record_>, schemaOf: (name: string, rec: Record_) => string | null) {
  const models = new Map<string, Set<string>>()
  for (const [name, rec] of Object.entries(records)) {
    const text = schemaOf(name, rec)
    if (text != null) models.set(name, new Set(declaredModels(text)))
  }
  const seen = new Map<string, number>()
  for (const set of models.values()) for (const m of set) seen.set(m, (seen.get(m) ?? 0) + 1)
  const cut = Math.max(3, models.size / 4)
  const common = [...seen].filter(([, n]) => n >= cut).map(([m]) => m).sort()
  const isCommon = new Set(common)

  const pairs = new Map<string, Candidate>()
  const pair = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x]
    const key = `${a}\0${b}`
    if (!pairs.has(key)) pairs.set(key, { a, b, kind: records[a].kind === records[b].kind ? records[a].kind : null, related: [], shared: [] })
    return pairs.get(key)!
  }

  for (const [from, rec] of Object.entries(records))
    for (const r of rec.related ?? [])
      if (r.to !== from && Object.hasOwn(records, r.to)) pair(from, r.to).related.push({ from, to: r.to, why: r.why })

  const names = [...models.keys()].sort()
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const [x, y] = [names[i], names[j]]
      if (records[x].kind !== records[y].kind) continue
      const ys = models.get(y)!
      const shared = [...models.get(x)!].filter(m => ys.has(m) && !isCommon.has(m)).sort()
      if (shared.length >= MIN_SHARED) pair(x, y).shared = shared
    }

  const rank = (c: Candidate) => (c.related.length && c.shared.length ? 0 : c.shared.length ? 1 : 2)
  const candidates = [...pairs.values()].sort((p, q) =>
    rank(p) - rank(q) || q.shared.length - p.shared.length || p.a.localeCompare(q.a) || p.b.localeCompare(q.b))

  return { candidates, common, schemas: models.size, minShared: MIN_SHARED }
}

/** The candidates over the catalog on disk. A record whose folder or schema is gone is read as having none. */
export function listCandidates(o: { dir?: string } = {}) {
  const catalog = readCatalog(o.dir)
  const read = (_: string, rec: Record_) => {
    try { return readFileSync(join(expandPath(rec.path), 'db', 'schema.lite'), 'utf8') } catch { return null }
  }
  return { error: catalog.error, ...findCandidates(catalog.records, read) }
}
