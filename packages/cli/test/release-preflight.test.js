// ─── release-preflight.test.js — the App's settings against the app's declarations
//
// The App below is the one measured on 2026-10-27 (ela's first Basecamp
// release): no Variables, no volume, no port, no health check, no Domain. Each
// rule is asserted on it and then on the settings that answer it, so a rule
// that cannot go quiet fails here and not on the next app.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseFindings, mergeVariables, imageRuntime, readEnvSpec, releasePlan, neverReleased } from '../core/release-preflight.js'

const SPEC = { spec: {
  ENCRYPTION_KEY:   { type: 'string', required: true },
  DATABASE_URL:     { type: 'string', required: false, default: './db/app.db' },
  JOBS_PATH:        { type: 'string', required: false, default: './db/jobs.db' },
  PORT:             { type: 'port',   required: false, default: 8100 },
  FRONTIER_APP_URL: { type: 'url',    required: false, default: 'http://localhost:8000' },
  NODE_ENV:         { type: 'string', required: false, default: 'development' },
  SA_URL:           { type: 'url',    required: false, default: 'https://my.serviceautopilot.com' },
  TELNYX_URL:       { type: 'url',    required: false },
} }
const DATABASES = [
  { name: 'main',  driver: 'sqlite', path: './db/app.db',  envVar: 'DATABASE_URL' },
  { name: 'sync',  driver: 'sqlite', path: './db/sync.db', envVar: 'SYNC_PATH' },
]
const BARE = {
  id: 'a1', name: 'app', environmentId: 'e1', port: null, containerPort: null, volumePath: null,
  healthCheck: null, exposesPort: false, domains: [],
  environment: { name: 'Preview', tier: 'preview', project: { name: 'NELA' } },
  placement: [{ server: { name: 'host', ipAddress: '10.0.0.1' } }],
}
const IMAGE = { workdir: '/app', env: {} }
const HEALTH = { path: '/api/health', declared: true }

const v = (key, value, extra = {}) => ({ key, value, appId: 'a1', secret: false, ...extra })
const ANSWERED = [
  v('ENCRYPTION_KEY', null, { secret: true }),
  v('DATABASE_URL', '/db/app.db'), v('SYNC_PATH', '/db/sync.db'), v('JOBS_PATH', '/db/jobs.db'),
  v('PORT', '3000'), v('FRONTIER_APP_URL', 'https://ela.example.com'),
  v('NODE_ENV', 'production'), v('SA_URL', 'http://127.0.0.1:9'),
]
const SETTLED = { ...BARE, port: 3000, volumePath: '/db', healthCheck: '/api/health', domains: [{ hostname: 'ela.example.com' }] }

const run = (over = {}) => releaseFindings({
  app: BARE, variables: [], siblings: [], envSpec: SPEC, databases: DATABASES, health: HEALTH, image: IMAGE, ...over,
})
const rules = (found) => found.filter(f => f.level !== 'info').map(f => `${f.level}:${f.rule}`).sort()

describe('the measured App', () => {
  test('every rule fires on it', () => {
    expect(rules(run())).toEqual([
      'error:env-required', 'error:no-port', 'error:state-off-volume',
      'warn:external-default', 'warn:health-unchecked', 'warn:local-default', 'warn:node-env', 'warn:unrouted',
    ])
  })

  test('and all of them go quiet once it is answered', () => {
    expect(rules(run({ app: SETTLED, variables: ANSWERED }))).toEqual([])
  })
})

describe('env-required', () => {
  test('a secret row counts as set, with no value to read', () => {
    expect(run({ variables: [v('ENCRYPTION_KEY', null, { secret: true })] }).some(f => f.rule === 'env-required')).toBe(false)
  })

  test('an environment-wide row reaches the App, and an empty value does not count', () => {
    const wide = { ...v('ENCRYPTION_KEY', 'k'), appId: null }
    expect(run({ variables: [wide] }).some(f => f.rule === 'env-required')).toBe(false)
    expect(run({ variables: [v('ENCRYPTION_KEY', '')] }).some(f => f.rule === 'env-required')).toBe(true)
  })

  test('an image ENV line answers it', () => {
    expect(run({ image: { workdir: '/app', env: { ENCRYPTION_KEY: 'x' } } }).some(f => f.rule === 'env-required')).toBe(false)
  })
})

