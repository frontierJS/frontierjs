// src/core/posture.ts — the one grader of a machine's security posture.
//
// The Outpost reports FACTS (`inspector.posture()` in packages/outpost) and this
// file decides what they mean. What a machine SHOULD look like is derived from
// Basecamp's own rows — the apps placed on it, the SSH port, the key it was
// given — so a grader on the box would be a second owner of that, and a stale
// one until the Outpost is upgraded (IDEAS/server-posture.md).
//
// Pure: no db, no clock, no app. `declaredFor` takes the rows, `gradePosture`
// takes the readings and `now`, and every test of a control goes here.
//
// A reading the box could not take arrives as `null`, and a control reading it
// is `'unknown'` — never passing. A grader that read a missing `sshd -T` as
// "password auth is off" would report the box clean exactly when it could not
// look, which is `alerting.ts`'s *no-data is not resolved* for the same reason.

import { createHash } from 'node:crypto'

// ─── The wire ─────────────────────────────────────────────────────────────
// snake_case: the Outpost's contract, not this app's model fields.

export interface Listener   { address: string; port: number; process: string | null }
export interface Published  { host_ip: string; host_port: number; container_port: number; proto: string }

export interface PostureReadings {
  os?:           { id: string; version: string; codename?: string | null } | null
  kernel?:       { running: string; installed: string[] } | null
  reboot?:       { required: boolean; since: string | null; pkgs: string[] } | null
  updates?:      { pending: number; security: number } | null
  auto_updates?: { enabled: boolean; last_run: string | null } | null
  versions?:     { docker: string | null; caddy: string | null; bun: string | null } | null
  listening?:    Listener[] | null
  containers?:   { name: string; published: Published[] }[] | null
  firewall?:     { input_policy: string | null; forward_drop: boolean; exposed: number[] } | null
  ssh?:          { password_authentication: string; permit_root_login: string; pubkey_authentication?: string; max_auth_tries?: number } | null
  ssh_keys?:     { user: string; type?: string; bits?: number; fingerprint: string; comment?: string }[] | null
  uid0?:         string[] | null
  nopasswd?:     string[] | null
  time?:         { synced: boolean; offset_s: number | null } | null
  outpost_unit?: { exposure: number; predicate: string | null } | null
  privileged?:   { name: string; privileged: boolean; docker_sock: boolean }[] | null
  files?:        { path: string; mode: string; owner: string; group: string }[] | null
  cert?:         { expires_at: string } | null
  // The box a Basecamp runs on only: the files `fli deploy` told its Outpost
  // hold the database and ENCRYPTION_KEY, each null when unreadable.
  host_files?:   { db: FileStat | null; env: FileStat | null } | null
}

export interface FileStat { path: string; mode: string; owner: string; group: string }

export type ControlState = true | false | 'unknown'
export type Severity     = 'high' | 'medium' | 'low'

export interface Control {
  id:       string
  group:    string
  ok:       ControlState
  severity: Severity
  message:  string
}

/** What this machine should look like, from Basecamp's rows. */
export interface Declared {
  /** Ports allowed to listen on a public address. */
  expectedPorts: number[]
  /** Ports an app on this machine publishes on every interface by declaration. */
  exposedPorts:  number[]
  /** SHA256 fingerprints of the keys Basecamp gave it; null when it holds none. */
  sshKeys:       string[] | null
}

/** The Outpost's own clock for this report (`OUTPOST_POSTURE_MS`). */
export const POSTURE_INTERVAL_MS = 6 * 60 * 60_000

const OUTPOST_COMMAND_PORT = 8180
export const OUTPOST_STATIC_PORT = 8181
const CADDY_ADMIN_PORT     = 2019

// ─── declared ─────────────────────────────────────────────────────────────

/**
 * The expected set, derived and never typed in.
 *
 * 8181 is the static origin, which only an inline app needs; everything else on
 * a public address is an app that declared `exposesPort` (`FJS-D930`). An app
 * with no hostname that does not declare it is an unexpected listener, because
 * until every published port binds loopback that is what it is.
 */
