/**
 * posture.test.ts — a machine's security posture: the grader, and a signed
 * report landing as a row, its ServerEvents and the fleet ranking (FJS-2713).
 *
 * The grader half is pure and graded against the shapes the Outpost sends
 * (`inspector.posture()`, tested against a real capture in packages/outpost).
 * The service half signs with an enrolled machine's own key, as a real Outpost
 * does, because an unsigned report is refused at the transport.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { join }        from 'node:path'
import { createHash }  from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir }      from 'node:os'
import { ensureCert }  from '@frontierjs/outpost/cert'
import { createTestEnv, session } from '@frontierjs/testing'
import { signRequest } from '@frontierjs/toolbelt/signature'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'
import { declaredFor, gradeHub, gradePosture, gradeReplication, HUB_CONTROL_IDS, postureChanges, publicKeyFingerprints, POSTURE_INTERVAL_MS } from '../src/domain/host/posture.ts'
import { HOST_SLUG } from '../src/domain/host/host-machine.ts'
import type { HostDeclared, PostureReadings } from '../src/domain/host/posture.ts'
import { componentById, matchGithub, rangeOf, versionOf } from '../src/domain/host/components.ts'
import { prunePosture } from '../src/jobs/retention.job.ts'

const NOW = Date.parse('2026-10-13T12:00:00Z')

// A clean fleet box, the shape `inspector.posture()` answers.
const CLEAN: PostureReadings = {
  os:           { id: 'ubuntu', version: '24.04', codename: 'noble' },
  kernel:       { running: '6.8.0-45-generic', installed: ['6.8.0-45-generic'] },
  reboot:       { required: false, since: null, pkgs: [] },
  updates:      { pending: 3, security: 0 },
  auto_updates: { enabled: true, last_run: '2026-10-13T06:00:00Z' },
  versions:     { docker: '27.3.1', caddy: '2.8.4', bun: '1.4.2' },
  listening:    [
    { address: '0.0.0.0',   port: 22,   process: 'sshd' },
    { address: '::',        port: 443,  process: 'caddy' },
    { address: '0.0.0.0',   port: 8180, process: 'bun' },
    { address: '127.0.0.1', port: 2019, process: 'caddy' },
    { address: '127.0.0.1', port: 8090, process: 'docker-proxy' },
  ],
  containers:   [{ name: 'fjs-web', published: [{ host_ip: '127.0.0.1', host_port: 8090, container_port: 80, proto: 'tcp' }] }],
  firewall:     { input_policy: 'drop', forward_drop: true, exposed: [] },
  ssh:          { password_authentication: 'no', permit_root_login: 'prohibit-password', pubkey_authentication: 'yes', max_auth_tries: 3 },
  ssh_keys:     [],
  uid0:         ['root'],
  nopasswd:     [],
  docker_group: [],
  time:         { synced: true, offset_s: 0.0004 },
  outpost_unit: { exposure: 4.2, predicate: 'OK' },
  privileged:   [{ name: '/fjs-web', privileged: false, docker_sock: false }],
  files:        [],
  cert:         { expires_at: '2027-10-01T00:00:00Z' },
}

const DECLARED = declaredFor({ sshPort: 22, apps: [{ type: 'container', port: 8090, exposesPort: false }], sshKeyData: null })
const grade    = (r: PostureReadings | null, at: number | string = NOW) => gradePosture(r, DECLARED, { at, now: NOW })
const byId     = (r: PostureReadings | null, at?: number) => Object.fromEntries(grade(r, at).map(c => [c.id, c]))

describe('the grader', () => {
  test('a clean box passes every control it can read', () => {
    const controls = byId(CLEAN)
    // No key Basecamp issued is on record, so the unknown key cannot be told.
    expect(controls['ssh.unknown-key'].ok).toBe('unknown')
    const rest = Object.values(controls).filter(c => c.id !== 'ssh.unknown-key')
    expect(rest.filter(c => c.ok !== true).map(c => `${c.id}: ${c.message}`)).toEqual([])
  })

  test('the drift the row names fails by name', () => {
    const drifted: PostureReadings = {
      ...CLEAN,
      ssh:       { ...CLEAN.ssh!, password_authentication: 'yes' },
      listening: [...CLEAN.listening!, { address: '0.0.0.0', port: 6379, process: 'redis-server' }],
      updates:   { pending: 12, security: 4 },
    }
    const c = byId(drifted)
    expect(c['ssh.password-off'].ok).toBe(false)
    expect(c['net.unexpected-listener'].ok).toBe(false)
    expect(c['net.unexpected-listener'].message).toContain('6379 (redis-server)')
    expect(c['patch.security-pending'].ok).toBe(false)
  })

  test('anyone in the docker group is root on the box, and named', () => {
    const c = byId({ ...CLEAN, docker_group: ['deploy', 'j'] })['accounts.docker-group']
    expect(c.ok).toBe(false)
    expect(c.message).toContain('deploy, j')
    expect(byId({ ...CLEAN, docker_group: null })['accounts.docker-group'].ok).toBe('unknown')
  })

  test('a reading the box could not take is unknown, never passing', () => {
    const c = byId({ ...CLEAN, ssh: null, firewall: null, listening: null })
    expect(c['ssh.password-off'].ok).toBe('unknown')
    expect(c['net.firewall-default-deny'].ok).toBe('unknown')
    expect(c['net.unexpected-listener'].ok).toBe('unknown')
    expect(c['net.caddy-admin-loopback'].ok).toBe('unknown')
  })

  test('a report older than twice its interval grades every control unknown', () => {
    const old = NOW - 2 * POSTURE_INTERVAL_MS - 1
    expect(grade(CLEAN, old).every(c => c.ok === 'unknown')).toBe(true)
    expect(grade(CLEAN, NOW - POSTURE_INTERVAL_MS).some(c => c.ok === true)).toBe(true)
  })

  test('an app that declares exposure is expected; one that does not is a stranger', () => {
    const publicApp: PostureReadings = {
      ...CLEAN,
      listening:  [...CLEAN.listening!, { address: '0.0.0.0', port: 9000, process: 'docker-proxy' }],
      containers: [{ name: 'fjs-raw', published: [{ host_ip: '0.0.0.0', host_port: 9000, container_port: 9000, proto: 'tcp' }] }],
      firewall:   { input_policy: 'drop', forward_drop: false, exposed: [] },
    }
    const undeclared = byId(publicApp)
    expect(undeclared['net.unexpected-listener'].ok).toBe(false)
    expect(undeclared['net.container-public'].ok).toBe(false)

    const declared = declaredFor({ sshPort: 22, apps: [{ type: 'container', port: 9000, exposesPort: true }] })
    const ok = Object.fromEntries(gradePosture(publicApp, declared, { at: NOW, now: NOW }).map(c => [c.id, c]))
    expect(ok['net.unexpected-listener'].ok).toBe(true)
    expect(ok['net.container-public'].ok).toBe(true)
  })

  // FJS-2772: the forward chain drops a published port unless the box's
  // exposed set holds it, so the set is graded against what apps declare.
  test('an undeclared public port is covered by the forward drop, unless the exposed set lets it through', () => {
    const published = { ...CLEAN, containers: [{ name: 'fjs-raw', published: [{ host_ip: '0.0.0.0', host_port: 9000, container_port: 9000, proto: 'tcp' }] }] }
    expect(byId({ ...published, firewall: { input_policy: 'drop', forward_drop: true, exposed: [] } })['net.container-public'].ok).toBe(true)
    const stale = byId({ ...published, firewall: { input_policy: 'drop', forward_drop: true, exposed: [9000] } })['net.container-public']
    expect(stale.ok).toBe(false)
    expect(stale.message).toContain('9000 (fjs-raw)')
  })

  test('a reboot-required naming another kernel series is not a pending reboot', () => {
    // The dev-host capture: a 5.15 image listed while 6.8 HWE runs.
    const c = byId({ ...CLEAN,
      kernel: { running: '6.8.0-138-generic', installed: [] },
      reboot: { required: true, since: '2026-01-01T00:00:00Z', pkgs: ['linux-image-5.15.0-198-generic', 'linux-base'] } })
    expect(c['patch.reboot-pending'].ok).toBe(true)

    const real = byId({ ...CLEAN, reboot: { required: true, since: '2026-09-01T00:00:00Z', pkgs: ['libc6'] } })
    expect(real['patch.reboot-pending'].ok).toBe(false)
  })

  test('a key on the box that Basecamp did not issue is a finding', () => {
    // An ed25519 public key's wire form: a length-prefixed type, then the key.
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
    ]).toString('base64')
    const fp   = 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
    expect(publicKeyFingerprints(`{"public_key":"ssh-ed25519 ${blob} basecamp"}`)).toEqual([fp])

    const declared = declaredFor({ sshPort: 22, apps: [], sshKeyData: `ssh-ed25519 ${blob} basecamp` })
    const keys = (fingerprints: string[]) => Object.fromEntries(gradePosture(
      { ...CLEAN, ssh_keys: fingerprints.map(f => ({ user: 'root', fingerprint: f })) },
      declared, { at: NOW, now: NOW }).map(c => [c.id, c]))['ssh.unknown-key']
    expect(keys([fp]).ok).toBe(true)
    expect(keys([fp, 'SHA256:somebody-else']).ok).toBe(false)
  })

  test('a move is passing to failing, or back; unknown on either side is none', () => {
    const before = grade(CLEAN)
    const after  = grade({ ...CLEAN, ssh: { ...CLEAN.ssh!, password_authentication: 'yes' } })
    expect(postureChanges(before, after).failed.map(c => c.id)).toEqual(['ssh.password-off'])
    expect(postureChanges(after, before).restored.map(c => c.id)).toEqual(['ssh.password-off'])
    expect(postureChanges(grade({ ...CLEAN, ssh: null }), after).failed.map(c => c.id)).toEqual([])
  })
})

// ─── the service ────────────────────────────────────────────────────────────

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const CERT       = ensureCert(mkdtempSync(join(tmpdir(), 'basecamp-posture-cert-'))).cert

let env: any, ws: any, owner: any, machine: any, SECRET: string

beforeAll(async () => {
  env = await createTestEnv({
    schema: SCHEMA, migrations: MIGRATIONS, encryptionKey: '0'.repeat(64),
    plugins: [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path }),
  })
  const sys  = env.system
  const uniq = () => Math.random().toString(36).slice(2, 8)
  const acct = await sys.account.create({ data: { slug: `acme-${uniq()}`, displayName: 'Acme' } })
  const o    = await sys.user.create({ data: { email: `owner-${uniq()}@x.co`, accountId: acct.id } })
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}`, ownerId: o.id } })
  await sys.workspaceMember.create({ data: {
    workspaceId: ws.id, userId: o.id, role: 'owner', capabilities: grantsFor('owner'), acceptedAt: new Date().toISOString(),
  } })
  owner   = session({ id: o.id, workspaceId: ws.id })
  machine = await sys.server.create({ data: { workspaceId: ws.id, name: 'drifted-01', slug: `d-${uniq()}`, status: 'pending' } })
  await sys.server.create({ data: { workspaceId: ws.id, name: 'quiet-02',   slug: `q-${uniq()}`, status: 'pending' } })

  const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
  const token = mintEnrollToken().token
  await sys.server.update({ where: { id: machine.id },
    data: { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) } })
  SECRET = (await env.http.post(`/servers/${machine.id}/enroll`).send({ token, cert: CERT })).body.secret
}, 120_000)

afterAll(async () => { await env?.close() })

async function report(readings: PostureReadings, at = new Date().toISOString()) {
  const body = { server_id: machine.id, at, readings }
  const req  = env.http.post('/posture').set('x-service-method', 'report')
  const head = await signRequest({
    secret: SECRET, method: 'POST', path: '/posture', serviceMethod: 'report', body: JSON.stringify(body),
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  for (const [k, v] of Object.entries(head)) req.set(k, v)
  return req.send(body)
}

describe('a report lands', () => {
  test('unsigned is refused', async () => {
    const res = await env.http.post('/posture').set('x-service-method', 'report').send({ server_id: machine.id, readings: CLEAN })
    expect(res.status).toBe(401)
  })

  test('a drifted box is a row, a ServerEvent per failing control, and tops the fleet', async () => {
    const drifted = { ...CLEAN, ssh: { ...CLEAN.ssh!, password_authentication: 'yes' }, firewall: { input_policy: 'accept', forward_drop: true, exposed: [] } }
    const res = await report(drifted)
    expect(res.status).toBe(200)
    expect(res.body.failed).toEqual(expect.arrayContaining(['ssh.password-off', 'net.firewall-default-deny']))

    const rows = await env.system.serverPosture.findMany({ where: { serverId: machine.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].failing).toBeGreaterThanOrEqual(2)

    const events = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'posture_failed' } })
    expect(events.map((e: any) => e.metadata.control)).toEqual(expect.arrayContaining(['ssh.password-off', 'net.firewall-default-deny']))

    const fleet = await env.as(owner).service('posture').call('fleet', undefined, {})
    expect(fleet.servers.map((s: any) => s.serverName)).toEqual(['drifted-01', 'quiet-02'])
    expect(fleet.servers[1].reported).toBe(false)
    expect(fleet.dependencies.vulnerable).toBe(0)
  })

  test('fixing it writes posture_restored, and the same failure twice writes no second event', async () => {
    await report({ ...CLEAN, firewall: { input_policy: 'accept', forward_drop: true, exposed: [] } })
    const restored = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'posture_restored' } })
    expect(restored.map((e: any) => e.metadata.control)).toEqual(['ssh.password-off'])
    const failed = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'posture_failed' } })
    expect(failed.filter((e: any) => e.metadata.control === 'net.firewall-default-deny')).toHaveLength(1)
  })

  test('the newest report reads stale once it is old, never clean', async () => {
    await report(CLEAN, new Date(Date.now() - 3 * POSTURE_INTERVAL_MS).toISOString())
    // Ordered by when the box read itself, so a late, old report is not "latest".
    const latest = await env.as(owner).service('posture').call('latest', machine.id, {})
    expect(latest.stale).toBe(false)

    const lone = await env.system.server.create({ data: { workspaceId: ws.id, name: 'lone', slug: `l-${Date.now()}`, status: 'pending' } })
    await env.system.serverPosture.create({ data: {
      serverId: lone.id, at: new Date(Date.now() - 3 * POSTURE_INTERVAL_MS).toISOString(),
      controls: grade(CLEAN), failing: 0, unknown: 1,
    } })
    const stale = await env.as(owner).service('posture').call('latest', lone.id, {})
    expect(stale.stale).toBe(true)
    // The replica control is read off the heartbeat, which an old report does not age.
    const [replica, reported] = [stale.controls.filter((c: any) => c.id === 'backup.replica-lag'),
                                 stale.controls.filter((c: any) => c.id !== 'backup.replica-lag')]
    expect(reported.every((c: any) => c.ok === 'unknown')).toBe(true)
    expect(replica.map((c: any) => c.ok)).toEqual([true])
  })

  test('retention keeps each machine\'s newest however old', async () => {
    const lone = await env.system.server.create({ data: { workspaceId: ws.id, name: 'old', slug: `o-${Date.now()}`, status: 'pending' } })
    for (const daysAgo of [90, 60])
      await env.system.serverPosture.create({ data: { serverId: lone.id, at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() } })
    await prunePosture(env.system)
    const left = await env.system.serverPosture.findMany({ where: { serverId: lone.id } })
    expect(left).toHaveLength(1)
  })
})

// ─── the box a Basecamp runs on (FJS-2714) ─────────────────────────────────

describe('the replica grader', () => {
  const APPS  = [{ id: 'a1', slug: 'shop' }, { id: 'a2', slug: 'blog' }]
  const ago   = (ms: number) => new Date(NOW - ms).toISOString()
  const read  = (apps: any[], extra: object = {}) => ({ apps, checked_at: ago(10_000), ...extra })
  const synced = (id: string, ms: number | null) => ({ app_id: id, status: 'replicating', last_sync_at: ms === null ? null : ago(ms), databases: 1 })

  test('every app a few seconds behind passes; nothing to replicate passes', () => {
    expect(gradeReplication(read([synced('a1', 2_000), synced('a2', 4_000)]), APPS, NOW).ok).toBe(true)
    expect(gradeReplication(null, [], NOW).ok).toBe(true)
  })

  test('a stalled bucket, a never-synced app and a missing app each fail by name', () => {
    const c = gradeReplication(read([synced('a1', 10 * 60_000), synced('a2', null)]), APPS, NOW)
    expect(c.ok).toBe(false)
    expect(c.message).toContain('shop is 10 min behind')
    expect(c.message).toContain('blog has never synced')
    expect(gradeReplication(read([synced('a1', 1_000)]), APPS, NOW).message).toContain('blog is not replicating here')
  })

  test('Litestream not answering fails; no reading, or an old one, is unknown', () => {
    expect(gradeReplication({ error: 'Litestream is not running', checked_at: ago(1_000) }, APPS, NOW).ok).toBe(false)
    expect(gradeReplication(null, APPS, NOW).ok).toBe('unknown')
    expect(gradeReplication(read([synced('a1', 1_000), synced('a2', 1_000)], { checked_at: ago(20 * 60_000) }), APPS, NOW).ok).toBe('unknown')
  })

  test('on Basecamp\'s box its own database is graded beside the apps', () => {
    const host = (ms: number | null) => ({ host: { status: 'replicating', last_sync_at: ms === null ? null : ago(ms), databases: 2 } })
    const ok = gradeReplication(read([], host(3_000)), [], NOW, true)
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining('Basecamp\'s own database replicating') })
    expect(gradeReplication(read([], host(9 * 60_000)), [], NOW, true).message).toContain('Basecamp\'s own database is 9 min behind')
    expect(gradeReplication(read([synced('a1', 1_000)]), [APPS[0]], NOW, true).message).toContain('OUTPOST_HOST_DB_PATH')
    // A machine not asked to replicate it ignores a reading of it.
    expect(gradeReplication(read([], host(9 * 60_000)), [], NOW).ok).toBe(true)
  })
})

describe('the hub grader', () => {
  const FILES = { db: { path: '/srv/basecamp/db', mode: '700', owner: 'root', group: 'root' },
                  env: { path: '/srv/basecamp/.env', mode: '600', owner: 'root', group: 'root' } }
  const KEY  = 'a'.repeat(64)
  const INSTALL = { production: true, appUrl: 'https://hub.test', apiUrl: 'https://api.hub.test',
                    mailer: 'https://api.resend.com', mailFrom: 'ops@hub.test' }
  const hub  = (r: PostureReadings | null, lastBackupAt: string | null, at: number = NOW, host: Partial<HostDeclared> = {}) =>
    Object.fromEntries(gradeHub(r, { lastBackupAt, keyFingerprint: KEY, keyEscrow: null, install: INSTALL, ...host }, { at, now: NOW }).map(c => [c.id, c]))

  test('the URLs and the mailer are graded from the env, report or none', () => {
    const grade = (install: Partial<HostDeclared['install']>) => hub(null, null, NOW, { install: { ...INSTALL, ...install } })
    expect([grade({})['hub.app-url'].ok, grade({})['hub.api-url'].ok, grade({})['hub.mailer'].ok]).toEqual([true, true, true])
    // The localhost defaults are right in development and wrong in production.
    const local = { appUrl: 'http://localhost:8020', apiUrl: 'http://localhost:8120' }
    expect([grade(local)['hub.app-url'].ok, grade(local)['hub.api-url'].ok]).toEqual([false, false])
    expect([grade({ ...local, production: false })['hub.app-url'].ok, grade({ ...local, production: false })['hub.api-url'].ok]).toEqual([true, true])
    // Enrollment refuses plain http off loopback in any environment.
    expect(grade({ production: false, apiUrl: 'http://hub.lan:8120' })['hub.api-url'].ok).toBe(false)
    expect(grade({ mailer: null })['hub.mailer']).toMatchObject({ ok: false, message: expect.stringContaining('No mailer') })
    expect(grade({ mailFrom: 'basecamp@localhost' })['hub.mailer']).toMatchObject({ ok: false, message: expect.stringContaining('MAIL_FROM') })
  })

  test('no backup ever is failing, and a recent one passes', () => {
    expect(hub({ ...CLEAN, host_files: FILES }, null)['hub.backup-recent'].ok).toBe(false)
    expect(hub({ ...CLEAN, host_files: FILES }, new Date(NOW - 3_600_000).toISOString())['hub.backup-recent'].ok).toBe(true)
    expect(hub({ ...CLEAN, host_files: FILES }, new Date(NOW - 5 * 86_400_000).toISOString())['hub.backup-recent'].ok).toBe(false)
  })

  test('a world-readable database or env file fails; an unread one is unknown', () => {
    const c = hub({ ...CLEAN, host_files: { db: { ...FILES.db, mode: '755' }, env: { ...FILES.env, mode: '644' } } }, null)
    expect([c['hub.db-mode'].ok, c['hub.env-mode'].ok]).toEqual([false, false])
    expect(hub({ ...CLEAN, host_files: FILES }, null)['hub.env-mode'].ok).toBe(true)
    expect(hub({ ...CLEAN, host_files: { db: null, env: FILES.env } }, null)['hub.db-mode'].ok).toBe('unknown')
  })

  test('a key file in the secrets directory is graded beside the env file, the worse one answering', () => {
    const key  = { path: '/srv/basecamp/secrets/ENCRYPTION_KEY', mode: '400', owner: '1000', group: '1000' }
    const mode = (env: string, k: string) =>
      hub({ ...CLEAN, host_files: { ...FILES, env: { ...FILES.env, mode: env }, key: { ...key, mode: k } } }, null)['hub.env-mode']
    expect(mode('600', '400').ok).toBe(true)
    expect(mode('600', '444')).toMatchObject({ ok: false, message: expect.stringContaining('secrets/ENCRYPTION_KEY') })
    expect(mode('644', '400')).toMatchObject({ ok: false, message: expect.stringContaining('/srv/basecamp/.env') })
    expect(hub({ ...CLEAN, host_files: { ...FILES, key: null } }, null)['hub.env-mode'].ok).toBe(true)
  })

  test('the backup and the key are graded with no report or a stale one; the files are unknown', () => {
    const none  = hub(null, null)
    expect(none['hub.backup-recent'].ok).toBe(false)
    expect(none['hub.key-escrowed'].ok).toBe(false)
    expect(none['hub.env-mode'].ok).toBe('unknown')
    const stale = hub({ ...CLEAN, host_files: FILES }, null, NOW - 3 * POSTURE_INTERVAL_MS)
    expect(stale['hub.backup-recent'].ok).toBe(false)
    expect(stale['hub.key-escrowed'].ok).toBe(false)
    expect(stale['hub.db-mode'].ok).toBe('unknown')
  })

  test('the key is escrowed when the attestation names the key in use, and not before, after a change, or on the placeholder', () => {
    const at = '2026-10-23T10:00:00.000Z'
    const grade = (host: Partial<HostDeclared>) => hub({ ...CLEAN, host_files: FILES }, null, NOW, host)['hub.key-escrowed']
    expect(grade({})).toMatchObject({ ok: false, message: expect.stringContaining('unreadable without it') })
    expect(grade({ keyEscrow: { at, fingerprint: KEY } })).toMatchObject({ ok: true, message: expect.stringContaining('2026-10-23') })
    expect(grade({ keyEscrow: { at, fingerprint: 'b'.repeat(64) } })).toMatchObject({ ok: false, message: expect.stringContaining('key changed') })
    // The message names keys by a prefix of the digest, never the digest whole.
    expect(grade({ keyEscrow: { at, fingerprint: KEY } }).message).not.toContain(KEY)
    expect(grade({ keyFingerprint: null, keyEscrow: { at, fingerprint: KEY } })).toMatchObject({ ok: false, message: expect.stringContaining('placeholder') })
  })

  test('only the hub controls: the fleet ones are the host row\'s own', () => {
    expect(Object.keys(hub(CLEAN, null)).sort()).toEqual([...HUB_CONTROL_IDS].sort())
  })
})

describe('the host row on /hub/security/', () => {
  let admin: any

  beforeAll(async () => {
    const sys = env.system
    const a   = await sys.user.create({ data: { email: `hub-${Date.now()}@x.co`, accountId: (await sys.account.findFirst({})).id } })
    await sys.user.update({ where: { id: a.id }, data: { isSystemAdmin: true } })
    admin = session({ id: a.id, isSystemAdmin: true })
  })

  test('with no host row nothing reads the box, and only the backup is graded', async () => {
    const view = await env.as(admin).service('posture').call('host', undefined, {})
    const c    = Object.fromEntries(view.controls.map((x: any) => [x.id, x]))
    expect([view.enrolled, view.reported]).toEqual([false, false])
    expect(c['hub.backup-recent'].ok).toBe(false)
    expect(c['hub.key-escrowed']).toMatchObject({ ok: false, message: expect.stringContaining('No copy of ENCRYPTION_KEY') })
    expect(c['hub.db-mode'].ok).toBe('unknown')
  })

  test('the host row\'s own report carries the hub controls beside its fleet grade, for the hub alone', async () => {
    // A slug is set once, so the host is a machine enrolled under that slug and
    // not the fixture renamed.
    const drifted = { machine, SECRET }
    machine = await env.system.server.create({ data: { workspaceId: ws.id, name: 'hub-host', slug: HOST_SLUG, status: 'pending' } })
    // The slug is any administrator's to choose, so it names nothing until the hub points at the row.
    expect((await env.as(admin).service('posture').call('host', undefined, {})).enrolled).toBe(false)
    const sys = env.system as any
    if (!await sys.hubConfig.exists({ where: { id: 'hub' } }))
      await sys.hubConfig.create({ data: { id: 'hub' } })
    await sys.hubConfig.update({ where: { id: 'hub' }, data: { hostServerId: machine.id } })
    const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
    const token = mintEnrollToken().token
    await env.system.server.update({ where: { id: machine.id },
      data: { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) } })
    SECRET = (await env.http.post(`/servers/${machine.id}/enroll`).send({ token, cert: CERT })).body.secret
    const files = { db: { path: '/srv/db', mode: '700', owner: 'root', group: 'root' },
                    env: { path: '/srv/.env', mode: '644', owner: 'root', group: 'root' } }
    expect((await report({ ...CLEAN, host_files: files })).status).toBe(200)

    const view = await env.as(admin).service('posture').call('host', undefined, {})
    const c    = Object.fromEntries(view.controls.map((x: any) => [x.id, x]))
    expect([view.enrolled, view.reported, view.serverId]).toEqual([true, true, machine.id])
    expect(c['hub.backup-recent'].ok).toBe(false)
    expect(c['hub.env-mode'].ok).toBe(false)
    expect(c['hub.db-mode'].ok).toBe(true)
    expect(c['ssh.password-off'].ok).toBe(true)

    // A workspace owner reaches the row through `latest`, never the hub's view.
    expect((await env.as(owner).service('posture').call('host', undefined, {}).catch((e: any) => e)).code ?? 404).toBe(404)
    await sys.hubConfig.update({ where: { id: 'hub' }, data: { hostServerId: null } })
    ;({ machine, SECRET } = drifted)
  })

  test('a report naming no machine is refused, whatever signs it', async () => {
    const body = { readings: CLEAN }
    const req  = env.http.post('/posture').set('x-service-method', 'report')
    const head = await signRequest({
      secret: SECRET, method: 'POST', path: '/posture', serviceMethod: 'report', body: JSON.stringify(body),
      timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
    })
    for (const [k, v] of Object.entries(head)) req.set(k, v)
    expect((await req.send(body)).status).toBe(401)
  })
})

// ─── Component advisories (Phase 7) ──────────────────────────────────────────
// The range strings are moby's and Bun's own, as GitHub serves them. The table's
// names are proved against the live sources by verify-advisories.mjs.

describe('component advisories', () => {
  const advisory = (ghsa_id: string, rows: [string, string, string][]) => ({
    ghsa_id, state: 'published', withdrawn_at: null,
    vulnerabilities: rows.map(([name, vulnerable_version_range, patched_versions]) =>
      ({ package: { name }, vulnerable_version_range, patched_versions })),
  })
  const docker = componentById('docker')!.source as any
  const bun    = componentById('bun')!.source as any
  const ids    = (src: any, list: any[], v: string) => matchGithub(src, list, v).ids

  test('a version is read out of each component\'s own output', () => {
    expect(versionOf('v2.8.4 h1:abc=')).toBe('2.8.4')
    expect(versionOf('v0.3.13')).toBe('0.3.13')
    expect(versionOf('1.7.27')).toBe('1.7.27')
    expect(versionOf('')).toBe(null)
    expect(versionOf(null)).toBe(null)
  })

  test('comma is AND for a lower bound then an upper one, OR otherwise', () => {
    expect(rangeOf('>= 1.3.14, < 1.4.4')).toBe('>= 1.3.14 < 1.4.4')
    expect(rangeOf('<= 25.0.18, 26.0.0 - 29.8.1')).toBe('<= 25.0.18 || 26.0.0 - 29.8.1')
    expect(rangeOf('28.2.x, 28.3.0')).toBe('28.2.x || 28.3.0')
    expect(rangeOf('N/A')).toBe(null)
  })

  test('a list of upper bounds applies the one on the version\'s own line', () => {
    const list = [advisory('GHSA-v23v-6jw2-98fq', [['docker-ce', '<= v24.0.9, <= v25.0.5, <= v26.0.2', '> v26.1.4']])]
    expect(ids(docker, list, '25.0.4')).toEqual(['GHSA-v23v-6jw2-98fq'])
    expect(ids(docker, list, '25.0.19')).toEqual([])
  })

  test('a range that never closes is fixed by a patched release on the line, or above them all', () => {
    const list = [advisory('GHSA-6wrf-mxfj-pf5p', [['github.com/docker/docker', '>= 1.12', '>= 23.0.3, >= 20.10.24']])]
    expect(ids(docker, list, '20.10.20')).toEqual(['GHSA-6wrf-mxfj-pf5p'])
    expect(ids(docker, list, '20.10.25')).toEqual([])
    expect(ids(docker, list, '29.8.0')).toEqual([])
  })

  test('an Engine row outranks the frozen Go module, which would never read as fixed', () => {
    const list = [advisory('GHSA-rg2x-37c3-w2rh', [
      ['Docker Engine', '< 29.5.1', '29.5.1'],
      ['github.com/docker/docker/daemon', '<= v28.5.2', 'None'],
    ])]
    expect(ids(docker, list, '29.2.0')).toEqual(['GHSA-rg2x-37c3-w2rh'])
    expect(ids(docker, list, '29.8.0')).toEqual([])
  })

  test('an advisory about something else is skipped; an unreadable or relabeled runtime row is unread, never clean', () => {
    const docs = [advisory('GHSA-vwm3-crmr-xfxw', [['docs.docker.com', 'N/A', '']])]
    expect(matchGithub(docker, docs, '29.8.0')).toEqual({ ids: [], unread: [] })
    const renamed = [advisory('GHSA-yyyy-yyyy-yyyy', [['Moby Engine', '< 30.0.0', '30.0.0']])]
    expect(matchGithub(docker, renamed, '29.8.0')).toEqual({ ids: [], unread: ['GHSA-yyyy-yyyy-yyyy'] })
    const bad = [advisory('GHSA-zzzz-zzzz-zzzz', [['bun', 'all of them', '']])]
    expect(matchGithub(bun, bad, '1.4.0')).toEqual({ ids: [], unread: ['GHSA-zzzz-zzzz-zzzz'] })
  })

  test('a withdrawn advisory affects nothing', () => {
    const list = [{ ...advisory('GHSA-663w-cv8g-jj2p', [['bun', '< 1.4.4', '1.4.4']]), withdrawn_at: '2026-10-01T00:00:00Z' }]
    expect(ids(bun, list, '1.4.0')).toEqual([])
  })
})
