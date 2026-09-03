// src/services/infra/infra.service.ts
// The two reads in this app that are not a table.
//
// Both are the same shape of question — *what does this workspace look like
// right now* — answered by walking several accessors and returning one object.
// Neither is a model, so neither could be a CRUD service, and both were the
// last two screens left blocked in docs/SCREENS.md for exactly that reason.
//
// GET /infra dispatches on X-Service-Method, collection-level:
//   graph        servers, apps, networks and domains as nodes and edges
//   onboarding   the six setup questions, each answered by a count
//
// ─── Why one service for two reads ────────────────────────────────────────
//
// They share a property nothing else here has: the answer is assembled from
// models the caller can already read, and storing it would be a second answer
// that goes stale. `Onboarding` gets no model for that reason (SCREENS.md
// § Phase 11) and a graph projection is the same argument about edges — an
// AppServer row IS the edge, and a cached graph is a copy of it.
//
// ─── What a browser cannot do instead ─────────────────────────────────────
//
// `apps.find` answers the environment and the domains; WHERE an app runs is
// only on `apps.get`, one request per app. So the graph from a browser is
// 1 + N requests that each open a transaction, and it still cannot count the
// memberships the onboarding read needs. One read here is one round trip.

import { createService, $ } from '@frontierjs/junction'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws } from '../../core/resource.ts'
import type { BasecampApp } from '../../basecamp.types.ts'

/** The ceiling on any one kind of node. A fleet past this is a graph nobody
 *  can read anyway, and the answer says it was cut rather than looking whole. */
const MAX_NODES = 300

type Node = {
  id:      string
  kind:    'domain' | 'server' | 'app' | 'network'
  ref:     string                    // the row's own id, for a link off the screen
  label:   string
  sub:     string | null
  status:  string | null
}

type Edge = {
  id:    string
  src:   string
  tgt:   string
  kind:  'traffic' | 'host' | 'peer' | 'attach'
  label: string
}

