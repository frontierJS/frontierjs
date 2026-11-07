---
id: shared-servers
status: proposed
dated: 2026-11-07
---

# Idea — one server, more than one workspace

**Status: PROPOSED. Q1 open, recommend A (no change); Q2 waits on Q1.**
Probed against the tree 2026-11-07. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-07): ELA could not go in its own workspace `ela` on chartered's
server (`fjs-prototypes/ela/docs/deploy-chartered.md` § Fork 2026-11-07, ruled R9 = put it in
workspace `chartered` as its own project). Why not let two workspaces share a server?

## What exists (probed 2026-11-07)

- **A Server has one workspace because of row tenancy, not because of a ruling.** `model Server`
  carries a required `workspaceId`, and Basecamp scopes rows by
  `tenancy { strategy row column workspaceId claim workspaceId }` (`packages/basecamp/db/schema.lite`).
  No `DECISIONS.md` row weighs sharing. The nearest text is `IDEAS/deploy-plane.md`'s
  "Workspace-scoped is the same tenancy every other `Server` already has".
- **Placement refuses a server from another workspace.** `placeableServer`
  (`packages/basecamp/api/src/services/apps/apps.service.ts:116`) looks the server up with
  `{ id, workspaceId: ws() }` and answers *Server '…' not found in this workspace*. The join it
  writes, `AppServer`, is `@@gate(2.8)` and assumes the caller can already see both the App and
  the Server under one claim. `packages/basecamp/CLAUDE.md` grades `Server` on TWO axes, the
  gate and the workspace.
- **An Outpost enrolls once**, against one Basecamp and one `Server` row, so a second workspace
  cannot enroll the same box as a server of its own.
- **There is an Account above workspaces.** `model Workspace` has an `@immutable accountId`, so
  "every workspace of one Account" is something the schema can already express.
- **Whoever can deploy to a box can read everything on it.** Outpost runs as root with the Docker
  socket. An App's Variables and Secrets arrive on the box as container env, and a `bind` Volume
  is a host path (`FJS-D1615`). A guest's container can mount the owner's data directories, and
  the owner has root over the guest's secrets. A per-workspace split on one box separates what
  each workspace sees in the UI, not what each can reach on the machine.
- **The machine controls need one owner.** `providerSecretId` is one workspace's cloud token,
  and `sync`/`destroy`/reboot spend it (`FJS-3845` closed the hole of pointing a machine at
  another workspace's token). The SSH key check (`sshKeyId`), posture, heartbeats and alert
  paging all report to one workspace.

## Prior art

- **Coolify v4: one team per server, sharing refused.** A maintainer: teams are "not supposed to
  share the same server" until there are safeguards so "Team A can't access and alter the
  deployments of Team B"; it is on the v5 roadmap
  ([#1820](https://github.com/coollabsio/coolify/discussions/1820),
  [#3235](https://github.com/coollabsio/coolify/discussions/3235)). Ownership is one column,
  `servers.team_id`, the same shape as ours; a commenter notes sharing needs a many-to-many
  connector table ([#2029](https://github.com/coollabsio/coolify/discussions/2029)). Adding the
  same box to two teams sets up a second proxy, the same failure our one-enrollment rule prevents.
- **A May 2026 Coolify request makes a guest a sandbox**: a "Share This Server Safely" wizard
  creates a separate team, its own Docker network, CPU/memory limits and no SSH
  ([#10455](https://github.com/coollabsio/coolify/discussions/10455)). That is Q2's option B.
- **Laravel Forge shared servers by grant, one owner keeping the machine.** Circles let an owner
  share chosen servers with collaborators, with per-permission control (delete, transfer, see
  env files) ([Forge: Circle Permissions](https://blog.laravel.com/forge-circle-permissions),
  [Collaborate with Circles](https://forge.laravel.com/features/circles)). Circles were later
  replaced by Organizations with Teams inside them, which is close to our Account → Workspace
  shape.
- **Kubernetes calls this soft multi-tenancy.** Namespaces on shared nodes are only for tenants
  that trust each other. Hostile tenants get sandboxed runtimes or dedicated nodes, and
  `hostPath` is forbidden to tenants because it reaches the node
  ([CNCF](https://www.cncf.io/blog/2022/11/09/multi-tenancy-in-kubernetes-implementation-and-optimization/),
  [Sysdig](https://www.sysdig.com/blog/multi-tenant-isolation-boundaries-kubernetes)). Our `bind`
  Volume is that `hostPath`.

## Open questions

- **Q1 — Can a Server take Apps from more than one workspace?**
  - **A** — No. A server belongs to one workspace, and co-tenants that trust each other are one
    workspace with a project each (what ELA's R9 did). Nothing to build. This paper is the
    record of why.
  - **B** — Owner and grant (Forge's Circles). The server stays in one workspace, and that
    workspace grants another workspace the right to place Apps on it. The owner keeps the
    token, reboot/destroy, posture and alerts. The grant screen says the owner's root can read
    the guest's secrets and data. Adds a noun (a grant row between `Server` and `Workspace`),
    and `placeableServer` and the `AppServer` gate both have to decide which workspace's claim
    grades the pair.
  - **C** — Account-level servers (ELA fork option C). Any workspace in the server's Account may
    place on it. No per-pair grant: the Account is the trust boundary. Every `Server` lookup
    scoped `workspaceId: ws()` widens to the Account, and the Server's alerts and posture need a
    home that is not one workspace.
  - **D** — Co-ownership (Coolify's v5 direction): a many-to-many join, and every workspace in it
    is an owner. Two owners of one cloud token and one reboot button.
  - **Recommend A** — The case that came up, ELA beside chartered, is one owner's two apps,
    and a project inside one workspace already covers that with nothing built. B and C each
    make a cross-workspace read possible by construction, and the only thing standing in for a
    test would be a sentence on a consent screen. Reopen B when all three are true: (1) a
    workspace whose members the server owner does not control asks for room on the owner's
    box, (2) it is settled which workspace's claim grades an `AppServer`, and (3) Q2 is answered.
    Prefer B over C on reopening: a grant is per pair and revocable, and Forge moved from
    Circles to Organizations only because it had billing per Organization, which our Account
    already is. D gives one machine two owners of its token and its reboot button.

- **Q2 — If Q1 reopens, is a guest protected from other guests?** Only asked after Q1 = B or C.
  - **A** — No. The guest trusts the owner and every other guest, and the grant screen says so.
  - **B** — Sandbox the guest (Coolify #10455): its own Docker network, CPU/memory limits, no
    `bind` Volumes, no SSH. Outpost refuses a guest's App that asks for a host path. A guest is
    still not protected from the owner, who has root.
  - **C** — Separate machines. A guest that needs protecting gets a server of its own, which is Q1 = A.
  - **No recommendation until Q1 reopens.** B is Outpost work with its own drive (a guest's
    container cannot read the owner's data directory), and is a plan of its own.

## Plan

Only if Q1 is answered B or C.

### Phase 0 — Count the seam

Goal: know how many call sites assume one workspace per server.
Done when: the list is written here with paths.

- [ ] 0.1 List every `server.find*`/`exists` scoped `workspaceId: ws()` in
  `packages/basecamp/api/src` (34 `server.*` lookups on 2026-11-07, not yet sorted by scope).
- [ ] 0.2 Write the ruling for which claim grades `AppServer`, and the Q2 answer, into `DECISIONS.md`.
