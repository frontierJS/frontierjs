#!/usr/bin/env bun
/*
 * capture.mjs — every command the posture readings will run, run once, with the
 * runner's own answer recorded: `{ argv, exitCode, stdout, stderr }`.
 *
 * `inspector.posture()` is tested by replaying these through an injected runner,
 * so a parser is graded against what a real machine said rather than what its
 * author expected it to say. Run as root on a fleet box (where the Outpost runs
 * as root) and as a plain user on a dev host: the second is where the readings
 * that need root come back non-zero, which is the `unknown` path.
 *
 *   bun test/fixtures/posture/capture.mjs <label> > test/fixtures/posture/<label>.json
 *
 * A missing binary is recorded as `exitCode: null` with the spawn error, because
 * Bun.spawn THROWS on ENOENT rather than exiting 127 — a reader that only checks
 * the exit code never sees it.
 *
 * The fixture is committed, so what identifies the machine is replaced before it
 * is printed: the hostname by the label, and the pids `ss -p` shows and any process name
 * a fleet box would not run, which on a dev host are the owner's own programs. Port and address stay,
 * because they are the reading.
 */

import { hostname } from 'node:os'

const LOG = '/var/log/unattended-upgrades/unattended-upgrades.log'

const READINGS = {
  'os':                  ['cat', '/etc/os-release'],
  'kernel.running':      ['uname', '-r'],
  // The status column, because `-W` also lists every kernel removed with its
  // config left behind (`rc`) — 176 of them on the dev host, beside 3 installed.
  'kernel.installed':    ['dpkg-query', '-W', '-f', '${db:Status-Abbrev} ${Package}\n', 'linux-image-[0-9]*'],
  'reboot.required':     ['stat', '-c', '%Y', '/var/run/reboot-required'],
  'reboot.pkgs':         ['cat', '/var/run/reboot-required.pkgs'],
  'apt.pending':         ['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'upgrade'],
  'unattended.periodic': ['apt-config', 'dump', 'APT::Periodic'],
  'unattended.config':   ['apt-config', 'dump', 'Unattended-Upgrade'],
  'unattended.timer':    ['systemctl', 'is-enabled', 'apt-daily-upgrade.timer'],
  'unattended.lastRun':  ['stat', '-c', '%Y', '/var/lib/apt/periodic/upgrade-stamp'],
  'unattended.log':      ['tail', '-n', '20', LOG],
  'version.docker':      ['docker', 'version', '--format', 'json'],
  'version.caddy':       ['caddy', 'version'],
  'version.bun':         ['bun', '--version'],
  'net.listening':       ['ss', '-tlnpH'],
  'net.containers':      ['docker', 'ps', '--format', 'json'],
  'net.ruleset':         ['nft', '-j', 'list', 'ruleset'],
  'ssh.effective':       ['sshd', '-T'],
  'ssh.keys.root':       ['ssh-keygen', '-lf', '/root/.ssh/authorized_keys'],
  'accounts.uid0':       ['awk', '-F:', '$3 == 0 { print $1 }', '/etc/passwd'],
  'accounts.nopasswd':   ['grep', '-rh', 'NOPASSWD', '/etc/sudoers', '/etc/sudoers.d'],
  'accounts.dockerGroup': ['getent', 'group', 'docker'],
  'time.sync':           ['timedatectl', 'show'],
  'time.tracking':       ['chronyc', '-c', 'tracking'],
  'runtime.outpostUnit': ['systemd-analyze', 'security', 'outpost', '--json=short'],
  // systemd 249 refuses `--json`, and the text form's last line carries the
  // overall score on every version.
  'runtime.outpostUnitText': ['systemd-analyze', 'security', '--no-pager', 'outpost'],
  'runtime.containers':  ['docker', 'ps', '-q'],
  'files.etc':           ['stat', '-c', '%a %U %G %n', '/etc/basecamp', '/etc/basecamp/outpost.key', '/etc/basecamp/outpost.env'],
  'files.certExpiry':    ['openssl', 'x509', '-enddate', '-noout', '-in', '/etc/basecamp/outpost.crt'],
}

async function run(argv) {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode: await proc.exited, stdout, stderr }
  } catch (err) {
    return { exitCode: null, stdout: '', stderr: '', spawnError: err.code ?? String(err.message) }
  }
}

const readings = {}
for (const [key, argv] of Object.entries(READINGS)) readings[key] = { argv, ...await run(argv) }

// Per container: privileged and the docker.sock mount, and nothing else —
// `docker inspect` whole carries every container's environment, secrets included.
const ids = readings['runtime.containers'].stdout.split('\n').filter(Boolean)
const inspectArgv = ['docker', 'inspect', '--format',
  '{{json .Name}} {{json .HostConfig.Privileged}} {{json .Mounts}}', ...ids]
readings['runtime.inspect'] = ids.length ? { argv: inspectArgv, ...await run(inspectArgv) } : null

// Whoever holds docker as a PRIMARY group, which the group's own line omits.
const dockerGid = readings['accounts.dockerGroup'].stdout.split(':')[2]
const primaryArgv = ['awk', '-F:', `$4 == ${dockerGid} { print $1 }`, '/etc/passwd']
readings['accounts.dockerPrimary'] = /^\d+$/.test(dockerGid ?? '') ? { argv: primaryArgv, ...await run(primaryArgv) } : null

const label = process.argv[2] ?? 'host'
const name  = hostname()

// What a fleet box runs is part of the reading (`net.unexpected-listener` names
// the process), so only a name outside that set is replaced.
const FLEET = new Set(['sshd', 'caddy', 'docker-proxy', 'dockerd', 'bun', 'chronyd', 'systemd-resolve'])

const redact = (text) => text
  .replaceAll(name, label)
  .replace(/\(\("([^"]+)",pid=\d+,fd=(\d+)\)/g, (_, proc, fd) =>
    `(("${FLEET.has(proc) ? proc : 'proc'}",pid=1,fd=${fd})`)

for (const r of Object.values(readings)) {
  if (!r) continue
  r.stdout = redact(r.stdout)
  r.stderr = redact(r.stderr)
}

const meta = {
  host: label,
  uid: process.getuid(),
  at: new Date().toISOString(),
}

console.log(JSON.stringify({ meta, readings }, null, 2))
