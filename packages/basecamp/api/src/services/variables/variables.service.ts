// src/services/variables/variables.service.ts
// Variables — what a container's environment is, set on an Environment for
// every app in it or on one App.
//
// Mounted at /variables. `?environmentId=<id>&appId=null` is an environment's
// own; `?appId=<id>` is one app's. What a release merges from the two is
// `domain/release/variables.ts`.
//
// A secret's value is written to `secretValue`, which is `@encrypted` and so
// absent from every read here. A secret is replaced, and read back only by
// `reveal` — `POST /variables/:id`, an administrator's, filed in the trail.

import { createService, NotFound, BadRequest, parseWhere, requestMeta, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { sessionScope, workspaceChannel, getPagination, refuseProtectedForDeveloper, WORKSPACE_QUERY }
  from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, ws } from '../../core/resource.ts'
import type { ServiceContext } from '@frontierjs/junction'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { formatDotenv, parseDotenv } from '../../domain/release/dotenv.ts'

/**
 * before/create hook: an app's variable takes its app's environment, which the
 * schema states (`environmentId @default(app.environmentId)`) and litestone
 * fills as the caller — so an app she cannot see is refused by its name, and
 * a create naming neither is refused by the schema. What is left to check is
 * the two columns agreeing when a payload names both.
 */
async function scopeFromPayload() {
  const data = ($.data ?? {}) as Record<string, unknown>
  if (data.appId) {
    const target = await db().app.findFirst({ where: { id: data.appId, workspaceId: ws() } })
    if (!target) throw new NotFound(`App '${data.appId}' not found in this workspace`)
    if (data.environmentId && data.environmentId !== target.environmentId)
      throw new BadRequest(`An app's variable lives in the app's environment, '${target.environmentId}' — leave environmentId out`)
    return
  }
  if (data.environmentId && !await db().environment.exists({ where: { id: data.environmentId, workspaceId: ws() } }))
    throw new NotFound(`Environment '${data.environmentId}' not found in this workspace`)
  data.appId = null
}

/** An environment-wide variable is the environment's to guard. An app's own
 *  is the app's, at the authority that may patch the app. */
async function guard(row: { environmentId: string; appId: string | null }, ctx: ServiceContext) {
  if (row.appId) return
  refuseProtectedForDeveloper(await getScoped('environment', 'Environment', row.environmentId), ctx)
}

/** `value` is what a person types; a secret row keeps it in `secretValue`. */
function placeValue(data: Record<string, unknown>, secret: boolean) {
  if ('secretValue' in data) throw new BadRequest('A secret is sent as `value`, and stored where the variable says')
  if (!('value' in data)) return
  if (typeof data.value !== 'string') throw new BadRequest('value must be text')
  if (secret) { data.secretValue = data.value; delete data.value }
}

// ─── .env in and out ─────────────────────────────────────────────────────

/** The scope a call names, `{ appId }` or `{ environmentId }`, as the rows in it and a file name. */
async function namedScope(data: Record<string, unknown>) {
  if (data.appId) {
    const app = await db().app.findFirst({ where: { id: data.appId, workspaceId: ws() } })
    if (!app) throw new NotFound(`App '${data.appId}' not found in this workspace`)
    return { owner: { appId: app.id }, environmentId: app.environmentId, appId: app.id as string | null, slug: app.slug }
  }
  if (!data.environmentId) throw new BadRequest('Name the variables: appId or environmentId')
  const env = await db().environment.findFirst({ where: { id: data.environmentId, workspaceId: ws() } })
  if (!env) throw new NotFound(`Environment '${data.environmentId}' not found in this workspace`)
  return { owner: { environmentId: env.id }, environmentId: env.id, appId: null, slug: env.slug }
}

interface VariableRow { id: string; key: string; value: string | null; isSecret: boolean; version: number }

