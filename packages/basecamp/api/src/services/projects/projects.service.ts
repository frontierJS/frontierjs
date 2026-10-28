// src/services/projects/projects.service.ts
// Projects — the unit a workspace organizes environments under.
//
// Mounted at /projects. Zero raw SQL: every read and write goes through the
// caller-scoped Litestone client on $.db.
//
// Custom method, `POST /projects` with `X-Service-Method`:
//   fromRepo — a project, its production environment and one App built from a
//              repository, made together (FJS-D1555)
//
// The hand-written CreateProjectSchema/PatchProjectSchema are gone.
// `model: 'Project'` derives validation from db/schema.lite, so the field
// rules live in one place instead of two that drift — `name` was capped at 80
// in both, but only the schema knew `slug` had to be unique per workspace.

import { randomBytes } from 'node:crypto'
import { createService, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, deriveSlug, narrowPatch, changesNothing, slugify }
  from '../../core/resource.ts'
import { retireAppsIn, placeableServer, placeApp, mintDeployKey, enablePushOn, connectableAccounts, connectRepository,
         readForgeDockerfile }
  from '../apps/apps.service.ts'
import { toZone }               from '../domains/domains.service.ts'
import { syncReplicasOf }       from '../../jobs/replicate-sync.job.ts'
import { parseAppSource }       from '../../domain/release/app-source.ts'
import { forgeRepo }            from '../../domain/release/dockerfile-template.ts'
import { keyScope }             from '../../domain/api-key/scopes.ts'
import { exposedPort }          from '@frontierjs/outpost/dockerfile'

type FromRepo = {
  name: string, slug?: string, repo: string, branch?: string, dockerfile?: string,
  serverId?: string, hostname?: string, deployOnPush?: boolean, connect?: boolean,
}

