// api/test/unique-conflict.test.ts
// A duplicate under a @@unique is refused by the constraint at the Data
// boundary, and `app.ts`'s one error mapper says it as a 409 in this app's
// words. A service that checks first restates a rule the schema already owns,
// and says it in a different status (FJS-2360).

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv, session } from '@frontierjs/testing'
import { GatePlugin } from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')

let env: any
let owner: any
const uniq = () => Math.random().toString(36).slice(2, 8)

beforeAll(async () => {
  env = await createTestEnv({
    schema:        SCHEMA,
    migrations:    MIGRATIONS,
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system as any
  const acct = await sys.account.create({ data: { slug: `acme-${uniq()}`, displayName: 'Acme' } })
  const user = await sys.user.create({ data: { email: `owner-${uniq()}@x.co`, accountId: acct.id } })
  const ws   = await sys.workspace.create({
    data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}`, ownerId: user.id },
  })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: user.id, role: 'owner',
    capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString(),
  } })
  owner = session({ userId: user.id, workspaceId: ws.id })
}, 120_000)

afterAll(async () => { await env?.close() })

const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e)

describe('a duplicate under a @@unique is a 409 in the app\'s words', () => {
  test('a secret name', async () => {
    const secrets = () => env.as(owner).service('secrets')
    await secrets().create({ name: 'token', kind: 'generic', data: 'a' })
    const err = await refusal(secrets().create({ name: 'token', kind: 'generic', data: 'b' }))
    expect(err.code ?? err.status).toBe(409)
    expect(err.message).toBe("Secret name 'token' already exists in this workspace")
  })

  test('a project slug, whose parent is the workspace', async () => {
    const projects = () => env.as(owner).service('projects')
    await projects().create({ name: 'Site', slug: 'site' })
    const err = await refusal(projects().create({ name: 'Site again', slug: 'site' }))
    expect(err.code ?? err.status).toBe(409)
    expect(err.message).toBe("Project slug 'site' already exists in this workspace")
  })

  test('an environment slug names its project, and the per-field error survives', async () => {
    const project = await env.as(owner).service('projects').create({ name: 'Env host', slug: `p-${uniq()}` })
    const envs    = () => env.as(owner).service('environments')
    await envs().create({ projectId: project.id, name: 'Prod', slug: 'prod', tier: 'production' })
    const err = await refusal(envs().create({ projectId: project.id, name: 'Prod 2', slug: 'prod', tier: 'production' }))
    expect(err.code ?? err.status).toBe(409)
    expect(err.message).toBe("Environment slug 'prod' already exists in this project")
    expect(err.data.map((f: any) => f.path[0])).toEqual(['projectId', 'slug'])
  })
})
