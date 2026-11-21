// ─── cgroups.js — the app groups systemd-oomd actually kills ─────────────────
//
// `fli top --hitlist` groups PROCESSES into jobs; systemd-oomd kills CGROUPS.
// When memory pressure on `user@<uid>.service` passes its limit, oomd picks the
// heaviest cgroup under it (a VS Code scope, a Chrome scope) and kills every
// process in it — 97,842 of them, once. So the question after an incident is
// "which scope held the memory", and that is answered from
// /sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/, not from /proc.
//
// Every read degrades to nothing: cgroup v1, another OS, a unit that vanished
// between the listing and the read, a file the kernel does not expose. The
// root is injectable, so a test hands it a fake tree in a tmp dir.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const readOr = (path, fallback = null) => { try { return readFileSync(path, 'utf8') } catch { return fallback } }
const num = text => { const n = parseInt(text, 10); return Number.isFinite(n) ? n : null }

/** `some avg10=1.5 …` / `full avg10=0.0 …` of a memory.pressure file → { some, full }, null where unread. */
export function parsePressure(text) {
  const grab = kind => {
    const m = text?.match(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm'))
    return m ? Number(m[1]) : null
  }
  return { some: grab('some'), full: grab('full') }
}

/** systemd escapes a unit name's odd bytes as `\xNN`: `google\x2dchrome` is `google-chrome`. */
export const unescapeUnit = s => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

const KNOWN = [
  [/chrome/i, 'Chrome'], [/chromium/i, 'Chromium'], [/firefox/i, 'Firefox'], [/vscode|code-?insiders|^code$/i, 'VSCode'],
  [/cursor/i, 'Cursor'], [/slack/i, 'Slack'], [/spotify/i, 'Spotify'],
]

/**
 * A name a person recognises for a cgroup unit:
 * `app-com.microsoft.VSCode-27762.scope` → `VSCode`,
 * `app-gnome-google\x2dchrome-7362.scope` → `Chrome`,
 * `tmux-spawn-<uuid>.scope` → `tmux`, `session-3.scope` → `login session 3`.
 */
export function friendlyName(unit) {
  let s = unescapeUnit(unit)
  const kind = (s.match(/\.(scope|service|slice|socket)$/) ?? [])[1]
  s = s.replace(/\.(scope|service|slice|socket)$/, '')
  if (/^tmux-spawn-/.test(s)) return 'tmux'
  if (/^vte-spawn-/.test(s)) return 'terminal tab'
  let m = s.match(/^session-(\w+)$/)
  if (m) return `login session ${m[1]}`
  if (s.startsWith('app-')) {
    s = s.slice(4).replace(/^(gnome|kde|plasma|xfce|cinnamon|mate|flatpak|snap)-/, '').replace(/-\d+$/, '')
    s = s.replace(/-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, '')
  } else if (kind === 'service') {
    s = s.replace(/@.*$/, '')
  }
  for (const [re, name] of KNOWN) if (re.test(s)) return name
  if (/^[a-z][\w-]*(\.[\w-]+){2,}$/i.test(s)) {
    // reverse-DNS: the last label names the app, unless it is a generic one
    const parts = s.split('.')
    const last = parts.pop()
    return /^(desktop|app|main)$/.test(last) ? parts.pop() : last
  }
  return s || unit
}

/** Every cgroup file one unit directory holds that a person reads; null where absent. */
function readUnit(dir) {
  const mem = num(readOr(join(dir, 'memory.current')))
  if (mem == null) return null // no memory controller here: not a group worth showing
  const p = parsePressure(readOr(join(dir, 'memory.pressure'), ''))
  return {
    memBytes: mem,
    swapBytes: num(readOr(join(dir, 'memory.swap.current'))),
    peakBytes: num(readOr(join(dir, 'memory.peak'))),
    pids: num(readOr(join(dir, 'pids.current'))),
    some10: p.some,
    full10: p.full,
  }
}

const dirs = path => { try { return readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] } }

