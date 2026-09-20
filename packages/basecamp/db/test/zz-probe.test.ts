// TEMPORARY probe — delete after FJS-1197. Reproduces the tenant-isolation
// seeding failure and prints which foreign key SQLite refuses.
import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv } from '../../../litestone/src/testing.js'
import { GatePlugin } from '../../../litestone/src/index.js'
import { basecampGateLevel } from '../../api/src/core/gate.ts'

const SCHEMA     = join(import.meta.dir, '..', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', 'migrations')
const ENC_KEY    = process.env.ENCRYPTION_KEY ?? 'x'.repeat(64)

test('probe', async () => {
  const env: any = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: ENC_KEY,
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
  })
  const sys = env.system
  const names = Object.keys((env as any).schema?.models ?? {})
  console.log('MODELS:', (env as any).schema?.models?.length ?? names.length)
  // what does a Workspace row look like, and does 'tenant-a' exist?
  const rows = (await env.verifyTenantIsolation()) as any[]
  const f = rows.filter((r: any) => ['error','unreachable','leaked','unscoped','unparented'].includes(r.got))
  console.log('FINDINGS:', f.length)
  for (const r of f) console.log('  -', r.got, '|', r.message.slice(0, 120))
  const flows = await env.system.flow.findMany({ limit: 3 })
  console.log('seeded flows:', flows.length, flows.map((x: any) => ({ id: String(x.id).slice(0,8), ownerId: x.ownerId, workspaceId: x.workspaceId })))
  expect(true).toBe(true)
}, 120_000)
