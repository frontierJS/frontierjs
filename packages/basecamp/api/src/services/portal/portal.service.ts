// src/services/portal/portal.service.ts
// Window into every provider this app speaks to.
// Shows which adapters are wired, which are stubs, and live health status.
//
// **Ten, and they are two kinds.** Eight are self-hosted appliances an operator
// installs and points a URL at; `edge` and `cloudSpend` are somebody else's
// service reached with a token. `hosted` is what separates them, and it is here
// rather than on the screen because *unconfigured* means different work for
// each — install and set a URL, against open an account and hold a key.
//
// GET  /portal      → find (all adapters, no live pings — fast)
// GET  /portal/:id  → get  (one adapter, with live ping)
// POST /portal/:id  → ping (force health check, admin only) — dispatched
//                    by X-Service-Method: ping, not a /ping sub-path
//
// Graded by declared levels, since there is no model to carry a @@gate: the
// reads at READER (every workspace role) and ping at ADMINISTRATOR, on the
// ladder core/gate.ts maps roles onto. Junction enforces both and an agent's
// tool list reads both (FJS-D408).

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS }                  from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { edgeAccounts, edgeHealth } from '../edge/edge.service.ts'
import { edgeProviders }           from '../../providers/edge/index.ts'
import type { BasecampApp }        from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export type ServiceStatus = 'healthy' | 'degraded' | 'unreachable' | 'unconfigured'

export interface PortalEntry {
  id:          string
  name:        string
  description: string
  status:      ServiceStatus
  url:         string | null
  adapter:     string
  configured:  boolean
  hosted:      boolean
  checked_at:  number
}

type ProviderKey = keyof BasecampApp['providers']

const SERVICES: Array<{
  id:          ProviderKey | 'edge'
  name:        string
  description: string
  /** Where the adapter's setting is read. Absent for `edge`, which is a
   *  workspace ACCOUNT rather than configuration (`FJS-D558`). */
  config_key?: string
  ui_port?:    number
  /** Installed here, or somebody else's account. Absent means self-hosted —
   *  the eight that were here first, where a `ui_port` is a screen an operator
   *  can open. A hosted one has neither. */
  hosted?:     boolean
}> = [
  { id: 'secrets',       name: 'Infisical',  description: 'Secrets management',              config_key: 'providers.secrets.url',               ui_port: 8080 },
  { id: 'flags',         name: 'Unleash',    description: 'Feature flags',                   config_key: 'providers.flags.url',                 ui_port: 4242 },
  { id: 'search',        name: 'Typesense',  description: 'Full-text search',                config_key: 'providers.search.url',                ui_port: 8108 },
  { id: 'registry',      name: 'Zot',        description: 'Container image registry',        config_key: 'providers.registry.url',              ui_port: 5080 },
  { id: 'git',           name: 'Forgejo',    description: 'Git hosting',                     config_key: 'providers.git.url',                   ui_port: 3000 },
  { id: 'observability', name: 'Grafana',    description: 'Metrics, logs & traces',          config_key: 'providers.observability.grafana_url', ui_port: 3030 },
  { id: 'networking',    name: 'NetBird',    description: 'Private mesh networking',         config_key: 'providers.networking.url',            ui_port: 80   },
  { id: 'integrations',  name: 'Nango',      description: '3rd-party OAuth & integrations',  config_key: 'providers.integrations.nango_url',    ui_port: 3003 },

  // Hosted. No `ui_port` — there is no screen on this machine to open, and
  // what wires one is a token rather than a URL, which is why `url` reads null
  // for both of these even once they are wired.
  { id: 'edge',          name: 'Edge & DNS', description: 'Zones, records, TLS at the edge', hosted: true },
  { id: 'cloudSpend',    name: 'Cloud spend', description: 'What the provider is billing',   config_key: 'providers.cloud_spend.api_token',  hosted: true },
]

/**
 * The adapters a caller may name, for anything that stores one.
 *
 * A `service_health` widget holds a portal id in its config, and a widget
 * pointing at an adapter that does not exist is a card that can only ever say
 * "not found". The dashboards service validates against this rather than
 * keeping a second list, which is the same reason an API key's scopes are
 * derived from the service registry.
 */
export const PORTAL_SERVICE_IDS: string[] = SERVICES.map(s => s.id)

function getConfigValue(config: unknown, path: string): string | undefined {
  return path.split('.').reduce(
    (obj: unknown, key: string) => (obj as Record<string, unknown>)?.[key],
    config
  ) as string | undefined
}

function isStub(adapter: unknown): boolean {
  return (adapter as { constructor?: { name?: string } })?.constructor?.name?.startsWith('Stub') ?? true
}

async function pingAdapter(adapter: unknown): Promise<ServiceStatus> {
  if (!adapter || isStub(adapter)) return 'unconfigured'
  try {
    const ok = await (adapter as { ping?: () => Promise<boolean> }).ping?.()
    return ok ? 'healthy' : 'degraded'
  } catch {
    return 'unreachable'
  }
}

