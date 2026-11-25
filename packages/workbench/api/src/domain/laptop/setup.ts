// api/src/domain/laptop/setup.ts
// What this laptop can and cannot do, grouped by goal, for a new user.
//
// `fli doctor`'s rows (`core/doctor.js` `diagnose()`, read off the registry
// `services.ts` already built) plus the four things only Workbench knows: whether
// its `claude` is signed in, whether its two keys are still the dev defaults, and
// whether the phone ping is set. A goal's state is derived on every call and
// never stored.
//
// A fix is data and never a verb. Copy a command, open a vendor's page, or go to
// the Workbench screen that already fixes it: this page starts no new kind of
// shell command (FJS-D2162), so a fix that said `run` could not be written.
//
// Only a missing tool or a signed-out `claude` can make a required goal `error`.
// A git identity, a file mode or a dev default key is advice, and Home's "Needs
// you" must not nag a person about advice.
//
// Presence and booleans leave. A key's value, a login's token and a binary's
// output never do: `dev` is a boolean computed from the value here.

import { GOALS, diagnose, goalOf }                from '@frontierjs/cli/core/doctor.js'
import { services as catalog }                    from '@frontierjs/cli/core/services.js'
import { listGlobal }                             from '@frontierjs/cli/core/global-env.js'
import { DEV_ENCRYPTION_KEY, DEV_WORKBENCH_KEY, env as appEnv } from '../../core/env.ts'
import { claudeAuthStatus }                       from '@frontierjs/claude'
import { claudeProgram }                          from '../local/local-claude.ts'
import { ping }                                   from './ping.ts'
import { requiringModulesOnRegistry }             from './services.ts'
import type { Where }                             from './laptop.ts'

export type Fix =
  | { copy: string }
  | { url: string, note: string }
  | { go: string, label: string }
export type State = 'ok' | 'warn' | 'error' | 'unset'
export type SetupRow = {
  id: string, label: string, ok: boolean, level: 'ok' | 'warn' | 'error',
  detail: string | null, why: string, fix: Fix | null,
}
export type SetupGoal = { id: string, label: string, why: string, required: boolean, state: State, rows: SetupRow[] }
export type Setup = { goals: SetupGoal[] }

type Doctor = {
  system:     Array<{ name: string, ok: boolean, present: boolean, level: string, for: string[], install: string, why: string, status?: string }>
  identity:   Array<{ label: string, ok: boolean, detail?: string | null, for: string[], install: string, why: string }>
  namespaces: Array<{ ns: string, key: string, ok: boolean, for: string[] }>
  secrets:    Array<{ label: string, ok: boolean, hint: string }>
  services:   Array<{ id: string, name: string, kind: string, present: boolean }>
}
type Auth = Awaited<ReturnType<typeof claudeAuthStatus>>
type CatalogRow = { id: string, namespaces: string[], signIn: { kind: string, bin?: string }, vendor?: { url: string, note?: string } }

export type Options = Where & {
  has?:      (cmd: string) => boolean
  versionOf?: (cmd: string) => string | null
  gitOf?:    (key: string, cwd?: string) => string
  auth?:     () => Promise<Auth>
  keys?:     { WORKBENCH_KEY?: string, ENCRYPTION_KEY?: string }
  env?:      Record<string, string | undefined>
}

const isUrl = (text: string) => /^https?:\/\//.test(text)

/** An install line as a fix: a URL opens, anything else is a command to paste. */
export const installFix = (install: string, note: string): Fix => isUrl(install) ? { url: install, note } : { copy: install }

const row = (r: Omit<SetupRow, 'level' | 'detail'> & { level?: SetupRow['level'], detail?: string | null }): SetupRow =>
  ({ detail: null, level: r.ok ? 'ok' : 'warn', ...r })

/** Derived each call, from the rows alone. See the plan: `unset` is an optional goal with nothing present. */
export function stateOf(required: boolean, rows: SetupRow[]): State {
  if (required && rows.some(r => r.level === 'error')) return 'error'
  if (!required && !rows.some(r => r.ok)) return 'unset'
  return rows.some(r => !r.ok) ? 'warn' : 'ok'
}

