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
import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'
import { GatePlugin }  from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp }  from '../src/app.ts'
import { grantsFor }         from '../src/core/capabilities.ts'
import { declaredFor, gradeHub, gradePosture, gradeReplication, HUB_CONTROL_IDS, lastKnownControls, postureChanges, publicKeyFingerprints, POSTURE_INTERVAL_MS } from '../src/domain/host/posture.ts'
import { HOST_SLUG, hubApp, placeHub } from '../src/domain/host/host-machine.ts'
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
  unneeded:     { active: [] },
  outpost_unit: { exposure: 4.2, predicate: 'OK' },
  privileged:   [{ name: '/fjs-web', privileged: false, docker_sock: false }],
  files:        [],
  cert:         { expires_at: '2027-10-01T00:00:00Z' },
}

const DECLARED = declaredFor({ sshPort: 22, apps: [{ kind: 'container', port: 8090, hasExposedPort: false }], sshKeyData: null,
  expectedOutpostVersion: '0.1.9', outpostVersion: '0.1.9' })
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

  test('multipathd or fwupd running fails host.unneeded-services by name, with the commands that fix it', () => {
    expect(byId(CLEAN)['host.unneeded-services'].ok).toBe(true)
    const c = byId({ ...CLEAN, unneeded: { active: ['fwupd.service', 'fwupd-refresh.timer'] } })['host.unneeded-services']
    expect(c.ok).toBe(false)
    expect(c.severity).toBe('low')
    expect(c.message).toContain('fwupd.service, fwupd-refresh.timer')
    expect(grade({ ...CLEAN, unneeded: { active: ['multipathd.socket'] } }).find(x => x.id === 'host.unneeded-services')?.fix)
      .toContain('systemctl mask --now fwupd.service fwupd-refresh.timer')
    expect(byId({ ...CLEAN, unneeded: null })['host.unneeded-services'].ok).toBe('unknown')
  })

  test('a reading the box could not take is unknown, never passing', () => {
    const c = byId({ ...CLEAN, ssh: null, firewall: null, listening: null })
    expect(c['ssh.password-off'].ok).toBe('unknown')
    expect(c['net.firewall-default-deny'].ok).toBe('unknown')
    expect(c['net.unexpected-listener'].ok).toBe('unknown')
    expect(c['net.caddy-admin-loopback'].ok).toBe('unknown')
  })

  test('an Outpost behind the version this Basecamp installs fails, naming both, with Re-enroll as the fix', () => {
    const at = (running: string | null) => gradePosture(CLEAN,
      declaredFor({ sshPort: 22, apps: [], expectedOutpostVersion: '0.1.9', outpostVersion: running }), { at: NOW, now: NOW })
      .find(c => c.id === 'outpost.version-behind')!
    const behind = at('0.1.8')
    expect(behind.ok).toBe(false)
    expect(behind.message).toContain('0.1.8')
    expect(behind.message).toContain('0.1.9')
    expect(behind.fix).toContain('Re-enroll this machine')
    expect(at('0.1.9').ok).toBe(true)
    expect(at('0.2.0').ok).toBe(true)
    expect(at(null).ok).toBe('unknown')
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

    const declared = declaredFor({ sshPort: 22, apps: [{ kind: 'container', port: 9000, hasExposedPort: true }] })
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

  test('an OpenSSH private key names its public half; a PEM key or none named grades unknown with a fix', () => {
    const str  = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b])
    const pub  = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(Buffer.alloc(32, 9))])
    const fp   = 'SHA256:' + createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')
    // The header stays unencrypted under a passphrase, so an aes256-ctr key names it too.
    const key  = Buffer.concat([Buffer.from('openssh-key-v1\0'), str(Buffer.from('aes256-ctr')), str(Buffer.from('bcrypt')),
      str(Buffer.alloc(24)), Buffer.from([0, 0, 0, 1]), str(pub), str(Buffer.alloc(64, 1))]).toString('base64')
    const pem  = (body: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
    expect(publicKeyFingerprints(pem(key))).toEqual([fp])
    expect(publicKeyFingerprints(JSON.stringify(pem(key)))).toEqual([fp])
    expect(publicKeyFingerprints(pem(key.slice(0, 40)))).toBeNull()

    const grade = (sshKeyData: string | null) => Object.fromEntries(gradePosture({ ...CLEAN, ssh_keys: [{ user: 'root', fingerprint: fp }] },
      declaredFor({ sshPort: 22, apps: [], sshKeyData }), { at: NOW, now: NOW }).map(c => [c.id, c]))['ssh.unknown-key']
    expect(grade(pem(key)).ok).toBe(true)
    expect(grade(null)).toMatchObject({ ok: 'unknown', fix: expect.stringContaining('pick its SSH key') })
    expect(grade('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toMatchObject({ ok: 'unknown', fix: expect.stringContaining('OpenSSH format') })
  })

  test('every failing machine control says what to do about it', () => {
    const failing = gradePosture({ ...CLEAN, ssh: { ...CLEAN.ssh!, password_authentication: 'yes' } }, DECLARED, { at: NOW, now: NOW })
      .find(c => c.id === 'ssh.password-off')!
    expect(failing.fix).toContain('PasswordAuthentication no')
    expect(gradePosture(CLEAN, DECLARED, { at: NOW, now: NOW }).filter(c => c.ok === true && c.fix)).toEqual([])
  })

  test('a move is passing to failing, or back; unknown on either side is none', () => {
    const before = grade(CLEAN)
    const after  = grade({ ...CLEAN, ssh: { ...CLEAN.ssh!, password_authentication: 'yes' } })
    expect(postureChanges(before, after).failed.map(c => c.id)).toEqual(['ssh.password-off'])
    expect(postureChanges(after, before).restored.map(c => c.id)).toEqual(['ssh.password-off'])
    expect(postureChanges(grade({ ...CLEAN, ssh: null }), after).failed.map(c => c.id)).toEqual([])
  })

  test('passing, then unknown, then failing is still a failure (FJS-3876)', () => {
    const passing = grade(CLEAN)
    const unknown = grade({ ...CLEAN, ssh: null })
    const failing = grade({ ...CLEAN, ssh: { ...CLEAN.ssh!, password_authentication: 'yes' } })
    // Newest first, the way the service reads them.
    const prior = lastKnownControls([unknown, passing])
    expect(postureChanges(prior, failing).failed.map(c => c.id)).toEqual(['ssh.password-off'])
    // The pair: passing, unknown, passing is no move at all.
    expect(postureChanges(lastKnownControls([unknown, passing]), passing).failed).toEqual([])
  })
})

