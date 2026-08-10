// src/services/portal/portal.service.ts
// Window into all shared infrastructure adapters.
// Shows which adapters are wired, which are stubs, and live health status.
//
// GET  /portal      → find (all adapters, no live pings — fast)
// GET  /portal/:id  → get  (one adapter, with live ping)
// POST /portal/:id  → ping (force health check, admin only) — dispatched
//                    by X-Service-Method: ping, not a /ping sub-path

import { createService, NotFound } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole } from '../../core/hooks.ts'
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
  checked_at:  number
}

type InfraKey = keyof BasecampApp['infra']

const SERVICES: Array<{
  id:          InfraKey
  name:        string
  description: string
  config_key:  string
  ui_port?:    number
}> = [
  { id: 'secrets',       name: 'Infisical',  description: 'Secrets management',              config_key: 'infra.secrets.url',               ui_port: 8080 },
  { id: 'flags',         name: 'Unleash',    description: 'Feature flags',                   config_key: 'infra.flags.url',                 ui_port: 4242 },
  { id: 'search',        name: 'Typesense',  description: 'Full-text search',                config_key: 'infra.search.url',                ui_port: 8108 },
  { id: 'registry',      name: 'Zot',        description: 'Container image registry',        config_key: 'infra.registry.url',              ui_port: 5080 },
  { id: 'git',           name: 'Forgejo',    description: 'Git hosting',                     config_key: 'infra.git.url',                   ui_port: 3000 },
  { id: 'observability', name: 'Grafana',    description: 'Metrics, logs & traces',          config_key: 'infra.observability.grafana_url', ui_port: 3030 },
  { id: 'networking',    name: 'NetBird',    description: 'Private mesh networking',         config_key: 'infra.networking.url',            ui_port: 80   },
  { id: 'integrations',  name: 'Nango',      description: '3rd-party OAuth & integrations',  config_key: 'infra.integrations.nango_url',    ui_port: 3003 },
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
    url:         getConfigValue(config, svc.config_key) ?? null,
    adapter:     (adapter as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown',
    configured:  !isStub(adapter),
    checked_at:  Date.now(),
  }
}

export function createPortalService(app: BasecampApp) {
  return createService({
    name: 'portal',

    async find(_ctx: ServiceContext) {
      const entries = SERVICES.map(svc => {
        const adapter = app.infra[svc.id]
        return buildEntry(svc, adapter, isStub(adapter) ? 'unconfigured' : 'healthy', app.config)
      })
      return { total: entries.length, limit: entries.length, offset: 0, data: entries }
    },

    async get(ctx: ServiceContext) {
      const svc = SERVICES.find(s => s.id === ctx.id)
      if (!svc) throw new NotFound(`Portal service '${ctx.id}' not found`)

      const adapter = app.infra[svc.id as InfraKey]
      return buildEntry(svc, adapter, await pingAdapter(adapter), app.config)
    },

    async create(ctx: ServiceContext) {
      const id  = (ctx.data as Record<string, unknown>)?.id as string ?? ctx.id as string
      const svc = SERVICES.find(s => s.id === id)
      if (!svc) throw new NotFound(`Portal service '${id}' not found`)

      const adapter = app.infra[svc.id as InfraKey]
      const status  = await pingAdapter(adapter)
      app.logger.info(`Portal ping: ${svc.name}`, { status })
      return buildEntry(svc, adapter, status, app.config)
    },

    hooks: {
      before: {
        all: [
          sessionScope(app),
          (ctx: ServiceContext) => {
            if (ctx.method !== 'create') return
            const level = ({ viewer: 1, billing: 1, developer: 2, admin: 3, owner: 4 } as Record<string, number>)
              [ctx.locals.memberRole as string ?? ''] ?? 0
            if (level < 3) throw new NotFound('Not found')
          },
        ],
      },
    },
  })
}
