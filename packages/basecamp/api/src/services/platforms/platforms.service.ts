// src/services/platforms/platforms.service.ts
// What a workspace's vendor accounts run without a machine, and taking one of
// them on as an App (`IDEAS/app-platforms.md` Phase 1).
//
// GET /platforms dispatches on X-Service-Method, collection-level:
//   projects  every platform account this workspace holds, each vendor account
//             its token opens, and what runs there, with the App that adopted it
//   adopt     one project made an App and its AppPlatform, in one transaction
//
// ─── Read at READER, written at the Secret's 5 ───────────────────────────
//
// `projects` is graded as `edge.zones` is, and its account lookup is
// `asSystem()` confined by the `where` for the reason edge.service.ts gives.
// `adopt` is ADMINISTRATOR, which is `AppPlatform`'s write gate: the row binds
// an App to a token, and the App and the row are written on the caller's own
// client so the schema grades both.
//
// A vendor's refusal is a 502 carrying its message; in `projects` it is caught
// per account, so one revoked token does not blank the others.

import { createService, NotFound, BadRequest, BadGateway, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                 from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, slugify }        from '../../core/resource.ts'
import { platformConnectorFor, platformProviders } from '../../providers/platform/index.ts'
import { targetFor }              from '../../providers/compute/index.ts'
import { sendVia }                from '../../providers/compute/accounts.ts'
import { keyScope }               from '../../domain/api-key/scopes.ts'
import type { PlatformProject }   from '../../providers/platform/index.ts'
import type { PlatformProvider }  from '#db/schema.d.ts'

interface PlatformAccountRow {
  id:           string
  name:         string
  providerKind: PlatformProvider
  verifiedAt:   string | null
}

const why = (err: unknown) => err instanceof Error ? err.message : String(err)

/** This workspace's `provider_key` Secrets at a vendor that runs Apps. */
async function platformAccounts(): Promise<PlatformAccountRow[]> {
  const kinds = platformProviders().map(p => p.kind)
  return await db().asSystem().secret.findMany({
    where:   { workspaceId: ws(), kind: 'provider_key', providerKind: { in: kinds } },
    select:  { id: true, name: true, providerKind: true, verifiedAt: true },
    orderBy: { name: 'asc' },
  }) as PlatformAccountRow[]
}

const sendFor = (a: PlatformAccountRow) => {
  const connector = platformConnectorFor(a.providerKind)!
  return { connector, send: sendVia($.app, targetFor(connector.kind, a.id)) }
}

const field = (data: Record<string, unknown>, key: string, what: string): string => {
  const v = data[key]
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`${key} is required — ${what}`)
  return v.trim()
}

export default createService({
  name: 'platforms',
  scope: keyScope('platforms'),
  reservedQuery: [...WORKSPACE_QUERY],

  // `methods:` for infra.service.ts's reason: a modelless service otherwise
  // answers every CRUD verb it was never given.
  methods: [
    { method: 'projects', gate: LEVELS.READER },
    { method: 'adopt',    gate: LEVELS.ADMINISTRATOR },
  ],

  // ── projects ───────────────────────────────────────────────────────
  //
  // Each account carries `vendors` OR `error`, never an empty list standing in
  // for a refusal. `appId` on a project is the App that adopted it, so a
  // picker never offers one twice.
  async projects() {
    const [accounts, adopted] = await Promise.all([
      platformAccounts(),
      db().appPlatform.findMany({
        where:  { workspaceId: ws() },
        select: { appId: true, provider: true, providerAccountId: true, name: true },
      }) as Promise<{ appId: string; provider: string; providerAccountId: string; name: string }[]>,
    ])
    // By the vendor's account and not the Secret: two keys to one account see
    // one Worker.
    const owner = (provider: string, vendor: string, name: string) =>
      adopted.find(r => r.provider === provider && r.providerAccountId === vendor && r.name === name)?.appId ?? null

    const out = await Promise.all(accounts.map(async a => {
      const { connector, send } = sendFor(a)
      try {
        const vendors = await Promise.all((await connector.accounts(send)).map(async v => ({
          ...v,
          projects: (await connector.projects(send, v.id))
            .map(p => ({ ...p, appId: owner(a.providerKind, v.id, p.name) })),
        })))
        return { ...a, label: connector.label, vendors, error: null }
      } catch (err) {
        return { ...a, label: connector.label, vendors: null, error: why(err) }
      }
    }))
    return { accounts: out }
  },

  // ── adopt ──────────────────────────────────────────────────────────
  //
  // `{ accountId, providerAccountId, name, environmentId }` — the Secret, the
  // vendor account it opens, the project's name there, and where the App
  // lives. A site becomes a `static` App and anything with code a `worker`.
  // Every refusal is decided before anything is written. The App starts
  // `unknown` with no source: what serves and what shipped it are the vendor's
  // to say, and `platform:observe` is what reads them.
  async adopt() {
    const data          = ($.data ?? {}) as Record<string, unknown>
    const accountId     = field(data, 'accountId', 'which platform account to read')
    const vendor        = field(data, 'providerAccountId', 'which account at the vendor the project is in')
    const name          = field(data, 'name', "the project's name at the vendor")
    const environmentId = field(data, 'environmentId', 'which environment the App joins')

    const account = (await platformAccounts()).find(a => a.id === accountId)
    if (!account) throw new NotFound(`Platform account '${accountId}' not found`)

    const environment = await db().environment.findFirst({ where: { id: environmentId, workspaceId: ws() }, select: { id: true } })
    if (!environment) throw new NotFound(`Environment '${environmentId}' not found`)

    const taken = await db().appPlatform.findFirst({
      where:  { workspaceId: ws(), provider: account.providerKind, providerAccountId: vendor, name },
      select: { appId: true },
    }) as { appId: string } | null
    if (taken) throw new Conflict(`${name} is already App '${taken.appId}'`)

    const { connector, send } = sendFor(account)
    let project: PlatformProject | null
    try {
      project = await connector.project(send, vendor, name)
    } catch (err) {
      throw new BadGateway(why(err))
    }
    if (!project) throw new NotFound(`${connector.label} account '${vendor}' runs nothing named '${name}'`)

    const slug = slugify(project.name)
    if (!slug) throw new BadRequest(`'${project.name}' has no character an App slug can hold`)
    const clash = await db().app.findFirst({ where: { environmentId, slug }, select: { id: true } })
    if (clash) throw new Conflict(`This environment already has an App '${slug}' — adopt into another environment, or rename that App's slug`)

    return await db().$transaction(async (tx: any) => {
      const app = await tx.app.create({ data: {
        environmentId, name: project.name, slug, type: project.kind === 'site' ? 'static' : 'worker',
      } })
      const platform = await tx.appPlatform.create({ data: {
        appId: app.id, accountId, provider: account.providerKind, providerAccountId: vendor, name: project.name,
      } })
      return { app, platform }
    })
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
