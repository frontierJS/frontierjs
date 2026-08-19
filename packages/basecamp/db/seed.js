// db/seed.js — example data for local work.
//
//   bun run db:seed            seed once; a second run is a no-op
//   bun run db:seed --force    re-seed from scratch (deletes the seeded rows)
//
// This is development data, not a fixture the tests depend on: the test suite
// builds its own throwaway databases (db/test/schema.test.ts). What it is for
// is having something on screen — a fleet with servers in several states,
// deployments that half-succeeded, jobs that failed — because an empty list
// looks identical to a broken query.
//
// Three things this file is careful about:
//
//   1. **Passwords go through @frontierjs/auth**, never straight into the
//      table. A password lives in a `Credential` row as a bcrypt hash; a user
//      seeded without one cannot log in, which makes the whole exercise
//      pointless. auth.createUser() is the only thing that knows the shape.
//   2. **Everything runs as system.** Seeding is not a request: there is no
//      caller to scope to, and `Secret.data` is @encrypted, which is a
//      system-context write.
//   3. **The RNG is seeded**, so two runs on two machines produce the same
//      fleet. Deterministic data is what makes "the list changed" a signal.
//
// Every value below is a real column from db/schema.lite. Nothing is invented:
// if a field is not in the schema it is not here, and a wrong enum value fails
// the CHECK constraint at insert rather than sliding through.

import { Factory, Seeder, runSeeder, apply } from '@frontierjs/litestone'
import { createDatabase } from '@frontierjs/junction'
import { createLitestoneAuth } from '@frontierjs/auth'

import { createBasecampDb } from '../api/src/core/db.ts'
import { env } from '../api/src/core/env.ts'

const PASSWORD = 'hunter2hunter2'
const RNG_SEED = 42

// Identity that has to be UNIQUE comes from here, never from the factory's
// `seq`. With .seed(n) set, seq is not 1,2,3: buildOne() offsets it by a draw
// from the RNG (litestone src/seeder.js ~131) so that different seeds produce
// different values. That makes it deterministic but NOT sequential, and a name
// derived from `seq % 3` collides — `UNIQUE constraint failed: secret.workspaceId,
// secret.name` on the first run of this file. The RNG is for flavour (status,
// region, durations); identity is the caller's job.
let nth = 0
const uid = () => ++nth

// ─── Factories ────────────────────────────────────────────────────────────────
// A factory owns the shape of one model. Callers supply only what makes a row
// belong somewhere — the workspace, the environment — so a seeder reads as a
// story rather than as column soup.

class ProjectFactory extends Factory {
  model = 'Project'
  definition() {
    const n    = uid()
    const name = ['Website', 'Platform API', 'Data pipeline', 'Marketing site'][n % 4]
    return {
      name,
      slug:        `${slugify(name)}-${n}`,
      description: `${name} — seeded example`,
      status:      'active',
      tags:        ['seed'],
    }
  }
}

class EnvironmentFactory extends Factory {
  model = 'Environment'
  // tier values come from `enum EnvironmentTier` — development test preview
  // staging production. A value outside that list is refused by the CHECK
  // constraint the migration generated, which is the point of declaring it.
  // `tier` is identity here — slug is unique per project — so the seeder
  // supplies it per row rather than deriving it from seq.
  definition() {
    return { name: 'Development', slug: 'development', tier: 'development',
             isProtected: false, variables: [] }
  }
  tier(tier) {
    return this.state({
      name:        tier[0].toUpperCase() + tier.slice(1),
      slug:        tier,
      tier,
      isProtected: tier === 'production',
    })
  }
}

class AppFactory extends Factory {
  model = 'App'
  definition(_seq, rng) {
    const n    = uid()
    const name = ['web', 'api', 'worker', 'scheduler'][n % 4]
    return {
      name,
      slug:     `${name}-${n}`,
      type:     name === 'worker' ? 'worker' : name === 'scheduler' ? 'cron' : 'container',
      status:   rng ? rng.pick(['running', 'running', 'running', 'stopped', 'error']) : 'running',
      source:   { kind: 'git', repo: `git@forgejo.local:acme/${name}.git`, branch: 'main' },
      config:   { replicas: 1 },
      port:     name === 'web' ? 3000 : null,
      isPublic: name === 'web',
    }
  }
}

