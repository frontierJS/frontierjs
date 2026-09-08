// src/core/app-model.ts
// One walk of a built app, for every register that renders one.
//
// Four tools already share `loadApp` — the awkward half of finding an app,
// running its startup phases and keeping the build's chatter off stdout. What
// they did not share is the WALK: each built its own shape out of the loaded
// app, so a fact could be computed twice and the two answers had nowhere to
// meet. That is fine while every register answers a question of its own, and
// stops being fine the moment one of them wants a column another already has:
// *which service does this job call*, or *what standing does this raw route
// reach the Data boundary at*, cannot be recovered from two independent walks
// except by matching names, and a join by name is a guess.
//
// So the model lives here and the tools render it. `describePrincipalRealm` is
// already in `core/litestone.ts` and stays there — this composes it rather than
// re-exporting it, because two import paths to one function is the thing the
// arrangement is trying to stop.

import { buildRoutes, serializeHookMap } from '../plugins/manifest/index.ts'
import { describePrincipalRealm }        from './litestone.ts'
import type { PrincipalRealm }           from './litestone.ts'
import type { App }                      from './app.ts'

// ─── the surface ──────────────────────────────────────────────────────────────

export interface SurfaceService {
  name:          string
  // Older spellings this service still answers to. A kebab FILENAME derives a
  // camel service name now (`FJS-570`), and the filename's own spelling stays
  // mounted — which is a fact about the wire and therefore belongs here.
  aliases:       string[]
  model:         string
  methods:       string[]
  customMethods: string[]
  /** The `type` in the seed each method's payload must satisfy, keyed by method. */
  inputs:        Record<string, string>
  channel:       string[]
  transactional: string[]
  softDelete:    string | null
  cache:         boolean
  idField:       string
  allowBulk:     boolean
  bulkMax:       number
  hooks:         Record<string, Record<string, string[]>>
}

export interface Surface {
  prefix:    string
  plugins:   string[]
  appHooks:  Record<string, Record<string, string[]>>
  services:  SurfaceService[]
  routes:    { method: string; path: string; kind: string }[]
}

export function describeSurface(app: App): Surface {
  const cfg = app.config as Record<string, unknown>

  const services = [...app.services.values()].map(svc => {
    const d = svc.describe()
    // `channel` is a service field rather than part of describe() — normalized
    // to a list because the declaration takes one name or several.
    const channel = svc.channel == null ? []
      : Array.isArray(svc.channel) ? [...svc.channel] as string[]
      : typeof svc.channel === 'string' ? [svc.channel]
      : ['(computed)']

    return {
      name:          d.name,
      aliases:       app.services.aliasesOf(d.name),
      model:         d.model,
      methods:       d.methods,
      customMethods: d.customMethods,
      inputs:        d.inputs ?? {},
      channel,
      transactional: d.transactional,
      softDelete:    d.softDelete,
      cache:         d.cache,
      idField:       d.idField,
      allowBulk:     d.allowBulk,
      bulkMax:       d.bulkMax,
      hooks:         serializeHookMap(d.hooks) as unknown as Record<string, Record<string, string[]>>,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  return {
    prefix:   (cfg.apiPrefix as string) ?? '',
    // `app._plugins` is already the names, in configure order.
    plugins:  [...(app._plugins ?? [])],
    appHooks: serializeHookMap(app._appHooks ?? {}) as unknown as Record<string, Record<string, string[]>>,
    services,
    routes:   buildRoutes(app),
  }
}

// ─── unattended work ──────────────────────────────────────────────────────────

export interface DurableJob {
  name:        string
  queue:       string
  cron:        string | null
  timeZone:    string | null
  maxAttempts: number
  retryDelay:  number[]
  /** `null` means no bound — a handler that never settles holds its slot (`FJS-295`). */
  timeout:     number | null
}

export interface InProcessTimer {
  id:   string
  type: 'interval' | 'cron' | 'once'
  expr: string
}

export interface JobsSurface {
  durable:   DurableJob[]
  timers:    InProcessTimer[]
  /** Absent means the app installed no queue at all — a different fact from an empty one. */
  hasQueue:  boolean
}

// Caravan is an OPTIONAL peer, so both registries are duck-typed rather than
// imported. An app with no queue is a legitimate app and must not fail here;
// what it must not do is render the same as an app whose queue is empty, which
// is why `hasQueue` is a field rather than an inference from `durable.length`.
export function describeJobs(app: App): JobsSurface {
  const jobs = (app as { jobs?: { registrations?: () => DurableJob[] } }).jobs
  const hasQueue = typeof jobs?.registrations === 'function'

  const durable = hasQueue ? jobs!.registrations!() : []

  const scheduler = (app as { scheduler?: { describe?: () => InProcessTimer[] } }).scheduler
  const timers = typeof scheduler?.describe === 'function' ? scheduler.describe() : []

  return { durable, timers, hasQueue }
}

// ─── what an app can tell somebody ────────────────────────────────────────────

export interface DeclaredNotification {
  /** The string written to `notifications.type` and read back by the browser. */
  type:       string
  /** Transports it can format for, in declaration order. */
  transports: string[]
}

export interface NotificationsSurface {
  declared: DeclaredNotification[]
  /** Absent means the plugin was never configured — not the same as configured
   *  and empty, and the reason this is a field rather than `declared.length`. */
  installed: boolean
}

type NotificationRegistry = ReadonlyMap<string, { type?: string; transports?: readonly string[] }>

export function describeNotifications(app: App): NotificationsSurface {
  const reg = (app as { notifications?: NotificationRegistry }).notifications
  const installed = !!reg && typeof reg.forEach === 'function'

  if (!installed) return { declared: [], installed: false }

  const declared: DeclaredNotification[] = []
  for (const [key, f] of reg!) {
    declared.push({
      // The map is keyed by the type, and the factory carries it too. Reading
      // the key means a registry built by anything is describable here.
      type:       f?.type ?? key,
      transports: [...(f?.transports ?? [])],
    })
  }

  // Sorted, because the loader walks the directory and the file system's order
  // is not a fact about the app. A committed file whose rows move when nothing
  // changed is a diff nobody can read.
  declared.sort((a, b) => a.type.localeCompare(b.type))
  return { declared, installed: true }
}

// ─── the composed model ───────────────────────────────────────────────────────

export interface AppModel {
  surface:       Surface
  principal:     PrincipalRealm | null
  jobs:          JobsSurface
  notifications: NotificationsSurface
}

/**
 * Everything a register asks of a built app, computed once.
 *
 * `principal` is null for an app that declares no tenancy and installs no
 * resolver, which is a real answer rather than a missing one — the renderer
 * says so in words.
 */
export function describeAppModel(app: App): AppModel {
  return {
    surface:       describeSurface(app),
    principal:     describePrincipalRealm(app, (app as unknown as { db?: unknown }).db),
    jobs:          describeJobs(app),
    notifications: describeNotifications(app),
  }
}