export function declaredFor(input: {
  sshPort:   number | null | undefined
  apps:      { type?: string | null; port?: number | null; exposesPort?: boolean | null }[]
  sshKeyData?: string | null
}): Declared {
  const exposed = input.apps
    .filter(a => a.exposesPort && typeof a.port === 'number')
    .map(a => a.port as number)
  const expected = new Set([input.sshPort || 22, 80, 443, OUTPOST_COMMAND_PORT, ...exposed])
  if (input.apps.some(a => a.type === 'static')) expected.add(OUTPOST_STATIC_PORT)

  return {
    expectedPorts: [...expected].sort((a, b) => a - b),
    exposedPorts:  exposed,
    sshKeys:       input.sshKeyData ? publicKeyFingerprints(input.sshKeyData) : null,
  }
}

/**
 * Every OpenSSH public key named anywhere in a Secret's data, as the
 * `SHA256:…` fingerprint `ssh-keygen -lf` prints. A private key alone yields
 * none, which grades `ssh.unknown-key` unknown rather than failing every key.
 */
export function publicKeyFingerprints(data: string): string[] | null {
  const found = [...data.matchAll(/(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-[\w@.-]+) (AAAA[0-9A-Za-z+/]+=*)/g)]
    .map(m => 'SHA256:' + createHash('sha256').update(Buffer.from(m[1], 'base64')).digest('base64').replace(/=+$/, ''))
  return found.length ? [...new Set(found)] : null
}

// ─── the controls ─────────────────────────────────────────────────────────

const isLoopback = (address: string) =>
  address.startsWith('127.') || address === '::1' || /%lo$/.test(address)

// `ss` prints every interface as `0.0.0.0`, `*` or `::`, and Docker publishes
// to `0.0.0.0` and `::` together, so all of these are "reachable from outside".
const isEveryInterface = (address: string) =>
  address === '0.0.0.0' || address === '::' || address === '*' || address === ''

// End of standard support. A release missing from the table grades unknown,
// never passing: a box on a release nobody listed is the one most likely EOL.
const EOL: Record<string, string> = {
  'ubuntu 18.04': '2023-05-31', 'ubuntu 20.04': '2025-05-31',
  'ubuntu 22.04': '2027-06-01', 'ubuntu 24.04': '2029-05-31',
  'debian 10':    '2024-06-30', 'debian 11':    '2026-08-31',
  'debian 12':    '2028-06-30', 'debian 13':    '2030-06-30',
}

const REBOOT_GRACE_DAYS = 7
const CERT_WARN_DAYS    = 30
// `systemd-analyze security` scores 0 (locked down) to 10; above 7 it says EXPOSED.
const SANDBOX_MAX       = 7

/** `5.15.0-198-generic` → `5.15`, the series a kernel package belongs to. */
const series = (kernel: string) => /^(\d+\.\d+)/.exec(kernel)?.[1] ?? kernel

const days = (ms: number) => Math.floor(ms / 86_400_000)

type Grade = { ok: ControlState; message: string }
const unknown = (why: string): Grade => ({ ok: 'unknown', message: why })

/**
 * Each control: its id, group, severity, and a grade of the readings.
 * A control's grade answers `unknown` whenever the reading it needs is null.
 *
 * `hardenedAtInstall` is a control `installScript()` satisfies, and the script
 * carries a `# posture: <id>` line at the step that does it. compute.test.ts
 * holds the two sets equal, so a step dropped from the install cannot leave a
 * box graded against it as though it ran.
 */