describe('state-off-volume', () => {
  const off = (over) => run(over).find(f => f.rule === 'state-off-volume')

  test('names the schema\'s databases and the spec\'s *_PATH, resolved against WORKDIR', () => {
    const f = off()
    expect(f.detail).toContain('DATABASE_URL → /app/db/app.db')
    expect(f.detail).toContain('SYNC_PATH → /app/db/sync.db')
    expect(f.detail).toContain('JOBS_PATH → /app/db/jobs.db')
  })

  test('a volume with the paths left on their defaults is still off it', () => {
    expect(off({ app: { ...BARE, volumePath: '/db' } }).title).toContain('outside the volume at /db')
  })

  test('a path set under the volume passes, and a secret path is not guessed at', () => {
    const app = { ...BARE, volumePath: '/db' }
    const variables = [v('DATABASE_URL', null, { secret: true }), v('SYNC_PATH', '/db/sync.db'), v('JOBS_PATH', '/db/jobs.db')]
    expect(off({ app, variables })).toBeUndefined()
  })

  test('a literal schema path says only the schema can move it', () => {
    const databases = [{ name: 'audit', driver: 'jsonl', path: './db/audit/', envVar: null }]
    expect(off({ databases, envSpec: { spec: {} } }).detail).toContain('literal path in db/schema.lite')
  })
})

describe('ports', () => {
  test('the App sending to a port the app does not listen on', () => {
    const f = run({ app: { ...BARE, port: 3000 } }).find(f => f.rule === 'port-mismatch')
    expect(f.title).toBe('the App sends traffic to 3000, and the app listens on 8100')
  })

  test('containerPort is what the image listens on when the App sets it', () => {
    expect(run({ app: { ...BARE, port: 443, containerPort: 8100 } }).some(f => f.rule === 'port-mismatch')).toBe(false)
  })

  test('a never-ported App takes the first host port its machine leaves free, and keeps the listen port inside', () => {
    const f = run({ app: { ...BARE, portsTaken: [8100, 8101] } }).find(f => f.rule === 'no-port')
    expect(f.fix).toEqual({ app: { port: 8102, containerPort: 8100 } })
  })

  test('a host port another App on the machine publishes is an error whose fix keeps the container port', () => {
    const f = run({ app: { ...BARE, port: 8100, containerPort: 8100, portsTaken: [8100, 8120] } }).find(f => f.rule === 'port-taken')
    expect(f.level).toBe('error')
    expect(f.fix).toEqual({ app: { port: 8101, containerPort: 8100 } })
    expect(run({ app: { ...BARE, port: 8101, containerPort: 8100, portsTaken: [8100] } }).some(f => f.rule === 'port-taken')).toBe(false)
  })
})

test('health: a check on a path the app does not serve', () => {
  const f = run({ app: { ...BARE, healthCheck: '/health' } }).find(f => f.rule === 'health-unchecked')
  expect(f.title).toContain('/api/health')
})

test('a URL with no default is not a finding — unbound is off', () => {
  expect(run().some(f => f.title.includes('TELNYX_URL'))).toBe(false)
})

test('unreadable Variables skip the variable rules and say why', () => {
  const found = run({ variables: null, unread: { variables: 'Basecamp refused GET /variables (403): scope' } })
  expect(found.find(f => f.rule === 'unreadable').hint).toContain('variables:read')
  expect(found.some(f => ['env-required', 'state-off-volume', 'external-default'].includes(f.rule))).toBe(false)
})

test('web/ is answered by a static App in the environment', () => {
  const found = (siblings) => run({ surfaces: ['web'], siblings }).some(f => f.rule === 'surface-unreleased')
  expect(found([])).toBe(true)
  expect(found([{ id: 'w1', source: { kind: 'inline' } }])).toBe(false)
})

test('mergeVariables: the App\'s own row wins over the environment\'s', () => {
  const merged = mergeVariables([v('A', 'app'), { ...v('A', 'env'), appId: null }, v('B', 'other', { appId: 'a2' })], 'a1')
  expect(merged.get('A').value).toBe('app')
  expect(merged.has('B')).toBe(false)
})

test('imageRuntime reads the FINAL stage — an earlier stage\'s ENV does not survive FROM', () => {
  const df = 'FROM oven/bun:1 AS base\nWORKDIR /app\nENV NODE_ENV=production\nFROM oven/bun:1-slim\nWORKDIR /app\nENV PORT=3000\n'
  expect(imageRuntime(df)).toEqual({ workdir: '/app', env: { PORT: '3000' } })
})

describe('readEnvSpec', () => {
  test('reads defineEnv\'s spec without the app booting, from a clean environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-spec-'))
    try {
      mkdirSync(join(root, 'api/src/core'), { recursive: true })
      writeFileSync(join(root, 'api/src/core/env.ts'),
        "import { defineEnv } from '@frontierjs/junction'\n" +
        "export const env = defineEnv({ KEY: { required: true }, PORT: { type: 'port', default: Number(process.env.FRONTIER_PORT_BE ?? 8100) } })\n")
      process.env.FRONTIER_PORT_BE = '9999'
      expect(readEnvSpec(root)).toEqual({ spec: {
        KEY:  { type: 'string', required: true },
        PORT: { type: 'port', required: false, default: 8100 },
      } })
    } finally {
      delete process.env.FRONTIER_PORT_BE
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an app with no env module says so', () => {
    expect(readEnvSpec(tmpdir()).error).toContain('no env module')
  })
})