class ServerFactory extends Factory {
  model = 'Server'
  definition(_seq, rng) {
    const n      = uid()
    const role   = ['general', 'build', 'database', 'gateway', 'worker'][n % 5]
    const region = rng ? rng.pick(['nbg1', 'fsn1', 'hel1', 'ash']) : 'nbg1'
    return {
      name:         `${role}-${String(n).padStart(2, '0')}`,
      slug:         `${role}-${String(n).padStart(2, '0')}`,
      // A fleet where every machine is healthy teaches you nothing about the
      // UI. These are all real ServerStatus values.
      status:       rng ? rng.pick(['online', 'online', 'online', 'ready', 'draining', 'unreachable']) : 'online',
      role,
      providerKind: 'hetzner',
      region,
      ipAddress:    `10.0.${n % 250}.${10 + (n % 40)}`,
      sshPort:      22,
      sshUser:      'root',
      outpostVersion: '0.4.1',
      plan:         { vcpu: 4, ramGb: 8, diskGb: 160 },
      labels:       { seeded: 'true' },
    }
  }
}

class DeploymentFactory extends Factory {
  model = 'Deployment'
  definition(_seq, rng) {
    const seq    = uid()
    const status = rng
      ? rng.pick(['success', 'success', 'success', 'failed', 'rolled_back', 'deploying'])
      : 'success'
    const sha = (rng ? rng.str(7) : 'abc1234')
    return {
      status,
      trigger:       rng && rng.bool(0.3) ? 'webhook' : 'manual',
      commitSha:     sha,
      commitMessage: ['Bump dependencies', 'Fix null check on login', 'Add health endpoint',
                      'Cache the manifest', 'Revert "Cache the manifest"'][seq % 5],
      branch:        'main',
      author:        'sam@example.com',
      toImage:       `zot.local/acme/app:${sha}`,
      durationMs:    rng ? rng.int(20_000, 240_000) : 60_000,
      startedAt:     new Date(Date.now() - seq * 3_600_000).toISOString(),
      finishedAt:    status === 'deploying'
        ? null
        : new Date(Date.now() - seq * 3_600_000 + 90_000).toISOString(),
    }
  }
}

class JobFactory extends Factory {
  model = 'Job'
  definition(_seq, rng) {
    const seq       = uid()
    const scheduled = seq % 2 === 0
    return {
      name:           ['Nightly backup', 'Prune images', 'Rotate logs', 'Sync DNS'][seq % 4],
      kind:           scheduled ? 'scheduled' : 'one_shot',
      status:         rng ? rng.pick(['pending', 'pending', 'running', 'failed']) : 'pending',
      command:        ['/usr/local/bin/backup.sh', 'docker image prune -af',
                       'logrotate -f /etc/logrotate.conf', 'basecamp dns sync'][seq % 4],
      cronExpression: scheduled ? '0 3 * * *' : null,
      trigger:        scheduled ? 'schedule' : 'manual',
      timeoutSeconds: 900,
    }
  }
}

class SecretFactory extends Factory {
  model = 'Secret'
  // `data` is @encrypted — the value below never appears in the database file
  // or in the audit trail, which db/test/schema.test.ts proves by planting a
  // key and grepping the raw file for it.
  definition() {
    const n     = uid()
    const kinds = ['ssh_key', 'registry_auth', 'provider_key']
    const kind  = kinds[n % 3]
    return {
      name:       ['deploy-key', 'registry-auth', 'hetzner-token'][n % 3] + `-${n}`,
      kind,
      data:       JSON.stringify({ note: 'seeded example — not a real credential', kind }),
      isVerified: true,
    }
  }
}

// A channel is half a delivery: the row says WHERE to send, and the credential
// it needs — a Slack webhook URL is a bearer token — lives in a Secret, with
// only the reference kept here. Same ruling as Domain's certificate material.
// Seeding one is what makes /channels/ and the alert screens show the chain
// this app actually has, rather than an empty table that reads as broken.
class NotificationChannelFactory extends Factory {
  model = 'NotificationChannel'
  definition() {
    const n     = uid()
    const specs = [
      { name: 'Ops — Slack',    kind: 'slack',   config: { channel: '#ops' } },
      { name: 'On-call — email', kind: 'email',   config: { to: 'oncall@example.com' } },
      { name: 'Status webhook',  kind: 'webhook', config: { url: 'https://example.com/hooks/status' } },
    ]
    const spec = specs[n % specs.length]
    return { ...spec, name: `${spec.name} ${n}`, isActive: true }
  }
}