export async function setup({ home, has, versionOf, gitOf, auth, keys, env: live }: Options = {}): Promise<Setup> {
  const modules = await requiringModulesOnRegistry()
  // fli reads the global env into its own process; this API never does, so a key
  // set there reads as missing unless the file's values are laid under the env.
  const global  = Object.fromEntries((listGlobal(home === undefined ? {} : { home }) as Array<{ key: string, value: string }>)
    .filter(e => e.value).map(e => [e.key, e.value]))
  const report  = diagnose({
    root: process.cwd(), modules, home, env: { ...global, ...(live ?? process.env) },
    ...(has ? { has } : {}), ...(versionOf ? { versionOf } : {}), ...(gitOf ? { gitOf } : {}),
  } as never) as unknown as Doctor

  const byGoal = new Map<string, SetupRow[]>(GOALS.map((g: { id: string }) => [g.id, []]))
  const put = (goal: string, r: SetupRow) => (byGoal.get(goal) ?? byGoal.get('fli')!).push(r)

  for (const b of report.system) {
    put(b.for[0], row({
      id: `bin:${b.name}`, label: b.name, ok: b.ok, detail: b.status ?? (b.present ? 'found' : 'not found'),
      // A tool a required goal needs is a failure; one an optional goal needs is a warning.
      level: b.ok ? 'ok' : b.level === 'error' || (b.for[0] === 'claude') ? 'error' : 'warn',
      why: b.why, fix: b.ok ? null : installFix(b.install, b.why),
    }))
  }
  for (const i of report.identity) {
    put(i.for[0], row({ id: `identity:${i.label}`, label: i.label, ok: i.ok, detail: i.detail ?? null, why: i.why, fix: i.ok ? null : { copy: i.install } }))
  }
  for (const n of report.namespaces) {
    put(n.for[0], row({
      id: `env:${n.key}`, label: n.key, ok: n.ok, why: `${n.ns}: commands refuse without it`,
      fix: n.ok ? null : { go: '/settings/', label: `Set ${n.key} in Settings` },
    }))
  }
  for (const f of report.secrets) {
    put('fli', row({ id: `mode:${f.label}`, label: f.label, ok: f.ok, why: 'a file holding keys that others can read', fix: f.ok ? null : { go: '/laptop/#keys', label: 'Fix the mode on the Keys tab' } }))
  }

  // A cli service whose binary is already a binary row is the same fact; its login is the Services tab's Check.
  const binaries = new Set(report.system.map(b => b.name))
  const rows = catalog as unknown as CatalogRow[]
  for (const s of report.services) {
    const c = rows.find(r => r.id === s.id)!
    if (c.signIn.kind === 'cli' && binaries.has(c.signIn.bin ?? '')) continue
    // The first namespace a goal claims, so `workspace:publish` is Deploy's and not Run fli's.
    put(c.namespaces.map(n => goalOf(n.split(':')[0])).find((g: string) => g !== 'fli') ?? 'fli', row({
      id: `service:${s.id}`, label: s.name, ok: s.present, detail: s.present ? 'present' : 'not set up',
      why: `used by ${c.namespaces.join(', ') || 'fli'}`,
      fix: s.present ? null
        : c.vendor?.url ? { url: c.vendor.url, note: c.vendor.note ?? s.name }
        : { go: '/laptop/#services', label: 'See how on the Services tab' },
    }))
  }

  // What only Workbench knows, all under Use Claude in Workbench.
  const claude = report.system.find(b => b.name === 'claude')!
  if (claude.present) {
    const a = await (auth ?? (() => claudeAuthStatus(claudeProgram())))()
    const who = a.ok && a.value.loggedIn ? (a.value.email ?? a.value.authMethod ?? 'signed in') : null
    put('claude', row({
      id: 'claude:login', label: 'claude signed in', ok: Boolean(who), detail: who ?? (a.ok ? 'signed out' : a.reason),
      level: who ? 'ok' : 'error', why: 'the Claude Code tab needs a login to start a chat',
      fix: who ? null : { copy: 'claude auth login' },
    }))
  }
  const k = keys ?? { WORKBENCH_KEY: appEnv.WORKBENCH_KEY, ENCRYPTION_KEY: appEnv.ENCRYPTION_KEY }
  const dev = (id: string, label: string, isDev: boolean, why: string) => put('claude', row({
    id, label, ok: !isDev, detail: isDev ? 'still the dev default' : 'set', why,
    fix: isDev ? { copy: 'openssl rand -hex 32' } : null,
  }))
  dev('key:WORKBENCH_KEY', 'WORKBENCH_KEY', k.WORKBENCH_KEY === DEV_WORKBENCH_KEY, 'the door\'s pass-phrase; the dev default is public')
  dev('key:ENCRYPTION_KEY', 'ENCRYPTION_KEY', k.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY, 'encrypts what Claude wrote; the dev default is public')
  const p = ping({ home })
  put('claude', row({ id: 'ping', label: 'phone ping', ok: Boolean(p.topic), detail: p.topic ? 'on' : 'off', why: 'a buzz on your phone when Claude finishes a turn', fix: p.topic ? null : { go: '/settings/', label: 'Set a topic in Settings' } }))

  const goals = GOALS.map((g: { id: string, label: string, why: string, required: boolean }): SetupGoal => {
    const rows = byGoal.get(g.id) ?? []
    return { id: g.id, label: g.label, why: g.why, required: g.required, state: stateOf(g.required, rows), rows }
  })
  return { goals }
}