const CONTROLS: { id: string; group: string; severity: Severity; hardenedAtInstall?: true; grade: (r: PostureReadings, d: Declared, now: number) => Grade }[] = [
  { id: 'ssh.password-off', group: 'ssh', severity: 'high', hardenedAtInstall: true, grade: (r) => {
    if (!r.ssh) return unknown('sshd -T could not be read')
    return r.ssh.password_authentication === 'no'
      ? { ok: true,  message: 'Password authentication is off' }
      : { ok: false, message: `PasswordAuthentication is ${r.ssh.password_authentication}` }
  } },

  { id: 'ssh.root-key-only', group: 'ssh', severity: 'high', hardenedAtInstall: true, grade: (r) => {
    if (!r.ssh) return unknown('sshd -T could not be read')
    const v = r.ssh.permit_root_login
    return ['no', 'prohibit-password', 'without-password'].includes(v)
      ? { ok: true,  message: `PermitRootLogin is ${v}` }
      : { ok: false, message: `PermitRootLogin is ${v} — root may log in with a password` }
  } },

  { id: 'ssh.unknown-key', group: 'ssh', severity: 'high', grade: (r, d) => {
    if (!r.ssh_keys) return unknown('authorized_keys could not be read')
    if (!d.sshKeys)  return unknown('Basecamp holds no public key for this machine (Server.sshKeyId)')
    const known    = new Set(d.sshKeys)
    const strangers = r.ssh_keys.filter(k => !known.has(k.fingerprint))
    return strangers.length
      ? { ok: false, message: `Keys Basecamp did not issue: ${strangers.map(k => `${k.user} ${k.fingerprint}${k.comment ? ` (${k.comment})` : ''}`).join(', ')}` }
      : { ok: true,  message: `${r.ssh_keys.length} authorized key(s), all issued by Basecamp` }
  } },

  { id: 'net.firewall-default-deny', group: 'network', severity: 'high', hardenedAtInstall: true, grade: (r) => {
    if (!r.firewall) return unknown('The firewall ruleset could not be read')
    return r.firewall.input_policy === 'drop'
      ? { ok: true,  message: 'Inbound policy is drop' }
      : { ok: false, message: r.firewall.input_policy ? `Inbound policy is ${r.firewall.input_policy}` : 'No inbound filter chain' }
  } },

  { id: 'net.unexpected-listener', group: 'network', severity: 'high', grade: (r, d) => {
    if (!r.listening) return unknown('Listening sockets could not be read')
    const expected = new Set(d.expectedPorts)
    const strays   = r.listening.filter(l => !isLoopback(l.address) && !expected.has(l.port))
    const named    = [...new Map(strays.map(l => [`${l.port}`, `${l.port}${l.process ? ` (${l.process})` : ''}`])).values()]
    return named.length
      ? { ok: false, message: `Listening on a public address: ${named.join(', ')}` }
      : { ok: true,  message: 'Nothing unexpected listens on a public address' }
  } },

  { id: 'net.container-public', group: 'network', severity: 'high', grade: (r, d) => {
    if (!r.containers) return unknown('Published container ports could not be read')
    const exposed = new Set(d.exposedPorts)
    const open    = r.containers.flatMap(c => c.published
      .filter(p => isEveryInterface(p.host_ip) && !exposed.has(p.host_port))
      .map(p => ({ name: c.name, port: p.host_port })))
    if (!open.length) return { ok: true, message: 'No container publishes an undeclared port on every interface' }

    // A published port is forwarded, never input, so it is reachable whatever
    // the inbound policy says unless the forward chain drops it; the box's
    // exposed set is what that chain lets through.
    const fw = r.firewall
    if (!fw) return unknown(`Published on every interface (${open.map(o => o.port).join(', ')}) and the firewall could not be read`)
    const bare  = fw.forward_drop ? open.filter(o => fw.exposed.includes(o.port)) : open
    const named = [...new Set(bare.map(o => `${o.port} (${o.name})`))].join(', ')
    if (!bare.length) return { ok: true, message: 'Every undeclared public container port is dropped by the firewall' }
    return fw.forward_drop
      ? { ok: false, message: `Let through by the firewall's exposed set though no app declares it: ${named}` }
      : { ok: false, message: `Published on every interface with no forward drop: ${named}` }
  } },

  { id: 'net.caddy-admin-loopback', group: 'network', severity: 'high', grade: (r) => {
    if (!r.listening) return unknown('Listening sockets could not be read')
    const admin = r.listening.filter(l => l.port === CADDY_ADMIN_PORT)
    if (!admin.length) return { ok: true, message: 'Caddy\'s admin API is not listening' }
    return admin.every(l => isLoopback(l.address))
      ? { ok: true,  message: 'Caddy\'s admin API is on loopback only' }
      : { ok: false, message: `Caddy's admin API listens on ${admin.filter(l => !isLoopback(l.address)).map(l => l.address).join(', ')}` }
  } },

  { id: 'patch.security-pending', group: 'patching', severity: 'medium', grade: (r) => {
    if (!r.updates) return unknown('Pending updates could not be read')
    return r.updates.security === 0
      ? { ok: true,  message: `No security updates pending (${r.updates.pending} other)` }
      : { ok: false, message: `${r.updates.security} security update(s) pending` }
  } },

  { id: 'patch.auto-updates-on', group: 'patching', severity: 'medium', hardenedAtInstall: true, grade: (r) => {
    if (!r.auto_updates) return unknown('unattended-upgrades could not be read')
    return r.auto_updates.enabled
      ? { ok: true,  message: r.auto_updates.last_run ? `Automatic updates on, last run ${r.auto_updates.last_run}` : 'Automatic updates on' }
      : { ok: false, message: 'Automatic security updates are off' }
  } },

  { id: 'patch.reboot-pending', group: 'patching', severity: 'medium', grade: (r, _d, now) => {
    if (!r.reboot) return unknown('reboot-required could not be read')
    if (!r.reboot.required) return { ok: true, message: 'No reboot required' }

    // `/var/run/reboot-required` can name a kernel that will never boot — a
    // 5.15 image installed beside a running 6.8 HWE kernel — and graded on its
    // age alone this control would fail forever. A pending reboot is one whose
    // packages are something other than another series' kernel.
    const running = r.kernel?.running ? series(r.kernel.running) : null
    const real = r.reboot.pkgs.filter(p => {
      if (p === 'linux-base') return false
      const image = /^linux-image-(.+)$/.exec(p)
      return !(image && running && series(image[1]) !== running)
    })
    if (r.reboot.pkgs.length && !real.length)
      return { ok: true, message: `Reboot-required names only another kernel series (${r.reboot.pkgs.join(', ')})` }

    const since = r.reboot.since ? Date.parse(r.reboot.since) : NaN
    if (!Number.isFinite(since)) return unknown('A reboot is required and when it became required could not be read')
    const age = days(now - since)
    return age < REBOOT_GRACE_DAYS
      ? { ok: true,  message: `Reboot required for ${age} day(s)` }
      : { ok: false, message: `Reboot required for ${age} days` }
  } },

  { id: 'os.eol', group: 'os', severity: 'medium', grade: (r, _d, now) => {
    if (!r.os) return unknown('/etc/os-release could not be read')
    const eol = EOL[`${r.os.id} ${r.os.version}`]
    if (!eol) return unknown(`No support date known for ${r.os.id} ${r.os.version}`)
    return Date.parse(eol) > now
      ? { ok: true,  message: `${r.os.id} ${r.os.version} is supported until ${eol}` }
      : { ok: false, message: `${r.os.id} ${r.os.version} left support on ${eol}` }
  } },

  { id: 'time.synced', group: 'runtime', severity: 'low', hardenedAtInstall: true, grade: (r) => {
    if (!r.time) return unknown('Time sync could not be read')
    return r.time.synced
      ? { ok: true,  message: r.time.offset_s === null ? 'Clock synchronized' : `Clock synchronized, offset ${r.time.offset_s}s` }
      : { ok: false, message: 'The clock is not synchronized' }
  } },

  { id: 'outpost.sandbox', group: 'outpost', severity: 'low', hardenedAtInstall: true, grade: (r) => {
    if (!r.outpost_unit) return unknown('systemd-analyze security could not score the outpost unit')
    return r.outpost_unit.exposure <= SANDBOX_MAX
      ? { ok: true,  message: `outpost.service exposure ${r.outpost_unit.exposure}` }
      : { ok: false, message: `outpost.service exposure ${r.outpost_unit.exposure}${r.outpost_unit.predicate ? ` ${r.outpost_unit.predicate}` : ''}` }
  } },

  { id: 'outpost.cert-expiry', group: 'outpost', severity: 'medium', grade: (r, _d, now) => {
    if (!r.cert) return unknown('The command port\'s certificate could not be read')
    const left = days(Date.parse(r.cert.expires_at) - now)
    if (!Number.isFinite(left)) return unknown(`Unreadable expiry: ${r.cert.expires_at}`)
    return left > CERT_WARN_DAYS
      ? { ok: true,  message: `Certificate valid for ${left} days` }
      : { ok: false, message: left < 0 ? `Certificate expired ${-left} day(s) ago` : `Certificate expires in ${left} day(s)` }
  } },

  { id: 'accounts.extra-uid0', group: 'accounts', severity: 'high', grade: (r) => {
    if (!r.uid0) return unknown('/etc/passwd could not be read')
    const extra = r.uid0.filter(u => u !== 'root')
    return extra.length
      ? { ok: false, message: `uid 0 besides root: ${extra.join(', ')}` }
      : { ok: true,  message: 'Only root has uid 0' }
  } },

  { id: 'docker.privileged', group: 'runtime', severity: 'high', grade: (r) => {
    if (!r.privileged) return unknown('Containers could not be inspected')
    const bad = r.privileged.filter(c => c.privileged || c.docker_sock)
    return bad.length
      ? { ok: false, message: `Privileged or holding docker.sock: ${bad.map(c => c.name.replace(/^\//, '')).join(', ')}` }
      : { ok: true,  message: 'No container is privileged or mounts docker.sock' }
  } },
]