// ─── the service ────────────────────────────────────────────────────────────

const SCHEMA     = join(import.meta.dir, '..', '..', 'db', 'schema.lite')
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations')
const CERT       = ensureCert(mkdtempSync(join(tmpdir(), 'basecamp-posture-cert-'))).cert

let env: any, ws: any, owner: any, machine: any, KEY: string

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
  ws = await sys.workspace.create({ data: { accountId: acct.id, name: 'Fleet', slug: `fleet-${uniq()}` } })
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
  const keys = await generateSigningKeys()
  await env.http.post(`/servers/${machine.id}/enroll`).send({ token, cert: CERT, publicKey: keys.publicKey })
  KEY = keys.privateKey
}, 120_000)

afterAll(async () => { await env?.close() })

async function report(readings: PostureReadings, at = new Date().toISOString()) {
  const body = { server_id: machine.id, at, readings }
  const req  = env.http.post('/serverPostures').set('x-service-method', 'report')
  const head = await signRequest({
    privateKey: KEY, method: 'POST', path: '/serverPostures', serviceMethod: 'report', body: JSON.stringify(body),
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  for (const [k, v] of Object.entries(head)) req.set(k, v)
  return req.send(body)
}

describe('a report lands', () => {
  test('unsigned is refused', async () => {
    const res = await env.http.post('/serverPostures').set('x-service-method', 'report').send({ server_id: machine.id, readings: CLEAN })
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

    const events = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'postureFailed' } })
    expect(events.map((e: any) => e.metadata.control)).toEqual(expect.arrayContaining(['ssh.password-off', 'net.firewall-default-deny']))

    const fleet = await env.as(owner).service('serverPostures').call('fleet', undefined, {})
    expect(fleet.servers.map((s: any) => s.serverName)).toEqual(['drifted-01', 'quiet-02'])
    expect(fleet.servers[1].reported).toBe(false)
    expect(fleet.dependencies.vulnerable).toBe(0)
  })

  test('fixing it writes postureRestored, and the same failure twice writes no second event', async () => {
    await report({ ...CLEAN, firewall: { input_policy: 'accept', forward_drop: true, exposed: [] } })
    const restored = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'postureRestored' } })
    expect(restored.map((e: any) => e.metadata.control)).toEqual(['ssh.password-off'])
    const failed = await env.system.serverEvent.findMany({ where: { serverId: machine.id, kind: 'postureFailed' } })
    expect(failed.filter((e: any) => e.metadata.control === 'net.firewall-default-deny')).toHaveLength(1)
  })

  test('the newest report reads stale once it is old, never clean', async () => {
    await report(CLEAN, new Date(Date.now() - 3 * POSTURE_INTERVAL_MS).toISOString())
    // Ordered by when the box read itself, so a late, old report is not "latest".
    const latest = await env.as(owner).service('serverPostures').call('latest', machine.id, {})
    expect(latest.stale).toBe(false)

    const lone = await env.system.server.create({ data: { workspaceId: ws.id, name: 'lone', slug: `l-${Date.now()}`, status: 'pending' } })
    await env.system.serverPosture.create({ data: {
      serverId: lone.id, at: new Date(Date.now() - 3 * POSTURE_INTERVAL_MS).toISOString(),
      controls: grade(CLEAN), failing: 0, unknown: 1,
    } })
    const stale = await env.as(owner).service('serverPostures').call('latest', lone.id, {})
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
  const DISK = { path: '/srv/basecamp', freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, dbBytes: 1024 ** 3 }
  const INSTALL = { production: true, appUrl: 'https://hub.test', apiUrl: 'https://api.hub.test',
                    mailer: 'https://api.resend.com', mailFrom: 'ops@hub.test',
                    push: { rung: 3 as const, url: 'https://ntfy.sh' } }
  const hub  = (r: PostureReadings | null, lastBackupAt: string | null, at: number = NOW, host: Partial<HostDeclared> = {}) =>
    Object.fromEntries(gradeHub(r, { lastBackupAt, scheduledApps: [], keyFingerprint: KEY, keyEscrow: null, hubApp: null, dbDisk: DISK, install: INSTALL, ...host }, { at, now: NOW }).map(c => [c.id, c]))

  test('hub.disk-free is unknown when the disk cannot be read, fails under twice the database or a tenth of the volume, and passes with room', () => {
    const GB    = 1024 ** 3
    const grade = (dbDisk: HostDeclared['dbDisk']) => hub(null, null, NOW, { dbDisk })['hub.disk-free']
    expect(grade(null).ok).toBe('unknown')
    expect(grade({ ...DISK, freeBytes: 1.5 * GB })).toMatchObject({ ok: false, fix: expect.any(String), message: expect.stringContaining('/srv/basecamp') })
    expect(grade({ ...DISK, freeBytes: 8 * GB, dbBytes: 1000 }).ok).toBe(false)
    expect(grade(DISK)).toMatchObject({ ok: true, message: expect.stringContaining('50.0 GB free') })
    // In process: a stale or absent report does not hide it.
    expect(hub(null, null, NOW - 9 * 86_400_000, { dbDisk: { ...DISK, freeBytes: GB } })['hub.disk-free'].ok).toBe(false)
  })

  test('app.backup-recent fails an app whose scheduled run has not finished inside its schedule', () => {
    const day = 86_400_000
    const scheduledApps = (lastOkAt: string | null, maxAgeDays = 2) => [{ name: 'shop', what: 'backup' as const, maxAgeDays, lastOkAt }]
    const grade = (apps: ReturnType<typeof scheduledApps>) => hub(null, null, NOW, { scheduledApps: apps })['app.backup-recent']
    expect(grade([]).ok).toBe(true)
    expect(grade(scheduledApps(new Date(NOW - day).toISOString())).ok).toBe(true)
    expect(grade(scheduledApps(new Date(NOW - 5 * day).toISOString()))).toMatchObject({ ok: false, message: expect.stringContaining('shop backup') })
    expect(grade(scheduledApps(null)).ok).toBe(false)
    // A weekly schedule is not late at five days.
    expect(grade(scheduledApps(new Date(NOW - 5 * day).toISOString(), 14)).ok).toBe(true)
  })

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
    // A failing control says what to do; a passing one carries nothing to do.
    expect(grade({ mailer: null })['hub.mailer'].fix).toContain('RESEND_API_KEY')
    expect(grade({})['hub.mailer'].fix).toBeUndefined()
    // The push row names the rung; only a self-hosted ntfy with no iOS relay fails.
    expect(grade({})['hub.push']).toMatchObject({ ok: true, message: expect.stringContaining('ntfy.sh (public server') })
    expect(grade({ push: { rung: 1, url: 'https://ntfy.acme.com' } })['hub.push'].message).toContain('your ntfy at https://ntfy.acme.com')
    expect(grade({ push: { rung: 2, url: 'https://push.hub.test', relay: 'https://ntfy.sh' } })['hub.push'].ok).toBe(true)
    expect(grade({ push: { rung: 2, url: 'https://push.hub.test', relay: null } })['hub.push']).toMatchObject({ ok: false, fix: expect.stringContaining('iOS relay') })
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

  test('the bucket is locked when its test read a compliance lock, or a person attested one the bucket could not say (FJS-3913)', () => {
    const grade = (bucketLock: HostDeclared['bucketLock']) => hub(null, null, NOW, { bucketLock })['hub.bucket-locked']
    const lock  = { name: 'B2', tested: true, lockDays: null, attestedAt: null }
    expect(grade(null).ok).toBe('unknown')
    expect(grade({ ...lock, tested: false }).ok).toBe('unknown')
    expect(grade({ ...lock, lockDays: 30 })).toMatchObject({ ok: true, message: expect.stringContaining('30 day(s)') })
    expect(grade({ ...lock, lockDays: 0 })).toMatchObject({ ok: false, fix: expect.stringContaining('Object Lock'), message: expect.stringContaining('delete every archive') })
    expect(grade(lock)).toMatchObject({ ok: false, message: expect.stringContaining('none is attested') })
    expect(grade({ ...lock, attestedAt: '2026-11-03T00:00:00.000Z' })).toMatchObject({ ok: true, message: expect.stringContaining('2026-11-03') })
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
    const view = await env.as(admin).service('hub').call('hostPosture', undefined, {})
    const c    = Object.fromEntries(view.controls.map((x: any) => [x.id, x]))
    expect([view.enrolled, view.reported]).toEqual([false, false])
    expect(c['hub.backup-recent'].ok).toBe(false)
    expect(c['hub.key-escrowed']).toMatchObject({ ok: false, message: expect.stringContaining('No copy of ENCRYPTION_KEY') })
    expect(c['hub.db-mode'].ok).toBe('unknown')
  })

  test('/hub always has the totals, and the memory table only from a host Server (FJS-D1824)', async () => {
    const { health, runtime } = await env.as(admin).service('hub').call('overview', undefined, {})
    // Read here with Outpost's vitals; the one notion of memory is the card's, not an RSS figure.
    expect(typeof health.memory).toBe('number')
    expect(health.host).toBeNull()
    expect(health.breakdown).toBeNull()
    expect('memoryMb' in runtime).toBe(false)
  })

  test('a failing hub control is sent to the system admins and nobody else', async () => {
    const { notifyHubPosture } = await import('../src/jobs/hub-posture.job.ts')
    // No backup has ever finished in this database, so hub.backup-recent fails.
    // A suspended or unverified account is not paged, so the fixture admin is made a working one.
    const sys = env.system as any
    await sys.user.update({ where: { id: admin.id }, data: { status: 'active' } })
    expect(await notifyHubPosture(env.app, sys)).toBe(1)
    await sys.user.update({ where: { id: admin.id }, data: { isSystemAdmin: false } })
    expect(await notifyHubPosture(env.app, sys)).toBe(0)
    await sys.user.update({ where: { id: admin.id }, data: { isSystemAdmin: true } })
  })

  test('the host row\'s own report carries the hub controls beside its fleet grade, for the hub alone', async () => {
    // A slug is set once, so the host is a machine enrolled under that slug and
    // not the fixture renamed.
    const drifted = { machine, KEY }
    machine = await env.system.server.create({ data: { workspaceId: ws.id, name: 'hub-host', slug: HOST_SLUG, status: 'pending' } })
    // The slug is any administrator's to choose, so it names nothing until the hub points at the row.
    expect((await env.as(admin).service('hub').call('hostPosture', undefined, {})).enrolled).toBe(false)
    const sys = env.system as any
    if (!await sys.hubConfig.exists({ where: { id: 'hub' } }))
      await sys.hubConfig.create({ data: { id: 'hub' } })
    await placeHub(sys, machine)
    const { mintEnrollToken, hashEnrollToken } = await import('../src/providers/compute/enrollment.ts')
    const token = mintEnrollToken().token
    await env.system.server.update({ where: { id: machine.id },
      data: { enrollTokenHash: hashEnrollToken(token), enrollExpiresAt: new Date(Date.now() + 60_000) } })
    const keys = await generateSigningKeys()
    await env.http.post(`/servers/${machine.id}/enroll`).send({ token, cert: CERT, publicKey: keys.publicKey })
    KEY = keys.privateKey
    const files = { db: { path: '/srv/db', mode: '700', owner: 'root', group: 'root' },
                    env: { path: '/srv/.env', mode: '644', owner: 'root', group: 'root' } }
    expect((await report({ ...CLEAN, host_files: files })).status).toBe(200)

    const view = await env.as(admin).service('hub').call('hostPosture', undefined, {})
    const c    = Object.fromEntries(view.controls.map((x: any) => [x.id, x]))
    expect([view.enrolled, view.reported, view.serverId]).toEqual([true, true, machine.id])
    expect(c['hub.backup-recent'].ok).toBe(false)
    expect(c['hub.env-mode'].ok).toBe(false)
    expect(c['hub.db-mode'].ok).toBe(true)
    expect(c['ssh.password-off'].ok).toBe(true)

    // The host Server's heartbeat carries the memory table; /hub names each container by its App.
    const app = await hubApp(sys)
    await sys.server.update({ where: { id: machine.id }, data: { health: { memory_breakdown: {
      total_bytes: 1000, used_bytes: 600,
      rows: [{ group: 'apps', unit: `docker-${'a'.repeat(64)}.scope`, bytes: 400, app_id: app.id },
             { group: 'kernel', unit: null, bytes: 200 }],
    } } } })
    const { health } = await env.as(admin).service('hub').call('overview', undefined, {})
    expect(health.host).toMatchObject({ id: machine.id, name: 'hub-host' })
    expect(health.breakdown).toMatchObject({ totalBytes: 1000, usedBytes: 600, names: { [app.id]: app.name } })
    expect(health.breakdown.rows.map((r: any) => r.group)).toEqual(['apps', 'kernel'])

    // A workspace owner reaches the row through `latest`, never the hub's view.
    expect((await env.as(owner).service('hub').call('hostPosture', undefined, {}).catch((e: any) => e)).code ?? 404).toBe(403)
    await sys.hubConfig.update({ where: { id: 'hub' }, data: { appId: null } })
    ;({ machine, KEY } = drifted)
  })

  // `fli basecamp:posture` reads all three with the BASECAMP_API_KEY `basecamp:key` mints.
  test('an admin key reads the fleet and one machine, and a system admin\'s reads the host', async () => {
    const sys = env.system as any
    await sys.workspaceMember.create({ data: {
      workspaceId: ws.id, userId: admin.id, role: 'admin', capabilities: grantsFor('admin'), acceptedAt: new Date().toISOString(),
    } })
    const keyOf = async (who: any) => (await env.as(who).service('apiKeys').create({
      name: `posture-${Math.random().toString(36).slice(2, 8)}`, scopes: ['admin'], expiresIn: '30d',
    })).token
    const call = (token: string, path: string, method: string) =>
      env.http.post(path).set('Authorization', `Bearer ${token}`).set('x-service-method', method).send({})

    const owners = await keyOf(owner)
    const fleet  = await call(owners, '/serverPostures', 'fleet')
    expect(fleet.status).toBe(200)
    expect(fleet.body.servers.map((s: any) => s.serverName)).toContain('quiet-02')
    expect((await call(owners, `/serverPostures/${machine.id}`, 'latest')).body.serverId).toBe(machine.id)
    expect((await call(owners, '/hub', 'hostPosture')).status).toBe(403)

    const host = await call(await keyOf({ ...admin, workspaceId: ws.id }), '/hub', 'hostPosture')
    expect(host.status).toBe(200)
    expect(host.body.controls.map((c: any) => c.id)).toContain('hub.backup-recent')
  })

  test('a report naming no machine is refused, whatever signs it', async () => {
    const body = { readings: CLEAN }
    const req  = env.http.post('/serverPostures').set('x-service-method', 'report')
    const head = await signRequest({
      privateKey: KEY, method: 'POST', path: '/serverPostures', serviceMethod: 'report', body: JSON.stringify(body),
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
