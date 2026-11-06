// src/domain/release/fronting.ts — the static Apps in front of an API App.
//
// An API split from web/ is reached through a Domain on a static App and the
// routes back to the API (`FJS-D1547`), so the static App is released beside
// it: by `fli deploy`, which reads the list off the App's detail, and by the
// API's own git release, which builds web/ for it (`FJS-D1979`). One rule for
// both (`FJS-D1981`), because they read the same rows.

import { isInline } from './app-source.ts'

type DomainLike = { id: string; hostname?: string }
type AppLike    = { id: string; name?: string; slug?: string; source?: unknown; domains?: DomainLike[] }
type RouteLike  = { domainId: string; appId: string }

/**
 * One entry per Domain of a static App in `app`'s environment. A Domain
 * routed to another App is that App's front door, not this one's.
 */
export function frontingStatics({ app, siblings, routes }: { app: { id: string }; siblings: AppLike[]; routes: RouteLike[] }) {
  const statics = siblings.filter(s => s.id !== app.id && isInline(s.source))
  return statics.flatMap(s => (s.domains ?? [])
    .filter(d => !routes.some(r => r.domainId === d.id && r.appId !== app.id))
    .map(d => ({ app: s, domain: d })))
}

export type Front = { id: string; name: string; slug: string; domains: Array<{ id: string; hostname: string }> }

/** Each static App in front of `app` once, with the Domains that front it. */
export async function frontsOf(db: any, app: { id: string; environmentId: string }): Promise<Front[]> {
  const siblings = await db.app.findMany({ where: { environmentId: app.environmentId }, include: { domains: true } }) as AppLike[]
  const domainIds = siblings.filter(s => s.id !== app.id).flatMap(s => (s.domains ?? []).map(d => d.id))
  const routes = domainIds.length
    ? await db.domainRoute.findMany({ where: { domainId: { in: domainIds } }, select: { domainId: true, appId: true } }) as RouteLike[]
    : []
  const fronts = new Map<string, Front>()
  for (const { app: s, domain: d } of frontingStatics({ app, siblings, routes })) {
    const front = fronts.get(s.id) ?? { id: s.id, name: String(s.name ?? ''), slug: String(s.slug ?? ''), domains: [] }
    front.domains.push({ id: d.id, hostname: String(d.hostname ?? '') })
    fronts.set(s.id, front)
  }
  return [...fronts.values()]
}