class VolumeFactory extends Factory {
  model = 'Volume'
  // The only model here whose rows a person never authors — a volume exists
  // because an outpost reported it, so what this factory imitates is a report.
  // Sizes are BYTES, the column's own unit: seeding gigabytes would put a
  // number in the database that the screen then divides again.
  definition(_seq, rng) {
    const n     = uid()
    const names = ['pg-data', 'redis-data', 'uploads', 'build-cache', 'grafana-storage', 'orphan-tmp']
    const name  = `${names[n % names.length]}-${n}`
    const inUse = rng ? rng.bool(0.65) : true
    return {
      name,
      driver:     'local',
      mountPoint: `/var/lib/docker/volumes/${name}/_data`,
      sizeBytes:  rng ? rng.int(8 * 1024 ** 2, 12 * 1024 ** 3) : 512 * 1024 ** 2,
      inUse,
      // Container NAMES, not App ids — mapping a container back to an App is a
      // guess, and a wrong join puts a volume under the wrong app.
      containers: inUse ? [`${names[n % names.length]}-svc`] : [],
      createdOnServer: new Date(Date.now() - (n % 90) * 86_400_000).toISOString(),
      lastSeenAt:      new Date(Date.now() - 4 * 60_000).toISOString(),
    }
  }
}

class AlertRuleFactory extends Factory {
  model = 'AlertRule'
  definition() {
    const seq = uid()
    const specs = [
      { name: 'Disk above 85%',      metricName: 'disk.used_percent', severity: 'warning', condition: { op: '>', value: 85 } },
      { name: 'Memory above 90%',    metricName: 'mem.used_percent',  severity: 'warning', condition: { op: '>', value: 90 } },
      { name: 'Outpost silent 10m',    metricName: 'outpost.heartbeat',   severity: 'critical', condition: { op: 'stale', minutes: 10 } },
    ]
    const spec = specs[seq % specs.length]
    // No `channels` here. It was a `Json` array of ids for rows no model
    // declared, and it is now the `AlertRuleChannel` join — a rule reaches
    // nobody until somebody attaches a real NotificationChannel to it, which
    // is what the alerts screen says out loud.
    return { ...spec, isActive: true }
  }
}

// ─── Seeder ───────────────────────────────────────────────────────────────────