export default createService({
  name:  'projects',
  scope: keyScope('projects'),
  model: 'Project',
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
  // The whole surface: a service gaining `input:` lists every verb it answers.
  methods: [
    'find', 'get', 'aggregate', 'create', 'update', 'patch', 'remove', 'restore',
    // A project's create level; the rows it makes past that are each graded
    // at the Data boundary, so a hostname needs the level that adds a Domain.
    { method: 'fromRepo', gate: LEVELS.USER, input: 'ProjectFromRepo' },
  ],

  async find() {
    const { limit, offset } = getPagination()
    const status = $.query.status as string | undefined
    return findScoped('project', { where: status ? { status } : {}, limit, offset })
  },

  get: () => getScoped('project', 'Project'),

  async create() {
    const data = $.data as Record<string, unknown>
    return db().project.create({ data })
  },

  async patch() {
    await getScoped('project', 'Project')
    // slug is immutable: it is half of the @@unique([workspaceId, slug]) key
    // and appears in URLs the UI has already handed out.
    const patch = narrowPatch($.data as Record<string, unknown>)
    if (changesNothing(patch)) return getScoped('project', 'Project')
    return db().project.update({ where: { id: $.id as string }, data: patch })
  },

  async remove() {
    // @@softDelete(cascade) on Project — this also stamps its Environments,
    // and through them their Apps and Jobs. That cascade is why archiving a
    // project cannot leave live rows behind; it tells no machine, so the
    // Apps are retired first.
    const project = await getScoped('project', 'Project')
    const envs    = await db().environment.findMany({ where: { projectId: project.id }, select: { id: true } })
    const apps    = await retireAppsIn($.app, envs.map((e: { id: string }) => e.id))
    const removed = await removeScoped('project', 'Project')
    await syncReplicasOf($.app, apps.map(a => a.id))
    return { ...removed, apps }
  },

  // ── fromRepo — POST /projects  X-Service-Method: fromRepo ────────
  //
  // Five kinds of row in one transaction: a project with a machine-built App
  // and no variables is an App whose first release starts a container with
  // its database inside it and no ENCRYPTION_KEY. What leaves the process —
  // the forge read, the zone push, the placement's replica sync, the deploy
  // key — happens outside it, the forge read before so a slow forge holds no
  // write lock, the rest after so a rollback has told no machine anything.
  async fromRepo() {
    const data = $.data as FromRepo
    const name = data.name.trim()
    const slug = data.slug?.trim() || slugify(name)
    if (!slug) throw new BadRequest(`'${name}' makes no slug — name one`)

    const server = data.serverId ? await placeableServer(data.serverId) : null
    const hostname = data.hostname?.trim().toLowerCase() || null
    if (hostname && await db().domain.exists({ where: { hostname } }))
      throw new Conflict(`'${hostname}' is already an App's hostname in this workspace`)

    // Everything a connect can be refused for is asked before a row exists:
    // the deploy key is the machine's, so it needs a server, and a token the
    // forge no longer accepts is refused here rather than after the App is made.
    const at = data.connect ? forgeRepo(data.repo) : null
    let accounts: Awaited<ReturnType<typeof connectableAccounts>> = []
    if (data.connect) {
      if (!server) throw new BadRequest('connect needs a server — the deploy key is the machine\'s')
      if (at?.forge !== 'github') throw new BadRequest(`connect writes to GitHub, and '${data.repo}' is not a GitHub repository`)
      accounts = await connectableAccounts($.app, 'github')
    }

    // Absent is "seed it"; blank is the repository's own file, said by the
    // App carrying none. A file the caller sends is theirs and seeded nothing.
    // A forge that shows no file seeds blank too (`FJS-D1570`): a private
    // repository no account here sees reads as one with no Dockerfile, so the
    // template, right for a link: app alone, is never guessed here — the
    // form's button is how a person asks for it.
    let dockerfile: string | undefined
    let seeded: 'repo' | 'none' = 'none'
    if (typeof data.dockerfile === 'string') dockerfile = data.dockerfile
    else {
      const found = await readForgeDockerfile($.app, { repo: data.repo, branch: data.branch })
      dockerfile = 'content' in found ? found.content : ''
      seeded     = 'content' in found ? 'repo' : 'none'
    }
    const source = parseAppSource({ kind: 'git', repo: data.repo, branch: data.branch, dockerfile })
    // What the image listens on is the seed's last EXPOSE, the same read the
    // machine's build makes of the file it builds with; an App whose seed says
    // nothing stores none and takes the build's answer (`recordStep`).
    const containerPort = exposedPort(dockerfile)

    const made = await db().$transaction(async (tx: any) => {
      const project     = await tx.project.create({ data: { name, slug } })
      const environment = await tx.environment.create({ data: {
        projectId: project.id, name: 'production', slug: 'production', tier: 'production', isProtected: false,
      } })
      const app = await tx.app.create({ data: {
        environmentId: environment.id, name, slug, type: 'container', source,
        containerPort, volumePath: '/db', healthCheck: '/health',
      } })
      // The /db layout `fli make:deploy`'s Dockerfile mounts and `fli deploy`
      // binds (`packages/cli/commands/make/deploy.md`). junction binds
      // FRONTIER_PORT_BE before anything else, so the variable follows the
      // exposed port and is not written for a port nobody has read yet: a
      // guessed number here would override the image's own ENV.
      const plain: Record<string, string> = {
        DATABASE_URL:     '/db/app.db',
        AUDIT_PATH:       '/db/audit.db',
        NODE_ENV:         'production',
        ...(containerPort != null ? { FRONTIER_PORT_BE: String(containerPort) } : {}),
      }
      for (const [key, value] of Object.entries(plain))
        await tx.variable.create({ data: { environmentId: environment.id, appId: app.id, key, value } })
      // A secret variable holds its own value (FJS-1599); `variables.reveal`
      // is how an admin copies it to the laptop that opens this database.
      await tx.variable.create({ data: {
        environmentId: environment.id, appId: app.id, key: 'ENCRYPTION_KEY', secret: true,
        secretValue: randomBytes(32).toString('hex'),
      } })
      const domain = hostname
        ? await tx.domain.create({ data: { appId: app.id, hostname, isPrimary: true } })
        : null
      return { project, environment, app, domain }
    })

    $.dispatch = made.project
    if (made.domain) await toZone(made.domain.id, made.domain.version)

    // The host port is `placeApp`'s to pick (FJS-D1557); an App no machine
    // holds publishes nothing until it is placed. Deploy on push is on when a
    // server is named and nobody said no (FJS-D1558): a push to an App no
    // machine holds would queue a release that fails at its first step. The
    // credentials are in this answer and nowhere else, beside the deploy key,
    // so one panel shows both once.
    const notes: string[] = []
    let push: Awaited<ReturnType<typeof enablePushOn>> | null = null
    let connected: Awaited<ReturnType<typeof connectRepository>> | null = null
    if (server) {
      await placeApp($.app, made.app, server)
      const minted = await mintDeployKey($.app, made.app.id, server.id)
      if (minted.note) notes.push(minted.note)
      if (data.deployOnPush !== false) push = await enablePushOn(made.app.id)
      if (at && accounts.length && (minted.deployPublicKey || push)) {
        connected = await connectRepository($.app, 'github', accounts, at, {
          key:  minted.deployPublicKey ? { title: `Basecamp ${made.app.slug}`, key: minted.deployPublicKey } : null,
          hook: push ? { url: push.url, secret: push.secret } : null,
        })
        if (connected.note) notes.push(connected.note)
      }
    }

    const app = await db().app.findFirst({ where: { id: made.app.id }, include: { domains: true, environment: true } })
    return {
      // The project's id, so the trail files this call under the project.
      id: made.project.id,
      project: made.project, environment: made.environment, app,
      dockerfile: { seeded }, push, connected,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    }
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      create: [deriveSlug],
    },
  },
})
