/*
 * src/breadcrumbs.ts — what a caller may do next with the one row a call answered.
 *
 * After `orders_get 5`, the moves the order's state allows and the rows it
 * points at, each as a tool call the caller could make now (`FJS-D398`). An
 * agent reading the result is served by the list exactly as a person at a
 * command line is.
 *
 * **Nothing here grades a standing.** Every breadcrumb names a tool in the
 * caller's OWN offered list, which `projectTools` graded — a move at
 * `max(model update, move gate)`, a relation's read at the target's `@@gate`.
 * This module only asks which of those tools the ROW makes sensible: a move whose
 * `from` holds the row's current value, a read of the row a foreign key names,
 * a find over the rows naming this one. Sierra's `transitionsAt` is the UI
 * realm's and out of reach (Invariant 1), and would be a second grader and a
 * weaker one: it compares the move's own number, which offers `invoices.void`
 * (`@gate 5` on a model written at 8) below what the boundary accepts.
 *
 * It is the tool list's affordance and has the tool list's limit (Invariant 6):
 * a row POLICY is not graded, so a move a policy refuses is offered and refused
 * when called. It can only OMIT wrongly in one way — a move served by a method
 * named differently from the move is not recognized as that move, which is the
 * projection's own convention.
 */

import type { Tool } from './projection.ts'

export const BREADCRUMBS_META = 'frontierjs/breadcrumbs'

export type Breadcrumb =
  /** A declared move the row's current state allows. */
  | { kind: 'move';      tool: string; args: { id: unknown }; move: string; field: string; to: string }
  /** The row a foreign key on this one names. */
  | { kind: 'belongsTo'; tool: string; args: { id: unknown }; relation: string }
  /** The rows whose foreign key names this one. */
  | { kind: 'hasMany';   tool: string; args: { query: Record<string, unknown> }; relation: string }

interface RelationDef {
  field:       string
  model:       string
  type:        'belongsTo' | 'hasMany' | 'm2m'
  fields?:     string[]
  references?: string[]
}

interface MoveDef { from: string[]; to: string }

type Defs = Record<string, { 'x-transitions'?: Record<string, Record<string, MoveDef>>; 'x-relations'?: RelationDef[] } | undefined>

/**
 * The CRUD verbs that answer ONE row of their model. A custom method's answer
 * is whatever its author returned, so it gets none rather than a guess from a
 * shape that happens to carry an `id`.
 */
const ONE_ROW = new Set(['get', 'create', 'patch', 'update', 'restore'])

/** Whether a call to `tool` answers a row breadcrumbs can be read off. */
export function answersOneRow(tool: Tool): boolean {
  return tool.model !== null && (tool.kind === 'move' || (tool.kind === 'crud' && ONE_ROW.has(tool.method)))
}

/**
 * The breadcrumbs for `row`, answered by `tool` called with `args`, among the
 * caller's `offered` tools.
 *
 * The row's own identifier is the one the call was given, else the row's `id`
 * — a `create` is given none. A model keyed otherwise and just created gets no
 * moves; its relations still resolve, since they read the columns the
 * relations name.
 */
export function breadcrumbsFor(tool: Tool, row: unknown, args: Record<string, unknown>, offered: Tool[], defs: Defs): Breadcrumb[] {
  if (!answersOneRow(tool) || !row || typeof row !== 'object' || Array.isArray(row)) return []
  const r     = row as Record<string, unknown>
  const model = tool.model!
  const def   = defs[model]
  const out: Breadcrumb[] = []

  // ── the moves the row's state allows, on the service that answered ────────
  // Only that service: a second service over the same model is a different
  // surface with its own hooks, and the caller asked this one.
  const id = args.id ?? r.id
  if (id != null) {
    for (const [field, moves] of Object.entries(def?.['x-transitions'] ?? {})) {
      const current = r[field]
      if (current == null) continue
      for (const [name, move] of Object.entries(moves)) {
        if (!move.from.includes(current as string)) continue
        const t = offered.find(o => o.kind === 'move' && o.service === tool.service && o.method === name)
        if (t) out.push({ kind: 'move', tool: t.name, args: { id }, move: name, field, to: move.to })
      }
    }
  }

  // ── the rows it points at, and the rows pointing at it ────────────────────
  for (const rel of def?.['x-relations'] ?? []) {
    if (rel.type === 'belongsTo') {
      // A composite key has no `get` to name it with.
      if (rel.fields?.length !== 1) continue
      const value = r[rel.fields[0]]
      if (value == null) continue
      for (const t of offered.filter(o => o.model === rel.model && o.method === 'get'))
        out.push({ kind: 'belongsTo', tool: t.name, args: { id: value }, relation: rel.field })
    }

    if (rel.type === 'hasMany') {
      // The foreign key lives on the OTHER model, as its belongsTo back here.
      // Two of them (an order's buyer and its seller) cannot be told apart
      // without the relation's name, so an ambiguous one is left out.
      const back = (defs[rel.model]?.['x-relations'] ?? []).filter(b => b.type === 'belongsTo' && b.model === model)
      if (back.length !== 1 || !back[0].fields?.length) continue
      const query: Record<string, unknown> = {}
      back[0].fields.forEach((fk, i) => { query[fk] = r[back[0].references?.[i] ?? 'id'] })
      if (Object.values(query).some(v => v == null)) continue
      for (const t of offered.filter(o => o.model === rel.model && o.method === 'find' && filters(o, Object.keys(query))))
        out.push({ kind: 'hasMany', tool: t.name, args: { query }, relation: rel.field })
    }
  }
  return out
}

/** A find whose query schema lists its columns and leaves one out would refuse the filter. */
function filters(t: Tool, columns: string[]): boolean {
  const q = (t.input.schema?.properties as Record<string, { properties?: Record<string, unknown> }> | undefined)?.query
  return !q?.properties || columns.every(c => c in q.properties!)
}

/** One line per breadcrumb, for a reader that reads only the text — an agent. */
export function describeBreadcrumbs(crumbs: Breadcrumb[]): string {
  const lines = crumbs.map(b => {
    const call = `${b.tool} ${JSON.stringify(b.args)}`
    if (b.kind === 'move')      return `${call} — ${b.move}: ${b.field} → ${b.to}`
    if (b.kind === 'belongsTo') return `${call} — the ${b.relation} this row points at`
    return `${call} — its ${b.relation}`
  })
  return ['Next, at your standing:', ...lines].join('\n')
}