// The slices whose children are the user's apps. A `.slice` found INSIDE one is a
// group of its own (its memory already includes its children), not walked.
const CONTAINERS = new Set(['app.slice', 'session.slice', 'background.slice'])

/**
 * The user's cgroups, heaviest first, and the parent `user@<uid>.service` oomd judges.
 * `{ parent, groups }` — `parent` is null and `groups` empty where there is no cgroup v2 tree.
 * `root` is /sys/fs/cgroup; a test points it at a fake one.
 */
export function readCgroups({ root = '/sys/fs/cgroup', uid = process.getuid?.() ?? 1000 } = {}) {
  const base = join(root, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`)
  const parentRead = readUnit(base)
  if (!parentRead) return { parent: null, groups: [] }
  const parent = { unit: `user@${uid}.service`, ...parentRead }

  const groups = []
  const add = (rel, unit) => {
    const r = readUnit(join(base, rel))
    if (r) groups.push({ unit, slice: rel.includes('/') ? rel.split('/')[0] : null, friendly: friendlyName(unit), ...r })
  }
  for (const top of dirs(base)) {
    if (CONTAINERS.has(top)) for (const child of dirs(join(base, top))) add(`${top}/${child}`, child)
    else add(top, top)
  }
  groups.sort((a, b) => b.memBytes - a.memBytes)
  return { parent, groups }
}

// ─── the oomd limit ──────────────────────────────────────────────────────────

/** `ManagedOOMMemoryPressureLimit` is a fraction of 2^32-1: 2147483648 is 50%. */
export const limitPct = raw => (Number(raw) > 0 ? Math.round(Number(raw) / 4294967295 * 10000) / 100 : null)

/** `DefaultMemoryPressureDurationSec=20s` (or `1min`) from oomd.conf text, in seconds. */
export function confDuration(text) {
  const m = text?.match(/^\s*DefaultMemoryPressureDurationSec\s*=\s*(\d+)\s*(s|sec|min|m)?\b/m)
  if (!m) return null
  return Number(m[1]) * (/^m/.test(m[2] ?? '') ? 60 : 1)
}

/**
 * The limit oomd holds `user@<uid>.service` to, and for how long: asked of
 * systemd (`systemctl show`), else read from /etc/systemd/oomd.conf, else the
 * values the oomd log named in the incident this was built for — 50% for 20s —
 * and `source` says which, so a screen never states a guess as a fact.
 * `run` and `confPath` are injectable for a test.
 */
export function oomdLimits({ uid = process.getuid?.() ?? 1000, run = defaultRun, confPath = '/etc/systemd/oomd.conf' } = {}) {
  const conf = readOr(confPath, '')
  const out = run('systemctl', ['show', `user@${uid}.service`, '-p', 'ManagedOOMMemoryPressureLimit', '--value'])
  let pct = limitPct(out)
  let source = pct != null ? 'systemctl' : 'assumed'
  if (pct == null) {
    // the unit sets no limit of its own, so oomd.conf's default applies
    const d = conf.match(/^\s*DefaultMemoryPressureLimit\s*=\s*([\d.]+)%/m)
    if (d) { pct = Number(d[1]); source = 'oomd.conf' }
  }
  return { limitPct: pct ?? 50, durationSec: confDuration(conf) ?? 20, source }
}

function defaultRun(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000 })
    return r.status === 0 ? r.stdout.trim() : null
  } catch { return null }
}

/** How near the parent's pressure is to the kill line: 'over', 'near' (past 60% of it), or null. */
export function pressureFlag(some10, limit) {
  if (some10 == null || !limit) return null
  if (some10 >= limit) return 'over'
  return some10 >= limit * 0.6 ? 'near' : null
}

/** What `sample()` attaches: the cgroup read plus the limit and the verdict. */
export function readAppGroups(opts = {}) {
  const { parent, groups } = readCgroups(opts)
  if (!parent) return null
  const oomd = opts.oomd ?? oomdLimits(opts)
  return { parent, groups, oomd, flag: pressureFlag(parent.some10, oomd.limitPct) }
}