export class BasecampSeeder extends Seeder {
  async run(db) {
    const sys  = db.asSystem()
    const auth = createLitestoneAuth(db, { encryptionKey: env.ENCRYPTION_KEY })

    // once() records the key in _litestone_seeds, so a second `bun run db:seed`
    // does nothing rather than creating a second Acme with a colliding slug.
    await this.once(db, 'basecamp:example-fleet', async () => {
      const account = await sys.account.create({
        data: { type: 'organization', status: 'active', slug: 'acme', displayName: 'Acme' },
      })

      // ── People ────────────────────────────────────────────────────────
      // auth.createUser() writes User + a bcrypt Credential. The Basecamp
      // columns it does not know about (accountId, status, displayName) are
      // patched after — every one of them is nullable or defaulted precisely
      // so this two-step works.
      const people = [
        { email: 'sam@example.com',  name: 'Sam Okonkwo',  role: 'owner'     },
        { email: 'kim@example.com',  name: 'Kim Alvarez',  role: 'admin'     },
        { email: 'remy@example.com', name: 'Remy Fontaine', role: 'developer' },
        { email: 'jo@example.com',   name: 'Jo Barrett',   role: 'viewer'    },
      ]

      const users = []
      for (const person of people) {
        const session = await auth.createUser({
          email: person.email, name: person.name, password: PASSWORD,
        })
        const user = await sys.user.update({
          where: { id: session.userId },
          data: {
            accountId:     account.id,
            status:        'active',
            displayName:   person.name,
            emailVerified: true,
            // The hub tier, on the first person only — the same rule /setup
            // follows. A seeded fleet where everyone can suspend everyone else
            // would make the hub screens untestable by eye.
            isSystemAdmin: person.role === 'owner',
          },
        })
        users.push({ ...user, seedRole: person.role })
      }

      const owner = users[0]

      // ── A bot ─────────────────────────────────────────────────────────
      // No password Credential, so it cannot sign in; it exists to own an API
      // key. Written here because the seed is the only thing that writes every
      // model, and a `kind` the seed never produces is a column no screen is
      // ever seen with (`bun run db:seed` had drifted eleven models behind the
      // schema once already).
      const bot = await sys.user.create({
        data: {
          email: 'ci-deploy@bots.invalid', name: 'CI deploy', displayName: 'CI deploy',
          kind: 'bot', status: 'active', accountId: account.id, emailVerified: false,
        },
      })

      // ── Workspaces ────────────────────────────────────────────────────
      const workspaces = []
      for (const [name, slug] of [['Acme Platform', 'acme-platform'], ['Skunkworks', 'skunkworks']]) {
        const ws = await sys.workspace.create({
          data: { accountId: account.id, name, slug, type: 'team', ownerId: owner.id },
        })

        // Everyone is in the first workspace; only the owner and one admin are
        // in the second. That asymmetry is deliberate — it is what makes the
        // workspace switcher show different lists for different people.
        const members = slug === 'acme-platform' ? users : users.slice(0, 2)
        for (const user of members) {
          await sys.workspaceMember.create({
            data: {
              workspaceId: ws.id,
              userId:      user.id,
              role:        user.id === owner.id ? 'owner' : user.seedRole,
              acceptedAt:  new Date().toISOString(),
            },
          })
        }

        // The bot is in the first workspace only, as a developer — the role a
        // pipeline needs and the highest a bot may hold anywhere near an owner
        // (the hub refuses `owner` outright: an owner cannot be removed and can
        // delete the tenant).
        if (slug === 'acme-platform') {
          await sys.workspaceMember.create({
            data: { workspaceId: ws.id, userId: bot.id, role: 'developer',
                    acceptedAt: new Date().toISOString() },
          })
        }
        workspaces.push(ws)
      }

      // The application audit trail, written explicitly.
      //
      // Seeding goes through the Litestone client, not through the services, so
      // the basecampAuditLog hook that normally writes these never fires — a
      // seeded database has a full fleet and an empty trail, which reads as a
      // broken audit screen rather than as "nothing has happened through the
      // API yet". These rows are synthetic and say so in their action names'
      // company: everything else in the trail is written by a real request.
      const auditFor = async (workspaceId, action, subjectType, subjectId) => {
        await sys.auditEvent.create({
          data: {
            workspaceId, actorId: owner.id, actorType: 'user',
            action, subjectType, subjectId,
            diff: { note: 'seeded example' },
          },
        })
      }

      // ── The fleet, per workspace ──────────────────────────────────────
      for (const [index, ws] of workspaces.entries()) {
        const scale = index === 0 ? 1 : 0.5   // Skunkworks is the smaller one

        const projects = await new ProjectFactory(sys)
          .seed(RNG_SEED + index)
          .create(Math.max(1, Math.round(3 * scale)), { workspaceId: ws.id })

        for (const project of projects) await auditFor(ws.id, 'projects.create', 'projects', project.id)

        const servers = await new ServerFactory(sys)
          .seed(RNG_SEED + index)
          .create(Math.max(2, Math.round(6 * scale)), { workspaceId: ws.id })

        for (const server of servers) await auditFor(ws.id, 'servers.create', 'servers', server.id)

        // Volumes hang off a server, never off the workspace — the model has no
        // workspaceId, and its scope is this join. Not every machine has disks:
        // a fleet where all of them do makes the per-server filter pointless.
        for (const server of servers.slice(0, Math.max(1, servers.length - 1))) {
          await new VolumeFactory(sys)
            .seed(RNG_SEED + servers.indexOf(server))
            .create(3, { serverId: server.id })
        }

        await new SecretFactory(sys)
          .seed(RNG_SEED + index)
          .create(3, { workspaceId: ws.id, createdBy: owner.id })

        const rules = await new AlertRuleFactory(sys)
          .seed(RNG_SEED + index)
          .create(3, { workspaceId: ws.id })

        // The credential a channel sends with, in the one place it may live.
        // `kind: 'notification'` is what core/credentials.ts resolves a
        // `secret:<id>` ref to at send time.
        const hookSecret = await sys.secret.create({
          data: {
            workspaceId: ws.id,
            name:        `slack-webhook-${index}`,
            kind:        'notification',
            data:        JSON.stringify({ url: 'https://hooks.example.com/seeded/not-a-real-webhook' }),
            isVerified:  true,
            createdBy:   owner.id,
          },
        })

        const channels = await new NotificationChannelFactory(sys)
          .seed(RNG_SEED + index)
          .create(2, { workspaceId: ws.id, createdBy: owner.id })

        // Only the Slack one carries the secret; the other is left without, on
        // purpose — a channel with no credential is the state the screen has to
        // render, and a seeded fleet where every row is complete never shows it.
        const slack = channels.find(c => c.kind === 'slack')
        if (slack) await sys.notificationChannel.update({
          where: { id: slack.id }, data: { secretId: hookSecret.id },
        })

        // The join Phase 5 replaced a Json array of ids with. One rule reaches
        // somebody; the others reach nobody, which is what the alerts screen
        // says out loud and could not demonstrate with no channels seeded.
        if (rules[0] && channels[0]) await sys.alertRuleChannel.create({
          data: { ruleId: rules[0].id, channelId: channels[0].id },
        })

        // API keys are not a Factory. Each one needs a REAL credential from
        // auth — the row is only the operational half, and a key pointing at no
        // credential is refused by apiKeyGuard as "no record in Basecamp",
        // which would make the seeded fleet demonstrate the failure path.
        // The plaintext is dropped here on purpose: nothing can read it back,
        // which is the whole property, and a seed that printed one would be
        // teaching the opposite lesson.
        for (const [name, scopes, revoked] of [
          ['ci-bot production',   ['deployments:write', 'projects:read', 'servers:read'], false],
          ['read-only monitoring', ['servers:read', 'jobs:read'],                          false],
          ['old staging bot',      ['deployments:write'],                                  true],
        ]) {
          const { key, id } = await auth.createApiKey(owner.id, { name, scopes })
          await sys.apiKey.create({
            data: {
              workspaceId: ws.id, userId: owner.id, name, scopes,
              credentialId: revoked ? null : id,
              tokenHint:   `fjs_${key.replace(/^fjs_/, '').slice(0, 4)}…${key.slice(-4)}`,
              revokedAt:   revoked ? new Date(Date.now() - 14 * 86_400_000).toISOString() : null,
              lastUsedAt:  revoked ? null : new Date(Date.now() - 3 * 60_000).toISOString(),
              totalUses:   revoked ? 203 : 842,
              createdBy:   owner.id,
            },
          })
          if (revoked) await auth.revokeApiKey(id)
        }

        for (const project of projects) {
          const environments = []
          for (const tier of ['development', 'staging', 'production']) {
            environments.push(await new EnvironmentFactory(sys)
              .tier(tier)
              .create({ projectId: project.id, workspaceId: ws.id }))
          }

          for (const environment of environments) {
            const apps = await new AppFactory(sys)
              .seed(RNG_SEED + environments.indexOf(environment))
              .create(2, { workspaceId: ws.id, environmentId: environment.id })

            for (const app of apps) {
              // Where it runs. A seeded app with no placement is an app whose
              // Deploy button answers 400 — the deployment engine resolves an
              // executor from `AppServer` and refuses without one, so a fleet
              // demo that skipped this would look complete and deploy nothing.
              // Round-robin across the online machines, so the placement column
              // is not the same server on every row.
              const online = servers.filter(s => s.status === 'online')
              const host   = online[apps.indexOf(app) % online.length] ?? servers[0]
              if (host) {
                await sys.appServer.create({
                  data: { appId: app.id, serverId: host.id, replicaIndex: 0, status: 'running' },
                })
              }

              // Deployment history, most recent first. Only production gets a
              // long tail; a development environment with 40 deploys in it
              // reads as noise rather than as history.
              const count = environment.tier === 'production' ? 4 : 2
              const deployments = await new DeploymentFactory(sys)
                .seed(RNG_SEED + apps.indexOf(app))
                .create(count, {
                  appId:         app.id,
                  environmentId: environment.id,
                  workspaceId:   ws.id,
                  triggeredBy:   owner.id,
                })

              for (const deployment of deployments) await seedSteps(sys, deployment)
            }

            // Jobs hang off the environment, and each one has run before —
            // a job with no history cannot show whether it is healthy.
            const jobs = await new JobFactory(sys)
              .seed(RNG_SEED + environments.indexOf(environment))
              .create(2, {
                workspaceId:   ws.id,
                environmentId: environment.id,
                appId:         apps[0].id,
              })

            for (const job of jobs) await seedRuns(sys, job)
          }
        }

        // ── A dashboard ───────────────────────────────────────────────
        // One board per workspace, holding a card of each SHAPE — a fleet grid
        // with no subject, a counter with a config source, and two cards
        // pointing at a real server and a real app. A seeded board of six
        // identical widgets would prove nothing about the subject rules.
        //
        // The app is read back rather than threaded down from the loop above:
        // it is created three environments deep, and carrying it out would mean
        // a variable that exists only to be seeded.
        const someApp = await sys.app.findFirst({ where: { workspaceId: ws.id } })
        const board = await sys.dashboard.create({
          data: {
            workspaceId: ws.id,
            name:        'Ops overview',
            slug:        'ops-overview',
            description: 'What is running, what shipped, what broke',
            icon:        '🏢',
            isPinned:    true,
            createdBy:   owner.id,
          },
        })

        const cards = [
          { kind: 'server_fleet',  cols: 3, config: {} },
          { kind: 'stat_counter',  cols: 1, config: { source: 'servers', label: 'Servers' } },
          { kind: 'deploy_feed',   cols: 2, config: {} },
          { kind: 'server_health', cols: 1, config: {}, serverId: servers[0]?.id ?? null },
          { kind: 'app_status',    cols: 1, config: {}, appId: someApp?.id ?? null },
          { kind: 'job_history',   cols: 2, config: {} },
        ]
        for (const [position, card] of cards.entries()) {
          // A subject-required card with nothing to point at is left out rather
          // than seeded null: the service would refuse that payload, and a seed
          // that writes rows the API would not is a seed that hides a bug.
          if (card.kind === 'server_health' && !card.serverId) continue
          if (card.kind === 'app_status'    && !card.appId)    continue
          await sys.dashboardWidget.create({ data: { dashboardId: board.id, position, ...card } })
        }

        // ── Recipes, and what they did ────────────────────────────────
        // Three scripts and a history, because a recipe with no runs cannot
        // show the thing this screen is for: the run keeps the script it ran,
        // so an edited recipe and its old output disagree on purpose.
        const recipes = []
        for (const [name, description, script] of [
          ['Update system packages', 'apt-get update && apt-get upgrade on the target.',
           '#!/bin/bash\nset -e\napt-get update\napt-get upgrade -y\necho "Done."'],
          ['Restart nginx', 'Reloads the nginx config and restarts the service.',
           '#!/bin/bash\nnginx -t && systemctl reload nginx\necho "nginx reloaded."'],
          ['Check disk usage', 'df and du for / and /var.',
           '#!/bin/bash\ndf -h /\ndu -sh /var/* 2>/dev/null | sort -rh | head -10'],
        ]) {
          recipes.push(await sys.recipe.create({
            data: { workspaceId: ws.id, name, slug: slugify(name), description, script, createdBy: owner.id },
          }))
        }

        // Runs on real machines, one row per server — which is the shape a
        // fleet run has, and the reason a single status could not describe it.
        for (const [index, server] of servers.slice(0, 2).entries()) {
          const failed = index === 1
          const at     = Date.now() - (index + 1) * 3_600_000
          await sys.recipeRun.create({
            data: {
              recipeId:    recipes[2].id,
              serverId:    server.id,
              script:      recipes[2].script,
              status:      failed ? 'failed' : 'success',
              requestedBy: owner.id,
              exitCode:    failed ? 1 : 0,
              stdout:      failed ? null : 'Filesystem      Size  Used Avail Use%\n/dev/vda1        79G   42G   34G  55%',
              stderr:      failed ? 'du: cannot read directory /var/lib/docker: Permission denied' : null,
              error:       failed ? 'exited 1' : null,
              startedAt:   new Date(at).toISOString(),
              finishedAt:  new Date(at + 4_000).toISOString(),
              durationMs:  4_000,
            },
          })
        }
        await sys.recipe.update({
          where: { id: recipes[2].id },
          data:  { lastRunAt: new Date(Date.now() - 3_600_000).toISOString(), runCount: 2 },
        })

        // ── What the outposts said about the disks ──────────────────────
        // `docker system df`'s own figures, and only for the machines whose
        // outpost has reported: a fleet where every server has a picture makes
        // "never reported" — the state that means no outpost rather than no
        // rubbish — impossible to see on the screen.
        for (const [index, server] of servers.slice(0, Math.max(1, servers.length - 1)).entries()) {
          const heavy = index === 0        // one build runner, and it shows
          await sys.diskUsage.create({
            data: {
              serverId:                   server.id,
              imagesTotal:                heavy ? 58 : 24,
              imagesUnused:               heavy ? 9  : 3,
              imagesDangling:             heavy ? 22 : 8,
              imageBytes:                 heavy ? 18_400_000_000 : 4_200_000_000,
              imagesReclaimableBytes:     heavy ?  9_100_000_000 : 1_100_000_000,
              containersRunning:          heavy ? 1 : 6,
              containersStopped:          heavy ? 2 : 1,
              containersReclaimableBytes: heavy ? 42_000_000 : 8_000_000,
              buildCacheBytes:            heavy ? 8_200_000_000 : 1_100_000_000,
              buildCacheReclaimableBytes: heavy ? 8_000_000_000 : 900_000_000,
              reportedAt:                 new Date(Date.now() - 4 * 60_000).toISOString(),
            },
          })
        }

        // One sweep that already happened, so the history table and the
        // per-server "last swept" line have something true behind them.
        await sys.cleanupRun.create({
          data: {
            serverId:    servers[0].id,
            status:      'success',
            targets:     ['dangling_images', 'stopped_containers', 'build_cache'],
            keepImages:  3,
            requestedBy: owner.id,
            freedBytes:  3_400_000_000,
            detail:      { removed: { images: 22, containers: 2, build_cache_bytes: 2_100_000_000 }, volumes: [] },
            startedAt:   new Date(Date.now() - 3 * 86_400_000).toISOString(),
            finishedAt:  new Date(Date.now() - 3 * 86_400_000 + 41_000).toISOString(),
            durationMs:  41_000,
          },
        })

        // One server left deliberately unhealthy per workspace, so the alert
        // and the drain paths have something real to point at.
        if (servers.length > 2) {
          await sys.server.update({
            where: { id: servers[servers.length - 1].id },
            data:  { status: 'unreachable', lastHeartbeatAt: new Date(Date.now() - 45 * 60_000).toISOString() },
          })
        }
      }
    })
  }
}