function buildEntry(svc: typeof SERVICES[0], adapter: unknown, status: ServiceStatus, config: unknown): PortalEntry {
  return {
    id:          svc.id,
    name:        svc.name,
    description: svc.description,
    status,
    url:         svc.config_key ? getConfigValue(config, svc.config_key) ?? null : null,
    adapter:     (adapter as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown',
    configured:  !isStub(adapter),
    hosted:      svc.hosted ?? false,
    checked_at:  Date.now(),
  }
}

/**
 * The `edge` entry, which is the workspace's edge ACCOUNTS and not an adapter
 * in `app.providers` (`FJS-D558`). Configured means this workspace holds one;
 * `adapter` names the vendors, so the portal reports what is really behind it.
 * `ping` asks each account's vendor, the way `pingAdapter` asks an appliance.
 */
async function edgeEntry(app: BasecampApp, svc: typeof SERVICES[0], ping: boolean): Promise<PortalEntry> {
  const accounts = await edgeAccounts()
  const labels   = new Map(edgeProviders().map(p => [p.kind, p.label]))
  const status: ServiceStatus = accounts.length === 0 ? 'unconfigured'
    : ping ? await edgeHealth(app, accounts) : 'healthy'
  return {
    id:          svc.id,
    name:        svc.name,
    description: svc.description,
    status,
    url:         null,
    adapter:     [...new Set(accounts.map(a => labels.get(a.providerKind) ?? a.providerKind))].join(', ') || 'none',
    configured:  accounts.length > 0,
    hosted:      true,
    checked_at:  Date.now(),
  }
}

/**
 * Whether a value can be an appliance id at all.
 *
 * `!id` is the guard everyone writes and it lets through the two values that
 * caused this: `'null'` and `'undefined'` are non-empty strings, which is what
 * a template literal produces from a variable that was not set.
 */
function isUsableId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id !== 'null' && id !== 'undefined'
}

export function createPortalService(app: BasecampApp) {
  return createService({
    name: 'portal',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
    methods: [
      { method: 'find', gate: LEVELS.READER },
      { method: 'get',  gate: LEVELS.READER },
      { method: 'ping', gate: LEVELS.ADMINISTRATOR },
    ],

    async find(_ctx: ServiceContext) {
      const entries = await Promise.all(SERVICES.map(svc => {
        if (svc.id === 'edge') return edgeEntry(app, svc, false)
        const adapter = app.providers[svc.id]
        return buildEntry(svc, adapter, isStub(adapter) ? 'unconfigured' : 'healthy', app.config)
      }))
      return { total: entries.length, limit: entries.length, offset: 0, data: entries }
    },

    async get() {
      // Two different failures wore one sentence. `$.id` is null when the call
      // carried no id at all, and the string 'null' when a caller interpolated
      // one, and `Portal service 'null' not found` was the answer to both — and
      // to an appliance that genuinely is not in the registry (`FJS-1018`). A
      // reader of the log could not tell *a screen is asking wrong* from *this
      // appliance is gone*, which is the difference between a bug in this app
      // and a configuration somebody removed.
      //
      // Separated by STATUS as well as wording: a value that is not an id is
      // the caller's mistake (400) and a real id nobody serves is a miss (404).
      // The string forms are checked because `!id` does not catch them — they
      // are what a template writes when the value it interpolated was empty.
      if (!isUsableId($.id))
        throw new BadRequest(
          `portal.get needs an appliance id and was given ${JSON.stringify($.id)}. ` +
          `A screen that reached here interpolated an empty value into a call or a URL.`)

      const svc = SERVICES.find(s => s.id === $.id)
      if (!svc) throw new NotFound(`Portal service '${$.id}' not found`)
      if (svc.id === 'edge') return edgeEntry(app, svc, true)

      const adapter = app.providers[svc.id]
      return buildEntry(svc, adapter, await pingAdapter(adapter), app.config)
    },

    async ping() {
      const id  = $.id as string
      // Same separation as get(): a ping is addressed to an appliance, so a
      // value that cannot be one is the caller's mistake rather than a miss.
      if (!isUsableId(id))
        throw new BadRequest(
          `portal ping needs an appliance id and was given ${JSON.stringify(id)}.`)
      const svc = SERVICES.find(s => s.id === id)
      if (!svc) throw new NotFound(`Portal service '${id}' not found`)
      if (svc.id === 'edge') {
        const entry = await edgeEntry(app, svc, true)
        app.logger.info(`Portal ping: ${svc.name}`, { status: entry.status })
        return entry
      }

      const adapter = app.providers[svc.id]
      const status  = await pingAdapter(adapter)
      app.logger.info(`Portal ping: ${svc.name}`, { status })
      return buildEntry(svc, adapter, status, app.config)
    },

    hooks: {
      before: {
        all: [sessionScope(app)],
      },
    },
  })
}
