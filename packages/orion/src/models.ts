/*
 * models.ts
 *
 * The host app's models, as the two halves the model nodes need: what the
 * compiler types a write against, and the writes themselves.
 *
 *   modelCatalog(docs)  → IModelCatalog, read off the app's own JSON Schema in
 *                         create and update mode — the same documents junction
 *                         validates a request against, so a flow and a form
 *                         agree about which fields a write may name
 *   litestoneModelActions(models)
 *                       → IModelActions over the run's actor, which for a
 *                         litestone host IS a principal-scoped client: the gate,
 *                         the row policies and the field rules refuse a node
 *                         exactly as they would refuse a request
 *
 * A model name reaches a client only after it is found in the set the schema
 * declares, so a string a flow author wrote never becomes an accessor lookup on
 * its own (Invariant 8).
 */

import { camel } from "@frontierjs/toolbelt/inflect"
import type { IModelActions, IModelCatalog, ModelWrite } from "./engine/ports"

// ─── the catalog ─────────────────────────────────────────────────────────────

interface SchemaDocument {
  $defs?: Record<string, { properties?: Record<string, { readOnly?: boolean }> }>
}

/**
 * `create` and `update` are `generateJsonSchema(schema, { mode })` for each
 * mode; `models` is the schema's model names, since `$defs` also holds enums
 * and declared types.
 */
export function modelCatalog(docs: { create: object; update: object; models: string[] }): IModelCatalog {
  const known = new Set(docs.models)
  const writable = (doc: SchemaDocument, model: string) => new Set(
    Object.entries(doc.$defs?.[model]?.properties ?? {})
      .filter(([, prop]) => !prop.readOnly)
      .map(([name]) => name),
  )
  const cache = new Map<string, ReadonlySet<string>>()

  return {
    fields(model, mode) {
      if (!known.has(model)) return undefined
      const key = `${mode}:${model}`
      if (!cache.has(key)) cache.set(key, writable((mode === "create" ? docs.create : docs.update) as SchemaDocument, model))
      return cache.get(key)
    },
  }
}

// ─── the writes ──────────────────────────────────────────────────────────────

// The calls a write makes, on whatever client the actor is.
interface WritableTable {
  create(args: { data: ModelWrite }): Promise<unknown>
  update(args: { where: Record<string, unknown>; data: ModelWrite }): Promise<unknown>
  delete(args: { where: Record<string, unknown> }): Promise<unknown>
}

interface WritableClient {
  $primaryKey(accessor: string): string[]
}

export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`No model named "${model}" in this app`)
    this.name = "UnknownModelError"
  }
}

/**
 * `clientOf` reads the principal-scoped client off the run's actor, for a host
 * whose actor carries more than the client; the default is the actor itself.
 */
export function litestoneModelActions(
  models: Iterable<string>,
  opts:   { clientOf?: (actor: unknown) => unknown } = {},
): IModelActions {
  const accessors = new Map([...models].map(name => [name, camel(name)]))
  const clientOf  = opts.clientOf ?? ((actor: unknown) => actor)

  function resolve(actor: unknown, model: string) {
    const accessor = accessors.get(model)
    if (!accessor) throw new UnknownModelError(model)
    const client = (actor ? clientOf(actor) : undefined) as (WritableClient & Record<string, WritableTable>) | undefined
    if (!client) throw new Error(`No principal to write ${model} as — the run has no actor`)
    return { client, accessor, table: client[accessor]! }
  }

  // One value names one row only where the key is one column; the schema says
  // which column, since it is not always `id`.
  function rowWhere(client: WritableClient, accessor: string, model: string, id: unknown) {
    const key = client.$primaryKey(accessor)
    if (key.length !== 1) throw new Error(`${model} is keyed by ${key.join(", ")}, which one id cannot name`)
    return { [key[0]!]: id }
  }

  return {
    create(actor, model, data) {
      return resolve(actor, model).table.create({ data })
    },
    patch(actor, model, id, data) {
      const { client, accessor, table } = resolve(actor, model)
      return table.update({ where: rowWhere(client, accessor, model, id), data })
    },
    remove(actor, model, id) {
      const { client, accessor, table } = resolve(actor, model)
      return table.delete({ where: rowWhere(client, accessor, model, id) })
    },
  }
}