export const CONTROL_IDS         = CONTROLS.map(c => c.id)
export const HARDENED_AT_INSTALL = CONTROLS.filter(c => c.hardenedAtInstall).map(c => c.id)

/**
 * Grade one report.
 *
 * A report older than twice its interval grades every control `unknown`: the
 * Outpost stopped reporting, and the last answer it gave says nothing about the
 * box now. Stale reads as unknown, never as the clean answer it last gave.
 */
export function gradePosture(
  readings: PostureReadings | null | undefined,
  declared: Declared,
  { at, now, intervalMs = POSTURE_INTERVAL_MS }: { at: string | number; now: number; intervalMs?: number },
): Control[] {
  const taken = typeof at === 'number' ? at : Date.parse(at)
  const stale = !Number.isFinite(taken) || now - taken > 2 * intervalMs

  return CONTROLS.map(({ id, group, severity, grade }) => {
    if (stale || !readings) return { id, group, severity, ok: 'unknown' as const,
      message: stale ? 'The last report is stale' : 'No report' }
    let g: Grade
    try { g = grade(readings, declared, now) }
    catch { g = unknown('The reading was not in the shape the grader expects') }
    return { id, group, severity, ...g }
  })
}

// ─── the box a Basecamp runs on ───────────────────────────────────────────

