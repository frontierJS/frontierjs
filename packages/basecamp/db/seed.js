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

import { Factory, Seeder, runSeeder } from '@frontierjs/litestone'
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
      agentVersion: '0.4.1',
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

class AlertRuleFactory extends Factory {
  model = 'AlertRule'
  definition() {
    const seq = uid()
    const specs = [
      { name: 'Disk above 85%',      metricName: 'disk.used_percent', severity: 'high',   condition: { op: '>', value: 85 } },
      { name: 'Memory above 90%',    metricName: 'mem.used_percent',  severity: 'high',   condition: { op: '>', value: 90 } },
      { name: 'Agent silent 10m',    metricName: 'agent.heartbeat',   severity: 'critical', condition: { op: 'stale', minutes: 10 } },
    ]
    const spec = specs[seq % specs.length]
    return { ...spec, channels: ['email'], isActive: true }
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
          },
        })
        users.push({ ...user, seedRole: person.role })
      }

      const owner = users[0]

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

        await new SecretFactory(sys)
          .seed(RNG_SEED + index)
          .create(3, { workspaceId: ws.id, createdBy: owner.id })

        await new AlertRuleFactory(sys)
          .seed(RNG_SEED + index)
          .create(3, { workspaceId: ws.id })

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
  // api/src/core/app.ts makes on boot.
  const migrationsDir = new URL('./migrations', import.meta.url).pathname
  const raw = createDatabase({ path: env.DATABASE_URL })
  await raw.migrate(migrationsDir)
  raw.close()

  const db = await createBasecampDb()

  if (process.argv.includes('--force')) {
    // Children before parents — foreign keys are ON. Account and Workspace
    // cascade, but the seed-history row has to go or once() will skip.
    const sys = db.asSystem()
    for (const model of [
      'jobRun', 'job', 'deploymentStep', 'deployment', 'appServer', 'app',
      'environment', 'project', 'alertRule', 'secret', 'serverNetwork', 'server',
      'auditEvent', 'workspaceMember', 'workspace', 'session', 'credential',
      'verification', 'user', 'account',
    ]) await sys[model].deleteMany({})

    db.$rawDbs?.main?.run('DELETE FROM "_litestone_seeds" WHERE key = ?', 'basecamp:example-fleet')
    console.log('cleared previous data')
  }

  await runSeeder(db, BasecampSeeder)

  const sys = db.asSystem()
  const counts = {}
  for (const model of ['user', 'workspace', 'project', 'environment', 'app',
                       'server', 'deployment', 'deploymentStep', 'job', 'jobRun',
                       'secret', 'alertRule', 'auditEvent']) {
    counts[model] = await sys[model].count()
  }

  console.log('\nseeded:')
  for (const [model, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(4)}  ${model}`)
  console.log(`\nsign in as any of sam@ kim@ remy@ jo@example.com — password ${PASSWORD}\n`)

  db.$close()
}