async function rowsIn(scope: { environmentId: string; appId: string | null }): Promise<VariableRow[]> {
  const where = scope.appId ? { appId: scope.appId } : { environmentId: scope.environmentId, appId: null }
  return db().variable.findMany({ where, orderBy: { key: 'asc' } }) as Promise<VariableRow[]>
}

/** Each secret's value through `reveal`, so every one is filed in the trail as a reveal is. */
async function revealAll(rows: { id: string; isSecret: boolean }[]) {
  const values: Record<string, string | null> = {}
  for (const r of rows.filter(r => r.isSecret))
    values[r.id] = ((await $.app.service('variables').call('reveal', r.id, {})) as { value: string | null }).value
  return values
}

async function dotenvOf(withSecrets: boolean) {
  const scope  = await namedScope(($.data ?? {}) as Record<string, unknown>)
  const rows   = await rowsIn(scope)
  const values = withSecrets ? await revealAll(rows) : {}
  return {
    filename: `${scope.slug}.env`,
    text: formatDotenv(rows.map(r => ({ key: r.key, isSecret: r.isSecret, value: r.isSecret ? values[r.id] ?? null : r.value }))),
  }
}

type ImportAction = 'create' | 'update' | 'unchanged' | 'skip'

export default createService({
  name:  'variables',
  scope: keyScope('variables'),
  model: 'Variable',
  paginate: { default: 20, max: 200 },
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,
  // No `restore`: a variable comes back with the app or environment that
  // cascaded it, and one removed on its own is gone so its key can be set again.
  methods: [
    'find', 'get', 'create', 'patch', 'remove',
    // Not `read: true`: a reveal is answered once and filed in the trail
    // under who asked, which is what a read is not.
    { method: 'reveal', gate: LEVELS.ADMINISTRATOR },
    { method: 'export',        gate: LEVELS.READER, read: true },
    // The call itself is a read; each secret it carries is a reveal of its own.
    { method: 'exportSecrets', gate: LEVELS.ADMINISTRATOR, read: true },
    { method: 'import',        gate: LEVELS.USER },
  ],

  async find() {
    const { limit, offset } = getPagination()
    return findScoped('variable', { where: parseWhere($.query), orderBy: { key: 'asc' }, limit, offset })
  },

  get: () => getScoped('variable', 'Variable'),

  async create(ctx: ServiceContext) {
    const data = $.data as Record<string, unknown>
    await guard(data as { environmentId: string; appId: string | null }, ctx)
    if (data.value === undefined) throw new BadRequest('value is required')
    placeValue(data, Boolean(data.isSecret))
    return db().variable.create({ data })
  },

  async patch(ctx: ServiceContext) {
    const row = await getScoped('variable', 'Variable')
    await guard(row, ctx)
    // key, secret and the scope are @immutable and the schema refuses them by
    // name; `value` is the one thing a person changes.
    const patch = narrowPatch($.data as Record<string, unknown>)
    placeValue(patch, row.isSecret)
    if (changesNothing(patch)) return row
    return db().variable.update({ where: { id: row.id }, data: patch })
  },

  async remove(ctx: ServiceContext) {
    const row = await getScoped('variable', 'Variable')
    await guard(row, ctx)
    // Gone rather than stamped, or the key stays held by a row nobody can see
    // and setting it again is a 409.
    await db().variable.delete({ where: { id: row.id }, withDeleted: true })
    return row
  },

  // ── reveal — POST /variables/:id  X-Service-Method: reveal ──────
  //
  // A secret's value, for the person who needs it off the machine: the
  // ENCRYPTION_KEY `projects.fromRepo` mints is the one a laptop opening a copy
  // of that database needs (FJS-D1555). Scoped read first, so the row is one
  // the caller may see; the value is `@encrypted` and only a system read has it.
  async reveal() {
    // Under a key, junction keeps the answer to replay it for a day, and this
    // answer is the plaintext (`FJS-3893`). A failed call keeps nothing.
    if (requestMeta()?.idempotencyKey)
      throw new BadRequest('reveal answers once and is not replayed — send it without an Idempotency-Key')
    const row = await getScoped('variable', 'Variable')
    if (!row.isSecret) throw new BadRequest(`${row.key} is not a secret — its value is on every read`)
    const held = await $.db.asSystem().variable.findFirst({ where: { id: row.id }, select: { secretValue: true } })
    // The announcement states the row, so the workspace's other tabs never see the value.
    $.dispatch = row
    return { id: row.id, key: row.key, value: held?.secretValue ?? null }
  },

  // ── export / exportSecrets — { appId } or { environmentId } → { filename, text } ──
  //
  // A secret is `KEY=` under `# secret` in `export`; `exportSecrets` is the
  // administrator's file with the values in it.
  export:        () => dotenvOf(false),
  exportSecrets: () => dotenvOf(true),

  // ── import — { appId | environmentId, text, secrets?, dryRun? } ──────
  //
  // Merges: a key in the file is created or its value replaced, and a key not
  // in it is left alone. `secrets` lists the NEW keys to keep secret and,
  // absent, the file's suggestion stands; a key already set keeps what it is.
  // A secret given no value is kept as it is, so the file `export` wrote
  // imports back without blanking one.
  //
  // Each row goes through `create` or `patch` here, so it is guarded, filed and
  // announced as one typed by hand would be. That is not one transaction, and
  // every line is checked before the first write; a second run of the same
  // file finds the rows written and leaves them.
  async import(ctx: ServiceContext) {
    const data  = ($.data ?? {}) as Record<string, unknown>
    if (typeof data.text !== 'string') throw new BadRequest('text is the .env file, as text')
    const scope = await namedScope(data)
    await guard(scope, ctx)

    const { entries, problems } = parseDotenv(data.text)
    if (problems.length) throw new BadRequest(`The file is not a .env this can read — ${problems.join('; ')}`)
    const chosen = Array.isArray(data.secrets) ? new Set(data.secrets as string[]) : null

    const existing = new Map((await rowsIn(scope)).map(r => [r.key, r]))
    const heldIds  = [...existing.values()].filter(r => r.isSecret).map(r => r.id)
    const heldRows = heldIds.length
      ? await $.db.asSystem().variable.findMany({ where: { id: { in: heldIds } }, select: { id: true, secretValue: true } }) as { id: string; secretValue: string | null }[]
      : []
    const held     = new Map(heldRows.map(h => [h.id, h.secretValue]))

    const plan = entries.map(e => {
      const row = existing.get(e.key)
      if (row) {
        const now = row.isSecret ? held.get(row.id) : row.value
        const action: ImportAction = row.isSecret && e.value === '' ? 'unchanged' : now === e.value ? 'unchanged' : 'update'
        return { key: e.key, isSecret: row.isSecret, action, value: e.value, row }
      }
      const isSecret = chosen ? chosen.has(e.key) : e.suggestSecret
      const action: ImportAction = isSecret && e.value === '' ? 'skip' : 'create'
      return { key: e.key, isSecret, action, value: e.value, row: null, suggestSecret: e.suggestSecret }
    })

    const report = plan.map(({ value: _v, row: _r, ...shown }) =>
      shown.action === 'skip' ? { ...shown, note: 'a secret with no value in the file — set it by hand' } : shown)
    if (data.dryRun) { $.dispatch = false; return { applied: false, rows: report } }

    const variables = $.app.service('variables')
    for (const p of plan) {
      if (p.action === 'create')
        await variables.create({ ...scope.owner, key: p.key, value: p.value, isSecret: p.isSecret })
      else if (p.action === 'update')
        await variables.patch(p.row!.id, { value: p.value, version: p.row!.version })
    }
    // Each row announced itself; the report names no row to announce.
    $.dispatch = false
    return { applied: true, rows: report }
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      create: [scopeFromPayload],
    },
  },
})