// The default `backupCron` is daily, so two days is one missed run and a grace.
const BACKUP_MAX_AGE_DAYS = 2

// Owner and group may do anything; any bit for everyone else is a reader of
// `ENCRYPTION_KEY` or of every workspace's rows who is not the stack.
const worldAccess = (mode: string) => (Number.parseInt(mode, 8) & 0o007) !== 0

function fileControl(what: string, stat: FileStat | null | undefined): Grade {
  if (!stat) return unknown(`The ${what} could not be read — fli deploy writes its path into this box's Outpost config`)
  if (!/^[0-7]{3,4}$/.test(stat.mode)) return unknown(`Unreadable mode for ${stat.path}: ${stat.mode}`)
  return worldAccess(stat.mode)
    ? { ok: false, message: `${stat.path} is mode ${stat.mode} — readable outside ${stat.owner}:${stat.group}` }
    : { ok: true,  message: `${stat.path} is mode ${stat.mode}` }
}

const HUB_CONTROLS: { id: string; group: string; severity: Severity; grade: (r: PostureReadings | null, host: HostDeclared, now: number) => Grade }[] = [
  // Graded in process from the Backup rows, so a stale report does not hide it.
  { id: 'hub.backup-recent', group: 'hub', severity: 'high', grade: (_r, host, now) => {
    if (!host.lastBackupAt) return { ok: false, message: 'No backup has ever finished' }
    const age = days(now - Date.parse(host.lastBackupAt))
    return age <= BACKUP_MAX_AGE_DAYS
      ? { ok: true,  message: age === 0 ? 'Last backup finished today' : `Last backup finished ${age} day(s) ago` }
      : { ok: false, message: `Last backup finished ${age} days ago` }
  } },
  { id: 'hub.db-mode',  group: 'hub', severity: 'high', grade: (r) => fileControl('database volume', r?.host_files?.db) },
  { id: 'hub.env-mode', group: 'hub', severity: 'high', grade: (r) => fileControl('file holding ENCRYPTION_KEY', r?.host_files?.env) },
]