export function createInfraService(app: BasecampApp) {
  return createService({
    name: 'infra',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // `methods:` and not the scan: without it the base service answers every
    // CRUD verb it was never given, and on a service with no model that is a
    // 500 rather than a refusal (hub.service.ts says the same thing).
    methods: ['graph', 'onboarding'],

    // ── graph — the fleet as nodes and edges ──────────────────────────
    //
    // Four node kinds and four edge kinds, and every one of them is a row
    // somebody already made:
    //
    //   Domain  → App     traffic   the hostname that resolves here
    //   Server  → App     host      an AppServer replica placement
    //   Network → Server  peer      a ServerNetwork membership
    //   Network → App     attach    an AppNetwork membership
    //
    // What is deliberately NOT here: app-to-app dependency (nothing records
    // which app talks to which), the internet and the CDN in front of it
    // (neither is a row), and live traffic (nothing samples it). The screen
    // says so rather than drawing a picture the database cannot support.
    async graph() {
      $.dispatch = false   // read-shaped

      const [servers, apps, networks, domains] = await Promise.all([
        db().server.findMany({ where: { workspaceId: ws() }, orderBy: { name: 'asc' },     limit: MAX_NODES }),
        db().app.findMany({    where: { workspaceId: ws() }, orderBy: { name: 'asc' },     limit: MAX_NODES, include: { environment: true } }),
        db().network.findMany({ where: { workspaceId: ws() }, orderBy: { name: 'asc' },    limit: MAX_NODES }),
        db().domain.findMany({ where: { workspaceId: ws() }, orderBy: { hostname: 'asc' }, limit: MAX_NODES }),
      ])

      const appIds    = apps.map((a: { id: string }) => a.id)
      const serverIds = servers.map((s: { id: string }) => s.id)

      // The join rows carry no workspaceId of their own — they are scoped
      // through their parent by the tenancy desugar. Naming the ids we already
      // read is not a second guard, it is the only way to keep an edge whose
      // other end was cut by MAX_NODES out of the answer.
      const [placements, peers, attachments] = await Promise.all([
        appIds.length    ? db().appServer.findMany({     where: { appId:    { in: appIds } },    limit: MAX_NODES * 4 }) : [],
        serverIds.length ? db().serverNetwork.findMany({ where: { serverId: { in: serverIds } }, limit: MAX_NODES * 4 }) : [],
        appIds.length    ? db().appNetwork.findMany({    where: { appId:    { in: appIds } },    limit: MAX_NODES * 4 }) : [],
      ])

      const nodes: Node[] = [
        ...domains.map((d: Record<string, any>): Node => ({
          id: `dom:${d.id}`, kind: 'domain', ref: d.id,
          label: d.hostname,
          sub:   d.proxied ? 'proxied' : 'direct',
          status: d.isPrimary ? 'primary' : null,
        })),
        ...servers.map((s: Record<string, any>): Node => ({
          id: `srv:${s.id}`, kind: 'server', ref: s.id,
          label: s.name,
          sub:   `${s.role} · ${s.region}`,
          status: s.status,
        })),
        ...apps.map((a: Record<string, any>): Node => ({
          id: `app:${a.id}`, kind: 'app', ref: a.id,
          label: a.name,
          sub:   a.environment?.name ?? a.type,
          status: a.status,
        })),
        ...networks.map((n: Record<string, any>): Node => ({
          id: `net:${n.id}`, kind: 'network', ref: n.id,
          label: n.name,
          sub:   n.cidr,
          status: null,
        })),
      ]

      const present = new Set(nodes.map(n => n.id))
      const has     = (a: string, b: string) => present.has(a) && present.has(b)

      const edges: Edge[] = [
        ...domains
          .filter((d: Record<string, any>) => has(`dom:${d.id}`, `app:${d.appId}`))
          .map((d: Record<string, any>): Edge => ({
            id: `e-dom-${d.id}`, src: `dom:${d.id}`, tgt: `app:${d.appId}`,
            kind: 'traffic', label: d.port === 443 ? 'https' : `:${d.port}`,
          })),
        ...placements
          .filter((p: Record<string, any>) => has(`srv:${p.serverId}`, `app:${p.appId}`))
          .map((p: Record<string, any>): Edge => ({
            id: `e-run-${p.id}`, src: `srv:${p.serverId}`, tgt: `app:${p.appId}`,
            kind: 'host', label: p.replicaIndex > 0 ? `replica ${p.replicaIndex}` : 'runs',
          })),
        ...peers
          .filter((p: Record<string, any>) => has(`net:${p.networkId}`, `srv:${p.serverId}`))
          .map((p: Record<string, any>): Edge => ({
            id: `e-peer-${p.id}`, src: `net:${p.networkId}`, tgt: `srv:${p.serverId}`,
            kind: 'peer', label: p.ipAddress ?? 'peer',
          })),
        ...attachments
          .filter((a: Record<string, any>) => has(`net:${a.networkId}`, `app:${a.appId}`))
          .map((a: Record<string, any>): Edge => ({
            id: `e-att-${a.id}`, src: `net:${a.networkId}`, tgt: `app:${a.appId}`,
            kind: 'attach', label: a.dnsName ?? 'attached',
          })),
      ]

      return {
        nodes,
        edges,
        counts: {
          domains:  domains.length,
          servers:  servers.length,
          apps:     apps.length,
          networks: networks.length,
          edges:    edges.length,
        },
        // Stated rather than left to be noticed. A graph missing a tier looks
        // exactly like a workspace that does not have one.
        truncated: [
          domains.length  >= MAX_NODES ? 'domains'  : null,
          servers.length  >= MAX_NODES ? 'servers'  : null,
          apps.length     >= MAX_NODES ? 'apps'     : null,
          networks.length >= MAX_NODES ? 'networks' : null,
        ].filter(Boolean),
        limit: MAX_NODES,
      }
    },

    // ── onboarding — six questions the database already answers ───────
    //
    // No `done` column anywhere, which is the ruling SCREENS.md § Phase 11
    // records: a stored flag is a second answer that survives the thing it
    // recorded being deleted. Every step here is a count taken now.
    async onboarding() {
      $.dispatch = false   // read-shaped

      // Three of the six cannot be counted through the caller's own client,
      // and the answer would not be 0 — it would be a refusal. `Secret` and
      // `Invitation` are @@gate("5"), so a developer asking *does this
      // workspace have an SSH key* throws; `WorkspaceMember` reads only the
      // caller's OWN rows (@@allow('read', userId == auth().id)), so the
      // count is 1 for everybody. What crosses is a COUNT of rows in the
      // workspace the caller is already in, never a row — the screen this
      // feeds is the one a new viewer opens first.
      // `any` for the reason every sibling service says it: Litestone's
      // accessors exist at runtime and junction's client type declares none.
      const sys: any = $.db.asSystem()

      const [servers, sshKeys, projects, deploys, members, invites] = await Promise.all([
        db().server.count({     where: { workspaceId: ws() } }),
        sys.secret.count({      where: { workspaceId: ws(), kind: 'ssh_key' } }),
        db().project.count({    where: { workspaceId: ws() } }),
        db().deployment.count({ where: { workspaceId: ws() } }),
        sys.workspaceMember.count({ where: { workspaceId: ws() } }),
        sys.invitation.count({     where: { workspaceId: ws() } }),
      ])

      // The order is the order somebody does them in, and it is what the
      // screen renders — a step list that sorts itself differently from the
      // work is worse than no order at all.
      const steps = [
        { id: 'workspace', title: 'Create a workspace',   href: null,               done: true,
          detail: 'You are in one.' },
        { id: 'server',    title: 'Add your first server', href: '/servers/create/', done: servers > 0,
          detail: 'Provision or import a machine into the fleet.' },
        { id: 'ssh-key',   title: 'Add an SSH key',        href: '/secrets/',        done: sshKeys > 0,
          detail: 'A key to install on the machines you add.' },
        { id: 'project',   title: 'Create a project',      href: '/projects/create/', done: projects > 0,
          detail: 'Apps and environments live inside one.' },
        { id: 'deploy',    title: 'Deploy an app',         href: '/projects/',       done: deploys > 0,
          detail: 'Point an image at an environment and release it.' },
        { id: 'team',      title: 'Invite a teammate',     href: '/admin/',          done: members > 1 || invites > 0,
          detail: 'A developer, an admin or a viewer.' },
      ]

      return {
        steps,
        done:  steps.filter(s => s.done).length,
        total: steps.length,
        // The counts the answers came from. A step that reads *done* against a
        // fleet of zero is a bug worth being able to see from the screen.
        counts: { servers, sshKeys, projects, deploys, members, invites },
      }
    },

    hooks: {
      before: {
        all: [sessionScope(app)],
      },
    },
  })
}