// The six steps the deployment engine actually runs (api/src/engine/
// deployment.engine.ts), so a seeded deployment and a real one look the same.
const STEPS = ['prepare', 'build', 'push', 'configure', 'release', 'verify']

async function seedSteps(db, deployment) {
  // A failed deployment stops where it failed — the later steps never ran, and
  // recording them as 'pending' is what a real interrupted run leaves behind.
  const failedAt = deployment.status === 'failed'   ? 2
                 : deployment.status === 'deploying' ? 3
                 : -1

  for (const [i, name] of STEPS.entries()) {
    const status = failedAt < 0            ? 'success'
                 : i <  failedAt           ? 'success'
                 : i === failedAt          ? (deployment.status === 'failed' ? 'failed' : 'running')
                 : 'pending'

    await db.deploymentStep.create({
      data: {
        deploymentId: deployment.id,
        name,
        status,
        output:     status === 'failed' ? 'exit status 1: build failed' : null,
        startedAt:  status === 'pending' ? null : new Date(Date.now() - (6 - i) * 20_000).toISOString(),
        finishedAt: status === 'pending' || status === 'running'
          ? null
          : new Date(Date.now() - (6 - i) * 20_000 + 15_000).toISOString(),
        durationMs: status === 'pending' || status === 'running' ? null : 15_000,
      },
    })
  }
}

