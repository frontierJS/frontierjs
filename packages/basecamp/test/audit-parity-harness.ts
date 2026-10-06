// Shared fixture for the audit-gate-parity tests: one real basecamp app on a
// real port, one real session per standing, one row of each audited model.
import { join }        from 'node:path'
import { createTestEnv } from '@frontierjs/testing'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../api/src/core/gate.ts'
import { buildBasecampApp }  from '../api/src/app.ts'
import { grantsFor }         from '../api/src/core/capabilities.ts'

const ROOT       = join(import.meta.dir, '..')
export const SCHEMA     = join(ROOT, 'db', 'schema.lite')
export const MIGRATIONS = join(ROOT, 'db', 'migrations')
export const PW  = 'hunter2hunter2'
export const LEVELS_ORDER = ['stranger', 'outsider', 'viewer', 'developer', 'admin', 'owner', 'sysadmin'] as const
export type Who = typeof LEVELS_ORDER[number]

export interface Fixture {
  env: any
  ws: any; other: any
  tokens: Record<Who, string | null>
  ids: Record<Who, string | null>
  rows: { secret: any; server: any; variable: any; secretVar: any; audit: any; auditNull: any; otherSecret: any; otherAudit: any }
}

export async function build(): Promise<Fixture> {
  const env: any = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: '0'.repeat(64),
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    listen: true,
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys = env.system as any
  const uniq = () => Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `acme-${uniq()}`, displayName: 'Acme' } })

  const tokens: any = { stranger: null }, ids: any = { stranger: null }
  async function person(who: Who, opts: { role?: string; sysadmin?: boolean } = {}) {
    const email = `${who}-${uniq()}@x.co`
    const u = await env.app.auth.createUser({ email, password: PW, name: who })
    const id = u.id ?? u.userId
    await sys.user.update({ where: { id }, data: { accountId: acct.id, status: 'active', ...(opts.sysadmin ? { isSystemAdmin: true } : {}) } })
    ids[who] = id
    return id
  }
  const ownerId = await person('owner')
  const ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}`, ownerId } })
  const other = await sys.workspace.create({ data: { accountId: acct.id, name: 'Other', slug: `other-${uniq()}`, ownerId } })
  const member = (workspaceId: string, userId: string, role: string) => sys.workspaceMember.create({ data: {
    workspaceId, userId, role, capabilities: grantsFor(role), acceptedAt: new Date().toISOString() } })
  await member(ws.id, ownerId, 'owner')
  await member(other.id, ownerId, 'owner')
  for (const [who, role] of [['viewer', 'viewer'], ['developer', 'developer'], ['admin', 'admin']] as const) {
    await member(ws.id, await person(who), role)
  }
  await person('outsider')
  await person('sysadmin', { sysadmin: true })
  for (const who of LEVELS_ORDER) {
    if (who === 'stranger') continue
    // login() needs the email; recover it
    const row = await sys.user.findFirst({ where: { id: ids[who] } })
    const l = await env.app.auth.login(row.email, PW)
    tokens[who] = l.token ?? l.accessToken
  }

  // ── one row of each audited model, in ws, plus a neighbour in `other` ──
  const secret = await sys.secret.create({ data: { workspaceId: ws.id, name: 'ssh-prod', kind: 'ssh_key', data: '{"k":"PLAINTEXT-SECRET-DATA"}' } })
  const otherSecret = await sys.secret.create({ data: { workspaceId: other.id, name: 'other-key', kind: 'generic', data: '{"k":"OTHER-PLAINTEXT"}' } })
  const server = await sys.server.create({ data: { workspaceId: ws.id, name: 'box-1', slug: `box-${uniq()}`, enrollTokenHash: 'HASH-OF-ENROLL-TOKEN' } })
  const proj = await sys.project.create({ data: { workspaceId: ws.id, name: 'P', slug: `p-${uniq()}` } })
  const envm = await sys.environment.create({ data: { workspaceId: ws.id, projectId: proj.id, name: 'prod', slug: `prod-${uniq()}` } })
  const variable = await sys.variable.create({ data: { workspaceId: ws.id, environmentId: envm.id, key: 'PLAIN_VAR', value: 'plain-value', secret: false } })
  const secretVar = await sys.variable.create({ data: { workspaceId: ws.id, environmentId: envm.id, key: 'SECRET_VAR', secretValue: 'SECRET-VAR-PLAINTEXT', secret: true } })
  const audit = await sys.auditEvent.create({ data: { workspaceId: ws.id, actorId: ownerId, action: 'x.did', subjectType: 'x', subjectId: 'x1', diff: { a: 1 } } })
  const auditNull = await sys.auditEvent.create({ data: { workspaceId: null, actorId: ownerId, action: 'hub.did', subjectType: 'x', subjectId: 'x2' } })
  const otherAudit = await sys.auditEvent.create({ data: { workspaceId: other.id, actorId: ownerId, action: 'o.did', subjectType: 'x', subjectId: 'x3' } })

  return { env, ws, other, tokens, ids, rows: { secret, server, variable, secretVar, audit, auditNull, otherSecret, otherAudit } }
}

export async function http(fx: Fixture, who: Who, method: string, path: string, body?: unknown, ws: string | null | undefined = undefined) {
  const wsId = ws === undefined ? fx.ws.id : ws
  const res = await fetch(`${fx.env.url}${path}`, { method, headers: {
    'content-type': 'application/json',
    ...(fx.tokens[who] ? { authorization: `Bearer ${fx.tokens[who]}` } : {}),
    ...(wsId ? { 'x-workspace-id': wsId } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  let json: any = null; const text = await res.text()
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
export const rowsOf = (j: any): any[] => {
  const d = j?.data ?? j
  const l = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.items) ? d.items : null
  return l ?? (d && typeof d === 'object' && d.id ? [d] : [])
}