describe('the plan a never-released App yields (FJS-3525)', () => {
  const found = run({ surfaces: ['web'] })

  test('the measured App is never-released, and one with a release or a Variable of its own is not', () => {
    expect(neverReleased(BARE, [])).toBe(true)
    expect(neverReleased({ ...BARE, recent_deployments: [{ id: 'd1' }] }, [])).toBe(false)
    expect(neverReleased(BARE, [v('NODE_ENV', 'production')])).toBe(false)
    expect(neverReleased(BARE, [{ key: 'NODE_ENV', value: 'x', appId: null }])).toBe(true)
  })

  test('every setting finding carries its fix, and the ones that need a person do not', () => {
    const fixes = Object.fromEntries(found.map(f => [f.rule, f.fix]))
    expect(fixes['no-port']).toEqual({ app: { port: 8100, containerPort: 8100 } })
    expect(fixes['state-off-volume']).toEqual({ app: { volumePath: '/db' }, variables: [
      { key: 'DATABASE_URL', value: '/db/app.db' }, { key: 'SYNC_PATH', value: '/db/sync.db' }, { key: 'JOBS_PATH', value: '/db/jobs.db' },
    ] })
    expect(fixes['env-required']).toEqual({ variables: [{ key: 'ENCRYPTION_KEY', secret: true, generate: 'hex32' }] })
    expect(fixes['health-unchecked']).toEqual({ app: { healthCheck: '/api/health' } })
    expect(fixes['external-default']).toEqual({ variables: [{ key: 'SA_URL', value: 'https://my.serviceautopilot.com' }] })
    expect(fixes['local-default']).toEqual({ variables: [{ key: 'FRONTIER_APP_URL', derive: 'origin' }] })
    expect(fixes['node-env']).toEqual({ variables: [{ key: 'NODE_ENV', value: 'production' }] })
    expect(fixes['unrouted']).toEqual({ domain: true })
    expect(fixes['surface-unreleased']).toEqual({ web: true })
    // A required credential is somebody's: no fix.
    const cred = run({ envSpec: { spec: { ...SPEC.spec, TELNYX_KEY: { type: 'string', required: true } } } })
    expect(cred.find(f => f.rule === 'env-required' && f.title.startsWith('TELNYX_KEY')).fix).toBeNull()
  })

  test('with a hostname: one App patch, the rows, a static App, the Domain on it and the routes back (FJS-D1547)', () => {
    const plan = releasePlan(found, { hostname: 'https://ela.example.com/', prefixes: ['/api', '/ws'] })
    expect(plan.app).toEqual({ port: 8100, containerPort: 8100, volumePath: '/db', healthCheck: '/api/health' })
    expect(plan.variables.map(r => r.key).sort()).toEqual(
      ['DATABASE_URL', 'ENCRYPTION_KEY', 'FRONTIER_APP_URL', 'JOBS_PATH', 'NODE_ENV', 'SA_URL', 'SYNC_PATH'])
    expect(plan.variables.find(r => r.key === 'FRONTIER_APP_URL')).toEqual({ key: 'FRONTIER_APP_URL', value: 'https://ela.example.com' })
    expect(plan.web).toBe(true)
    expect(plan.domain).toEqual({ hostname: 'ela.example.com', on: 'web', routes: ['/api', '/ws'] })
    expect(plan.asked).toEqual([])
    expect(plan.empty).toBe(false)
  })

  test('without web/, the Domain is this App\'s and nothing is routed', () => {
    const plan = releasePlan(run(), { hostname: 'ela.example.com' })
    expect(plan.web).toBe(false)
    expect(plan.domain).toEqual({ hostname: 'ela.example.com', on: 'api', routes: [] })
  })

  test('without a hostname the mechanical writes stand and the rest is named as waiting', () => {
    const plan = releasePlan(found, {})
    expect(plan.domain).toBeNull()
    expect(plan.variables.some(r => r.key === 'FRONTIER_APP_URL')).toBe(false)
    expect(plan.asked).toEqual(['Domain', 'FRONTIER_APP_URL'])
    expect(plan.app.port).toBe(8100)
  })

  test('a settled App plans nothing', () => {
    const plan = releasePlan(run({ app: SETTLED, variables: ANSWERED }), { hostname: 'ela.example.com' })
    expect(plan.empty).toBe(true)
  })
})