async function seedRuns(db, job) {
  for (let i = 0; i < 3; i++) {
    const failed = i === 0 && job.status === 'failed'
    await db.jobRun.create({
      data: {
        jobId:      job.id,
        status:     failed ? 'failed' : 'success',
        trigger:    job.trigger,
        startedAt:  new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
        finishedAt: new Date(Date.now() - (i + 1) * 86_400_000 + 12_000).toISOString(),
        durationMs: 12_000,
        exitCode:   failed ? 1 : 0,
        error:      failed ? 'command exited with status 1' : null,
        output:     { lines: 42 },
      },
    })
  }
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  // Migrations first: seeding a database with no tables fails with a driver
  // error that names a table, not the missing step. This is the same call
  // api/src/core/app.ts makes on boot, and it is litestone's runner for the
  // same reason — migrations live in `db/migrations/main/` because the schema
  // declares `database main`, and a runner that globs one level up finds
  // nothing and reports success.
  const migrationsDir = new URL('./migrations/main', import.meta.url).pathname
  const raw = createDatabase({ path: env.DATABASE_URL })
  const migrated = await apply(raw.db, migrationsDir)
  if (migrated.unmatched) throw new Error(`[seed] ${migrated.message} — db/migrations/main`)
  raw.close()

  const db = await createBasecampDb()

  if (process.argv.includes('--force')) {
    // Children before parents — foreign keys are ON. Account and Workspace
    // cascade, but the seed-history row has to go or once() will skip.
    const sys = db.asSystem()
    // Every model, children before parents — foreign keys are ON. It is the
    // whole list rather than the seeded subset on purpose: a model added later
    // and left out here survives a --force, and the next run collides with a
    // row it cannot see. Six had already been left out this way.
    for (const model of [
      'jobRun', 'job', 'deploymentStep', 'deployment', 'appNetwork', 'appServer',
      'dashboardWidget', 'dashboard', 'recipeRun', 'recipe', 'cleanupRun', 'diskUsage',
      'domain', 'app', 'flagOverride', 'featureFlag', 'environment', 'project',
      'alertEvent', 'alertRuleChannel', 'alertRule', 'notificationChannel',
      'apiKey', 'secret', 'serverNetwork', 'network', 'volume', 'serverEvent',
      'server', 'workspaceMember', 'workspace', 'session',
      'credential', 'verification', 'user', 'account',
    ]) await sys[model].deleteMany({})

    // auditEvent is NOT in that list and must not be: AuditEvent is
    // @@gate("5.8.9.9"), and 9 is LOCKED — a level asSystem() does not pass
    // either, which is the one gate that protects the trail from the
    // application itself. Almost nothing is left behind: the column is
    // `onDelete: Cascade`, so SQLite takes every row belonging to a workspace
    // deleted above — including the fourteen this seeder writes below. What
    // survives is the rows with a NULL workspaceId, which are the ones a
    // system-level action wrote, and a --force that erased those would be
    // erasing the only record that they happened.

    // Asked for first, because SQLite resolves the table at PREPARE time: a
    // `DELETE … WHERE EXISTS (SELECT … FROM sqlite_master)` guard still throws.
    // The seed-history table is created by the first seeder run, so `--force`
    // on a database that has never been seeded — which is every database
    // `bun run verify --reset` leaves behind — died with `no such table:
    // _litestone_seeds` before it had reseeded anything.
    const raw = db.$rawDbs?.main
    const seeded = raw?.query(`SELECT 1 FROM sqlite_master WHERE name = '_litestone_seeds'`).get()
    if (seeded) raw.run('DELETE FROM "_litestone_seeds" WHERE key = ?', 'basecamp:example-fleet')
    console.log('cleared previous data')
  }

  // asSystem(), not the root client. Seeding is not a request — there is no
  // caller to scope to — and every model declares a @@gate, so the root client
  // grades STRANGER(0) and the first factory write is refused by the level it
  // needs. The header of this file already said everything runs as system; it
  // was the one line that did not.
  await runSeeder(db.asSystem(), BasecampSeeder)

  const sys = db.asSystem()
  const counts = {}
  for (const model of ['user', 'workspace', 'project', 'environment', 'app',
                       'server', 'volume', 'deployment', 'deploymentStep', 'job', 'jobRun',
                       'secret', 'apiKey', 'alertRule', 'notificationChannel',
                       'alertRuleChannel', 'dashboard', 'dashboardWidget',
                       'recipe', 'recipeRun', 'diskUsage', 'cleanupRun',
                       'auditEvent']) {
    counts[model] = await sys[model].count()
  }

  console.log('\nseeded:')
  for (const [model, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(4)}  ${model}`)
  console.log(`\nsign in as any of sam@ kim@ remy@ jo@example.com — password ${PASSWORD}\n`)

  db.$close()
}
