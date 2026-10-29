/*
 * posture.test.js
 *
 * `inspector.posture()` graded against what a real machine said: the dev-host
 * capture is replayed through an injected runner, so a parser is tested on the
 * output it will meet rather than the output its author pictured. The capture
 * ran as uid 1000, so every reading that needs root comes back refused there —
 * which is the `unknown` path, and the reason those keys are asserted null.
 *
 * A recorded spawn error is THROWN, as Bun.spawn throws on a missing binary,
 * and an argv the capture does not hold is a failure: the command table in
 * `docker.js` and `capture.mjs` move together or the replay says so.
 */

import { test, expect, describe } from 'bun:test'
import { signRequest, generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { createInspector }        from '../src/docker.js'
import { createReporter }         from '../src/report.js'
import { createOutpostServer }    from '../src/server.js'
import { readConfig }             from '../src/config.js'

const FIXTURE = JSON.parse(await Bun.file(new URL('./fixtures/posture/dev-host.json', import.meta.url)).text())

// Basecamp signs every command and this machine every report, each with its
// own pair (FJS-D1604).
const HUB     = await generateSigningKeys()
const MACHINE = await generateSigningKeys()

const CONFIG = {
  serverId: 'srv-1', signingKey: MACHINE.privateKey, hubKey: HUB.publicKey, basecampUrl: 'http://basecamp.test',
  port: 7180, version: '0.1.0', publicUrl: 'https://outpost.test:7180',
  heartbeatMs: 30_000, reportMs: 300_000, postureMs: 21_600_000, workDir: '/tmp/outpost-test',
  caddyAdmin: 'http://127.0.0.1:1',
}

const enoent = (argv) => Object.assign(new Error(`No such file or directory (posix_spawn '${argv[0]}')`), { code: 'ENOENT' })

/** The capture, answered by argv. */
function replay(readings = FIXTURE.readings) {
  const byArgv = new Map(Object.values(readings).filter(Boolean).map(r => [JSON.stringify(r.argv), r]))
  const misses = []
  const run = async (argv) => {
    const r = byArgv.get(JSON.stringify(argv))
    if (!r) { misses.push(argv); throw new Error(`not in the capture: ${argv.join(' ')}`) }
    if (r.spawnError) throw enoent(argv)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  return { run, misses }
}

/** Inline answers keyed by an argv prefix; anything unnamed fails as a
 *  refusal would, so a case states only the reading it is about. */
function canned(answers) {
  return async (argv) => {
    const joined = argv.join(' ')
    const hit = Object.entries(answers).find(([prefix]) => joined.startsWith(prefix))?.[1]
    if (hit === 'ENOENT') throw enoent(argv)
    return { exitCode: 1, stdout: '', stderr: 'refused', ...hit }
  }
}

const postureOf = async (answers) => (await createInspector({ run: canned(answers) }).posture()).readings

// ─── the dev host, replayed ──────────────────────────────────────────────────

describe('the dev-host capture, replayed', () => {
  const { run, misses } = replay()
  const reading = createInspector({ run }).posture()

  test('every command posture runs is one the capture recorded', async () => {
    await reading
    expect(misses).toEqual([])
  })

  test('answers a timestamp and every key, null where unknown', async () => {
    const { at, readings } = await reading
    expect(new Date(at).toISOString()).toBe(at)
    expect(Object.keys(readings).sort()).toEqual([
      'auto_updates', 'cert', 'containers', 'docker_group', 'files', 'firewall', 'kernel', 'listening', 'nopasswd',
      'os', 'outpost_unit', 'privileged', 'reboot', 'ssh', 'ssh_keys', 'time', 'uid0', 'updates', 'versions',
    ])
  })

  test('os and kernel', async () => {
    const { readings } = await reading
    expect(readings.os).toEqual({ id: 'ubuntu', version: '22.04', codename: 'jammy' })
    expect(readings.kernel.running).toBe('6.8.0-138-generic')
    // The capture lists 179 kernel packages; all but these are removed with
    // their config left behind, and reading them as installed is a box that
    // looks a hundred kernels behind.
    expect(readings.kernel.installed).toContain('6.8.0-138-generic')
    expect(readings.kernel.installed.length).toBeLessThan(10)
  })

  test('a reboot is pending, with the packages that asked for it', async () => {
    const { readings } = await reading
    expect(readings.reboot.required).toBe(true)
    expect(new Date(readings.reboot.since).toISOString()).toBe(readings.reboot.since)
    // A 5.15 kernel while 6.8 HWE runs: one that will never boot. Basecamp
    // compares the series; this reports the fact.
    expect(readings.reboot.pkgs).toContain('linux-image-5.15.0-198-generic')
  })

  test('updates and unattended upgrades', async () => {
    const { readings } = await reading
    expect(readings.updates).toEqual({ pending: 18, security: 0 })
    expect(readings.auto_updates.enabled).toBe(true)
    expect(readings.auto_updates.last_run).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  test('versions are each their own unknown — caddy is not on this box', async () => {
    const { readings } = await reading
    expect(readings.versions).toEqual({ docker: '29.8.0', caddy: null, bun: '1.4.2' })
  })

  test('listening sockets, both families', async () => {
    const { readings } = await reading
    expect(readings.listening.length).toBeGreaterThan(10)
    expect(readings.listening).toContainEqual({ address: '0.0.0.0', port: 22, process: null })
    expect(readings.listening).toContainEqual({ address: '::', port: 22, process: null })
    expect(readings.listening).toContainEqual({ address: '::1', port: 631, process: null })
    // ss prints a dual-stack wildcard as `*`.
    expect(readings.listening).toContainEqual({ address: '::', port: 8127, process: 'bun' })
    expect(readings.listening).toContainEqual({ address: '127.0.0.53', port: 53, process: null })
  })

  test('a published container is public on IPv6 as well', async () => {
    const { readings } = await reading
    expect(readings.containers).toEqual([{
      name: 'fjs-12ec1da7-ac83-459d-980d-f95eea84a8d6',
      published: [
        { host_ip: '0.0.0.0', host_port: 8090, container_port: 80, proto: 'tcp' },
        { host_ip: '::',      host_port: 8090, container_port: 80, proto: 'tcp' },
      ],
    }])
    expect(readings.privileged).toEqual([
      { name: 'fjs-12ec1da7-ac83-459d-980d-f95eea84a8d6', privileged: false, docker_sock: false },
    ])
  })

  test('what needs root, or is not on a dev host, is unknown', async () => {
    const { readings } = await reading
    expect(readings.firewall).toBeNull()
    expect(readings.ssh).toBeNull()
    expect(readings.ssh_keys).toBeNull()
    expect(readings.nopasswd).toBeNull()
    expect(readings.outpost_unit).toBeNull()
    expect(readings.files).toBeNull()
    expect(readings.cert).toBeNull()
    expect(readings.uid0).toEqual(['root'])
    // A dev host's own user runs docker without sudo, which is root there.
    expect(readings.docker_group).toEqual(['j'])
  })

  test('time is synced, and the offset is unknown without chrony', async () => {
    const { readings } = await reading
    expect(readings.time).toEqual({ synced: true, offset_s: null })
  })
})

// ─── one reading at a time ───────────────────────────────────────────────────

describe('each reading, from what the command prints', () => {
  test('docker ps Ports: both families, ranges, and exposed-only', async () => {
    const line = (Names, Ports) => JSON.stringify({ Names, Ports })
    const { containers } = await postureOf({
      'docker ps --format': { exitCode: 0, stdout: [
        line('web', '127.0.0.1:8100->3000/tcp'),
        line('dns', '0.0.0.0:5353-5354->53-54/udp, :::5353-5354->53-54/udp'),
        line('worker', '8080/tcp'),
      ].join('\n') + '\n' },
    })
    expect(containers).toEqual([
      { name: 'web', published: [{ host_ip: '127.0.0.1', host_port: 8100, container_port: 3000, proto: 'tcp' }] },
      { name: 'dns', published: [
        { host_ip: '0.0.0.0', host_port: 5353, container_port: 53, proto: 'udp' },
        { host_ip: '0.0.0.0', host_port: 5354, container_port: 54, proto: 'udp' },
        { host_ip: '::',      host_port: 5353, container_port: 53, proto: 'udp' },
        { host_ip: '::',      host_port: 5354, container_port: 54, proto: 'udp' },
      ] },
      { name: 'worker', published: [] },
    ])
  })

  test('nft: an input chain dropping by default, and a forward chain with no DNAT drop', async () => {
    const ruleset = { nftables: [
      { metainfo: { version: '1.0.9', json_schema_version: 1 } },
      { table: { family: 'inet', name: 'filter', handle: 1 } },
      { chain: { family: 'inet', table: 'filter', name: 'input', handle: 1, type: 'filter', hook: 'input', prio: 0, policy: 'drop' } },
      { chain: { family: 'inet', table: 'filter', name: 'forward', handle: 2, type: 'filter', hook: 'forward', prio: 0, policy: 'accept' } },
      { table: { family: 'ip', name: 'filter', handle: 2 } },
      { chain: { family: 'ip', table: 'filter', name: 'INPUT', handle: 1, type: 'filter', hook: 'input', prio: 0, policy: 'accept' } },
    ] }
    const { firewall } = await postureOf({ 'nft -j list ruleset': { exitCode: 0, stdout: JSON.stringify(ruleset) } })
    expect(firewall).toEqual({ input_policy: 'drop', forward_drop: false, exposed: [] })
  })

  // FJS-2772: what nft 1.0.2 printed for the install's table, loaded in a
  // network namespace with the exposed set holding two ports.
  test('nft: the install forward chain drops DNAT, and its exposed set is read', async () => {
    const ours = { family: 'inet', table: 'basecamp' }
    const dnat = { match: { op: 'in', left: { ct: { key: 'status' } }, right: 'dnat' } }
    const ruleset = { nftables: [
      { metainfo: { version: '1.0.2', json_schema_version: 1 } },
      { table: { family: 'inet', name: 'basecamp', handle: 2 } },
      { set: { ...ours, name: 'exposed', type: 'inet_service', handle: 3, elem: [9001, 9000] } },
      { chain: { ...ours, name: 'input', handle: 1, type: 'filter', hook: 'input', prio: 0, policy: 'drop' } },
      { chain: { ...ours, name: 'forward', handle: 2, type: 'filter', hook: 'forward', prio: -1, policy: 'accept' } },
      { rule: { ...ours, chain: 'forward', handle: 12, expr: [dnat,
        { match: { op: '==', left: { meta: { key: 'l4proto' } }, right: { set: ['tcp', 'udp'] } } },
        { match: { op: '==', left: { ct: { key: 'proto-dst', dir: 'original' } }, right: '@exposed' } },
        { accept: null }] } },
      { rule: { ...ours, chain: 'forward', handle: 13, expr: [dnat, { drop: null }] } },
    ] }
    const { firewall } = await postureOf({ 'nft -j list ruleset': { exitCode: 0, stdout: JSON.stringify(ruleset) } })
    expect(firewall).toEqual({ input_policy: 'drop', forward_drop: true, exposed: [9000, 9001] })
  })

  test('nft with no input chain has no policy, and a refused nft is unknown', async () => {
    const { firewall } = await postureOf({
      'nft -j list ruleset': { exitCode: 0, stdout: JSON.stringify({ nftables: [{ metainfo: {} }] }) },
    })
    expect(firewall).toEqual({ input_policy: null, forward_drop: false, exposed: [] })
    expect((await postureOf({ 'nft -j list ruleset': { exitCode: 1, stdout: '' } })).firewall).toBeNull()
  })

  test('sshd -T', async () => {
    const { ssh } = await postureOf({
      'sshd -T': { exitCode: 0, stdout: [
        'port 22', 'permitrootlogin without-password', 'pubkeyauthentication yes',
        'passwordauthentication no', 'maxauthtries 6', 'kbdinteractiveauthentication no',
      ].join('\n') + '\n' },
    })
    expect(ssh).toEqual({
      password_authentication: 'no', permit_root_login: 'without-password',
      pubkey_authentication: 'yes', max_auth_tries: 6,
    })
  })

  test('ssh-keygen -lf, and a file that is not there is no keys', async () => {
    const { ssh_keys } = await postureOf({
      'ssh-keygen -lf': { exitCode: 0, stdout: [
        '256 SHA256:3x8qFv0RkVJjF0yJ1Qy3cQ0Yc7Jd1c2Zl8bV9o5mX0A basecamp@fleet (ED25519)',
        '4096 SHA256:9bq1nXk0mYk5gQ0d1QhC2vY0rTjv8l3Wc5Y2e1o7uPz jordan laptop (RSA)',
      ].join('\n') + '\n' },
    })
    expect(ssh_keys).toEqual([
      { user: 'root', type: 'ED25519', bits: 256,  fingerprint: 'SHA256:3x8qFv0RkVJjF0yJ1Qy3cQ0Yc7Jd1c2Zl8bV9o5mX0A', comment: 'basecamp@fleet' },
      { user: 'root', type: 'RSA',     bits: 4096, fingerprint: 'SHA256:9bq1nXk0mYk5gQ0d1QhC2vY0rTjv8l3Wc5Y2e1o7uPz', comment: 'jordan laptop' },
    ])

    const none = await postureOf({
      'ssh-keygen -lf': { exitCode: 255, stderr: 'ssh-keygen: /root/.ssh/authorized_keys: No such file or directory\n' },
    })
    expect(none.ssh_keys).toEqual([])
  })

  test('apt-get -s: security is the Inst lines from a -security pocket', async () => {
    const { updates } = await postureOf({
      'apt-get -s': { exitCode: 0, stdout: [
        'Reading package lists...',
        'Inst openssl [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
        'Conf openssl (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
        'Inst libssl3t64 [3.0.13-0ubuntu3.4] (3.0.13-0ubuntu3.5 Ubuntu:24.04/noble-security [amd64])',
        'Inst tzdata [2024a-3ubuntu1.1] (2024b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
      ].join('\n') + '\n' },
    })
    expect(updates).toEqual({ pending: 3, security: 2 })
  })

  test('no reboot-required file is a fact, a refused stat is not', async () => {
    const none = await postureOf({
      'stat -c %Y /var/run/reboot-required': { exitCode: 1, stderr: "stat: cannot statx '/var/run/reboot-required': No such file or directory\n" },
    })
    expect(none.reboot).toEqual({ required: false, since: null, pkgs: [] })
    // stat itself missing: Bun's ENOENT message says *No such file* too, and
    // must not read as the file being absent.
    expect((await postureOf({ 'stat ': 'ENOENT' })).reboot).toBeNull()
  })

  test('the outpost unit from the text form when --json is refused', async () => {
    const { outpost_unit } = await postureOf({
      'systemd-analyze security outpost --json=short': { exitCode: 1, stderr: "systemd-analyze: unrecognized option '--json=short'\n" },
      'systemd-analyze security --no-pager outpost':   { exitCode: 0, stdout: '✗ ProcSubset= …\n\n→ Overall exposure level for outpost.service: 4.2 OK 🙂\n' },
    })
    expect(outpost_unit).toEqual({ exposure: 4.2, predicate: 'OK' })
  })

  test('privileged and docker.sock off the narrow inspect format', async () => {
    const { privileged } = await postureOf({
      'docker ps -q':             { exitCode: 0, stdout: 'aaa\nbbb\n' },
      'docker inspect --format':  { exitCode: 0, stdout: [
        '"/fjs-a" false []',
        '"/portainer" true [{"Type":"bind","Source":"/var/run/docker.sock","Destination":"/var/run/docker.sock","Mode":"","RW":true}]',
      ].join('\n') + '\n' },
    })
    expect(privileged).toEqual([
      { name: 'fjs-a',     privileged: false, docker_sock: false },
      { name: 'portainer', privileged: true,  docker_sock: true },
    ])
    // No containers is an answer, and no inspect is run for it.
    expect((await postureOf({ 'docker ps -q': { exitCode: 0, stdout: '' } })).privileged).toEqual([])
  })

  test('grep finding no NOPASSWD rule is none, and the cert expiry is a date', async () => {
    const readings = await postureOf({
      'grep -rh NOPASSWD': { exitCode: 1 },
      'openssl x509':      { exitCode: 0, stdout: 'notAfter=Oct  3 08:00:00 2036 GMT\n' },
      'stat -c %a %U %G':  { exitCode: 0, stdout: '700 root root /etc/outpost\n600 root root /etc/outpost/outpost.key\n600 root root /etc/outpost/outpost.env\n' },
    })
    expect(readings.nopasswd).toEqual([])
    expect(readings.cert).toEqual({ expires_at: '2036-10-03T08:00:00.000Z' })
    expect(readings.files).toContainEqual({ path: '/etc/outpost/outpost.key', mode: '600', owner: 'root', group: 'root' })
  })

  test('the docker group: listed members and primary-gid users, no group is nobody', async () => {
    const group = (line) => ({ 'getent group docker': { exitCode: 0, stdout: line } })
    expect((await postureOf({
      ...group('docker:x:999:bob,alice\n'),
      'awk -F: $4 == 999': { exitCode: 0, stdout: 'deploy\nalice\n' },
    })).docker_group).toEqual(['alice', 'bob', 'deploy'])
    expect((await postureOf({
      ...group('docker:x:999:\n'),
      'awk -F: $4 == 999': { exitCode: 0, stdout: '' },
    })).docker_group).toEqual([])
    expect((await postureOf({ 'getent group docker': { exitCode: 2 } })).docker_group).toEqual([])
    // The members are known and the primary-gid half is not: unknown, never clean.
    expect((await postureOf(group('docker:x:999:\n'))).docker_group).toBeNull()
    expect((await postureOf({})).docker_group).toBeNull()
  })

  test('one binary missing costs its own reading and nothing else', async () => {
    const readings = FIXTURE.readings
    const { run } = replay({ ...readings, ss: { ...readings['net.listening'], spawnError: 'ENOENT' } })
    const { readings: got } = await createInspector({ run }).posture()
    expect(got.listening).toBeNull()
    expect(got.os.codename).toBe('jammy')
    expect(got.containers).toHaveLength(1)

    // Every command throwing: still an answer, every key unknown.
    const { readings: dark } = await createInspector({ run: async (argv) => { throw enoent(argv) } }).posture()
    expect(dark.versions).toEqual({ docker: null, caddy: null, bun: null })
    expect(Object.entries(dark).filter(([k, v]) => k !== 'versions' && v !== null)).toEqual([])
  })
})

// ─── to basecamp ─────────────────────────────────────────────────────────────

describe('posture reaches basecamp', () => {
  test('the reporter posts /posture as report, with the server named', async () => {
    const sent = []
    const reporter = createReporter(CONFIG, {
      inspector: createInspector({ run: replay().run }),
      fetch: async (url, init) => {
        sent.push({ url, init, body: JSON.parse(init.body) })
        return new Response('{}', { status: 200 })
      },
      log: { warn() {} },
    })
    await reporter.reportPosture()

    expect(sent[0].url).toBe('http://basecamp.test/posture')
    expect(sent[0].init.headers['x-service-method']).toBe('report')
    expect(sent[0].init.headers['X-Fjs-Signature']).toMatch(/^v1-ed25519=[A-Za-z0-9_-]{86}$/)
    expect(sent[0].body.server_id).toBe('srv-1')
    expect(sent[0].body.readings.os.codename).toBe('jammy')
    expect(typeof sent[0].body.at).toBe('string')
  })

  let nonces = 0
  async function send(server, path, { key = HUB.privateKey } = {}) {
    const payload = '{}'
    const headers = new Headers({ 'content-type': 'application/json' })
    if (key) {
      for (const [k, v] of Object.entries(await signRequest({
        privateKey: key, method: 'POST', path, body: payload,
        timestamp: Math.floor(Date.now() / 1000), nonce: `posture-${++nonces}`,
      }))) headers.set(k, v)
    }
    return server.handle(new Request(`http://outpost.test${path}`, { method: 'POST', headers, body: payload }))
  }

  test('POST /posture answers the readings when signed, and nothing when not', async () => {
    const server = createOutpostServer(CONFIG, {
      inspector: createInspector({ run: replay().run }),
      log: { warn() {}, error() {} },
    })
    expect((await send(server, '/posture', { key: null })).status).toBe(401)

    const res = await send(server, '/posture')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.readings.kernel.running).toBe('6.8.0-138-generic')
    expect(body.readings.firewall).toBeNull()
  })
})

// ─── the box a Basecamp runs on (FJS-2714) ──────────────────────────────────

describe('the host files on a fleet Outpost', () => {
  const FLEET_ENV = {
    OUTPOST_SERVER_ID: 'srv-host', OUTPOST_SIGNING_KEY: MACHINE.privateKey, OUTPOST_HUB_KEY: HUB.publicKey, BASECAMP_URL: 'https://basecamp.test/',
    OUTPOST_TLS_CERT: '/etc/outpost/outpost.crt', OUTPOST_TLS_KEY: '/etc/outpost/outpost.key',
    OUTPOST_PUBLIC_URL: 'https://host.test:8180',
  }

  const HOST_ENV = { ...FLEET_ENV, OUTPOST_HOST_DB_PATH: '/srv/basecamp/db', OUTPOST_HOST_ENV_PATH: '/srv/basecamp/.env',
                     OUTPOST_HOST_KEY_PATH: '/srv/basecamp/secrets/ENCRYPTION_KEY' }

  test('the paths are read only where fli deploy wrote them', () => {
    expect(readConfig(FLEET_ENV).hostFiles).toBeNull()
    expect(readConfig(HOST_ENV).hostFiles)
      .toEqual({ db: '/srv/basecamp/db', env: '/srv/basecamp/.env', key: '/srv/basecamp/secrets/ENCRYPTION_KEY' })
  })

  test('posture names its machine and carries the files, one stat each', async () => {
    const run = async (argv) => {
      if (argv[0] === 'stat' && argv.at(-1) === '/srv/basecamp/db')   return { exitCode: 0, stdout: '700 root root /srv/basecamp/db\n', stderr: '' }
      if (argv[0] === 'stat' && argv.at(-1) === '/srv/basecamp/.env') return { exitCode: 1, stdout: '', stderr: 'No such file' }
      if (argv[0] === 'stat' && argv.at(-1) === '/srv/basecamp/secrets/ENCRYPTION_KEY')
        return { exitCode: 0, stdout: '400 1000 1000 /srv/basecamp/secrets/ENCRYPTION_KEY\n', stderr: '' }
      throw enoent(argv)
    }
    const sent = []
    const config   = readConfig(HOST_ENV)
    const reporter = createReporter(config, {
      inspector: createInspector({ run, hostFiles: config.hostFiles }),
      fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }) },
      log: { warn() {} },
    })
    await reporter.reportPosture()

    expect(sent.map(s => s.url)).toEqual(['https://basecamp.test/posture'])
    expect(sent[0].body.server_id).toBe('srv-host')
    expect(sent[0].body.readings.host_files).toEqual({
      db:  { path: '/srv/basecamp/db', mode: '700', owner: 'root', group: 'root' },
      env: null,
      key: { path: '/srv/basecamp/secrets/ENCRYPTION_KEY', mode: '400', owner: '1000', group: '1000' },
    })
  })
})