export const HUB_CONTROL_IDS = HUB_CONTROLS.map(c => c.id)

/** What the box a Basecamp runs on should look like, beyond any fleet machine. */
export interface HostDeclared {
  /** `finishedAt` of the newest successful Backup; null when none has. */
  lastBackupAt: string | null
}

/**
 * The `hub.*` controls, graded from the host row's newest report. The fleet
 * controls are that row's own (`gradePosture`), so these are only what the box
 * holding `ENCRYPTION_KEY` adds. `hub.backup-recent` reads rows, never the
 * report, so it is graded whether or not the report is stale.
 */
export function gradeHub(
  readings: PostureReadings | null | undefined,
  host: HostDeclared,
  { at, now, intervalMs = POSTURE_INTERVAL_MS }: { at: string | number; now: number; intervalMs?: number },
): Control[] {
  const taken = typeof at === 'number' ? at : Date.parse(at)
  const stale = !Number.isFinite(taken) || now - taken > 2 * intervalMs
  return HUB_CONTROLS.map(({ id, group, severity, grade }) => {
    if (id !== 'hub.backup-recent' && (stale || !readings))
      return { id, group, severity, ok: 'unknown' as const, message: stale ? 'The last report is stale' : 'No report' }
    let g: Grade
    try { g = grade(readings ?? null, host, now) }
    catch { g = unknown('The reading was not in the shape the grader expects') }
    return { id, group, severity, ...g }
  })
}

/** How a graded report sorts: failing high first, then any failing, then unknown. */
export function postureRank(controls: Control[]): number {
  const failing = controls.filter(c => c.ok === false)
  return failing.filter(c => c.severity === 'high').length * 10_000
    + failing.length * 100
    + controls.filter(c => c.ok === 'unknown').length
}

/** Which controls moved between two reports: unknown on either side is no move. */
export function postureChanges(before: Control[] | null, after: Control[]): { failed: Control[]; restored: Control[] } {
  const prior = new Map((before ?? []).map(c => [c.id, c.ok]))
  return {
    failed:   after.filter(c => c.ok === false && prior.get(c.id) !== false && prior.get(c.id) !== 'unknown'),
    restored: after.filter(c => c.ok === true  && prior.get(c.id) === false),
  }
}
