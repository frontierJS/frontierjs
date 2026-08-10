// src/services/channels/channels.service.ts
// Notification channels — where an alert is actually delivered.
//
// Mounted at /channels. Custom methods dispatch on X-Service-Method:
//   test · rules
//
// This is the model `AlertRule.channels` was already pointing at. That column
// was `Json @default("[]")`, an array of ids for rows no model declared: a
// foreign key with no constraint and no reader, so nothing could tell a live
// channel from a typo. It is now `AlertRuleChannel`, a real join, and attaching
// is `alerts.attachChannel`.
//
// **The credential is not on this row.** A Slack webhook URL and a PagerDuty
// integration key are bearer credentials — anyone holding one can post as the
// workspace — so `create` lifts the material into a `Secret` (`@encrypted`,
// written once, never read back) and keeps the reference. What stays in
// `config` is routing: the channel override, the recipient list, the HTTP
// method. Nothing in it is sensitive, which is why the whole column comes back
// on a read while the credential never does.
//
// **`test` really sends.** It goes through `app.conduit`, the outbound
// boundary, not `fetch()` in a service — the channel registers itself as a
// conduit target and the credential is resolved from its Secret at send time
// (core/credentials.ts). A `test` that stamped a timestamp and reported success
// would be worse than no test at all, because the stamp is then read as
// evidence. Email is the one kind that cannot be tested: it needs a mailer this
// app has not configured, and it says so rather than pretending.

import { createService, NotFound, BadRequest, Conflict, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, narrowPatch, dbOf, wsOf, actorOf }
  from '../../core/resource.ts'
import { secretRef }           from '../../core/credentials.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

// ─── Per-kind delivery shape ─────────────────────────────────────────────
// One table, four consumers: what the credential is called, where the request
// goes, and what a test payload looks like. Written once here rather than as
// four branches in `test`, because a kind that is half-declared is a channel
// that accepts a credential and can never use it.
//
// `secretField` is the key inside the Secret's JSON document. `host` is the
// conduit target's address — never the full URL, because the secret part of a
// Slack webhook is the PATH, and a target address is stored in conduit's
// registry and echoed by `GET /conduit-targets`.

interface KindSpec {
  label:       string
  secretField: string | null          // null → this kind carries no credential
  host:        string | null          // null → the address comes from config.url
  testBody:    (name: string) => unknown
  describe:    (config: Record<string, unknown>) => string
}

const KINDS: Record<string, KindSpec> = {
  slack: {
    label:       'Slack',
    secretField: 'webhookUrl',
    host:        'https://hooks.slack.com',
    testBody:    (name) => ({ text: `Basecamp test notification from channel “${name}”.` }),
    describe:    (c) => (c.channel as string) ?? 'the webhook’s default channel',
  },
  pagerduty: {
    label:       'PagerDuty',
    secretField: 'integrationKey',
    host:        'https://events.pagerduty.com',
    testBody:    (name) => ({
      event_action: 'trigger',
      payload: { summary: `Basecamp test from “${name}”`, source: 'basecamp', severity: 'info' },
    }),
    describe:    () => 'Events API v2',
  },
  email: {
    label:       'Email',
    secretField: null,
    host:        null,
    testBody:    () => null,
    describe:    (c) => ((c.to as string[]) ?? []).join(', ') || 'no recipients',
  },
  webhook: {
    label:       'Webhook',
    secretField: 'token',             // optional — a bare webhook needs none
    host:        null,
    testBody:    (name) => ({ event: 'basecamp.test', channel: name }),
    describe:    (c) => (c.url as string) ?? 'no URL',
  },
}

export function createChannelsService(app: BasecampApp) {

  /** The system client, typed once. `Secret.data` is `@encrypted`, so every
   *  read and write of the material has to go through `asSystem()` — the column
   *  is absent from the row a scoped client would produce, and absent from the
   *  one it would write. `litestone types` would make this unnecessary; until
   *  then it is one cast rather than four. */
  const sys = (): any => (app.data as any).asSystem()

  /** The outbound boundary, or a refusal that names what is missing. `app.conduit`
   *  is optional on the app type — a Basecamp built without the plugin is a
   *  legitimate configuration, and a channel test is the one thing here that
   *  cannot work without it. */
  function conduitOrRefuse() {
    if (!app.conduit)
      throw new BadRequest('Outbound delivery is not configured on this server — no conduit plugin')
    return app.conduit
  }

  /** A channel plus how many rules deliver through it. The count is what makes
   *  a channel legible — an unused channel and one carrying every page-out look
   *  identical without it, and it is also what `remove` refuses on. */
  async function withRuleCount(ctx: ServiceContext, channel: Record<string, unknown>) {
    const rule_count = await dbOf(ctx).alertRuleChannel.count({ where: { channelId: channel.id } })
    return { ...channel, rule_count }
  }

  /**
   * Lift a credential out of the payload and into a Secret.
   *
   * Returns the secret's id, or null when the kind carries no credential. The
   * plaintext is never written to NotificationChannel and never returned: the
   * only path back out is conduit's resolver, at send time.
   */
  async function storeCredential(
    ctx:   ServiceContext,
    kind:  string,
    name:  string,
    value: string,
  ): Promise<string> {
    const field  = KINDS[kind].secretField as string
    // asSystem(): Secret.data is @encrypted, so a scoped client cannot write it
    // back either — the column is absent from the row it would produce.
    const secret = await sys().secret.create({
      data: {
        workspaceId: wsOf(ctx),
        // The unique is [workspaceId, name] and a channel's name is already
        // unique in the workspace, so this cannot collide where the channel did
        // not. The prefix keeps it out of the way of secrets a person authored.
        name:      `channel:${name}`,
        kind:      'notification',
        data:      JSON.stringify({ [field]: value }),
        createdBy: actorOf(ctx),
      },
    })
    return secret.id as string
  }

  return createService({
    name:  'channels',
    model: 'NotificationChannel',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const kind     = ctx.query.kind as string | undefined
      // The wire carries strings and the column is a boolean; comparing them
      // raw matches nothing and reports an empty list rather than an error.
      const isActive = ctx.query.isActive as string | boolean | undefined

      const page = await findScoped(ctx, 'notificationChannel', {
        where: {
          ...(kind ? { kind } : {}),
          ...(isActive !== undefined ? { isActive: isActive === true || isActive === 'true' } : {}),
        },
        orderBy: { name: 'asc' },
        limit, offset,
      })

      // The list screen leads on "is anything delivering through this", so the
      // count is paid for here rather than making the browser fan out one
      // request per row to find out.
      const data = await Promise.all(
        (page.data as Record<string, unknown>[]).map(row => withRuleCount(ctx, row))
      )
      return { ...page, data }
    },

    async get(ctx: ServiceContext) {
      return withRuleCount(ctx, await getScoped(ctx, 'notificationChannel', 'Channel'))
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      const kind = data.kind as string
      const spec = KINDS[kind]
      // The schema's CHECK already refuses an unknown kind and autoValidate
      // refuses it before this runs. This guard is about THIS table being
      // complete: a kind declared in the enum with no spec here would accept a
      // credential it could never send.
      if (!spec) throw new BadRequest(`kind must be one of ${Object.keys(KINDS).join(', ')}`)

      if (await dbOf(ctx).notificationChannel.exists({ where: { workspaceId: wsOf(ctx), name: data.name } }))
        throw new Conflict(`A channel named '${data.name}' already exists in this workspace`)

      // Captured by the before-hook, not read off ctx.data — see
      // captureCredential. By the time a method body runs, autoValidate has
      // already deleted every key the model does not declare.
      const credential = ctx.locals.credential as string | undefined

      if (spec.secretField && kind !== 'webhook' && !credential)
        throw new BadRequest(`${spec.label} needs a credential — send it as \`secret\``)
      if (credential && !spec.secretField)
        throw new BadRequest(`${spec.label} channels carry no credential`)

      if (credential)
        data.secretId = await storeCredential(ctx, kind, data.name as string, credential)

      return withRuleCount(ctx, await dbOf(ctx).notificationChannel.create({ data }))
    },

    async patch(ctx: ServiceContext) {
      const channel = await getScoped(ctx, 'notificationChannel', 'Channel')
      const data    = ctx.data as Record<string, unknown>

      // Rotating the credential is allowed and is most of why patch exists.
      const credential = ctx.locals.credential as string | undefined

      // `kind` is immutable: a channel that changes what it IS keeps every
      // rule pointing at it while the credential, the payload shape and the
      // destination all change underneath. Delete and recreate says so.
      // `secretId` likewise — it moves only through the rotation below, never
      // by a client naming a Secret it happens to know the id of.
      const patch = narrowPatch(data, ['kind', 'secretId', 'createdBy', 'lastTestAt', 'lastDeliveryAt'])

      if (credential) {
        const spec = KINDS[channel.kind as string]
        if (!spec?.secretField) throw new BadRequest(`${spec?.label ?? channel.kind} channels carry no credential`)

        if (channel.secretId) {
          // Rotate in place — the rules pointing at this channel keep working,
          // and `isVerified` goes false the way the secrets service does it.
          await sys().secret.update({
            where: { id: channel.secretId as string },
            data:  { data: JSON.stringify({ [spec.secretField]: credential }), isVerified: false },
          })
        } else {
          patch.secretId = await storeCredential(
            ctx, channel.kind as string, channel.name as string, credential
          )
        }
      }

      if (!Object.keys(patch).length) return withRuleCount(ctx, channel)
      return withRuleCount(ctx, await dbOf(ctx).notificationChannel.update({
        where: { id: channel.id }, data: patch,
      }))
    },

    async remove(ctx: ServiceContext) {
      const channel = await getScoped(ctx, 'notificationChannel', 'Channel')

      // Refused rather than cascaded — the same call the networks service
      // makes about a populated network. The FK WOULD cascade the join rows,
      // which is right for integrity and wrong as a default: silently
      // unhooking a rule from the only place it pages anyone is how an alert
      // stops reaching a human without anybody deciding it should.
      const attached = await dbOf(ctx).alertRuleChannel.count({ where: { channelId: channel.id } })
      if (attached > 0)
        throw new Conflict(`${attached} alert rule(s) still deliver here — detach them first`)

      const removed = await removeScoped(ctx, 'notificationChannel', 'Channel')

      // The Secret goes with it. A credential whose only reader has been
      // deleted is a live bearer token nothing is watching. Soft-delete, like
      // the channel — the audit trail keeps both.
      if (channel.secretId)
        await sys().secret.remove({ where: { id: channel.secretId as string } })

      return removed
    },

    // ── rules ─────────────────────────────────────────────────────────
    // Which rules deliver here. Read-shaped, so it opts out of the
    // announcement the after-hook makes for every other method.
    async rules(ctx: ServiceContext) {
      const channel = await getScoped(ctx, 'notificationChannel', 'Channel')
      ctx.dispatch = false

      const rows = await dbOf(ctx).alertRuleChannel.findMany({
        where:   { channelId: channel.id },
        include: { rule: true },
        orderBy: { createdAt: 'asc' },
      })
      return { total: rows.length, data: rows }
    },

    // ── test ──────────────────────────────────────────────────────────
    // Deliver a test notification, for real, through app.conduit.
    async test(ctx: ServiceContext) {
      const channel = await getScoped(ctx, 'notificationChannel', 'Channel')
      const kind    = channel.kind as string
      const spec    = KINDS[kind]
      const config  = (channel.config ?? {}) as Record<string, unknown>

      if (!spec.host && kind === 'email')
        throw new BadRequest(
          'Email delivery needs a mailer, and this app has none configured. ' +
          'The channel is saved; it cannot be tested yet.'
        )

      // Where the request goes. For Slack the SECRET is the URL, so the target
      // address is the host only and the secret path is supplied per-request —
      // a target address is stored in conduit's registry and echoed by
      // GET /conduit-targets, which is not a place for a bearer credential.
      let address = spec.host
      let path    = '/v2/enqueue'          // PagerDuty's Events API v2; overwritten below for the others
      let auth: Record<string, unknown> = { type: 'none' }
      let body    = spec.testBody(channel.name as string) as Record<string, unknown> | null

      if (kind === 'slack') {
        const url = await readCredential(channel.secretId as string | null, 'webhookUrl')
        if (!url) throw new BadRequest('This channel has no webhook URL stored — rotate its credential')
        const parsed = safeUrl(url)
        if (!parsed) throw new BadRequest('The stored webhook URL is not a URL')
        address = parsed.origin
        path    = parsed.pathname + parsed.search
        if (config.channel) body = { ...body, channel: config.channel }
      } else if (kind === 'pagerduty') {
        const key = await readCredential(channel.secretId as string | null, 'integrationKey')
        if (!key) throw new BadRequest('This channel has no integration key stored — rotate its credential')
        body = { ...body, routing_key: key }
      } else {
        const parsed = safeUrl(config.url as string)
        if (!parsed) throw new BadRequest('This webhook channel has no valid `url` in its config')
        address = parsed.origin
        path    = parsed.pathname + parsed.search
        // A bare webhook needs no credential. One that has a token gets it as
        // a header, by REFERENCE — the material is resolved at send time and
        // never enters the registry.
        if (channel.secretId)
          auth = { type: 'api_key', ref: secretRef(channel.secretId as string, 'token'), header: 'X-Basecamp-Token' }
      }

      const conduit = conduitOrRefuse()
      const target  = `channel:${channel.id}`
      // Re-registered on every test rather than once at boot: the address can
      // change under a rotation, and conduit's register is an upsert.
      await conduit.register({
        id:            target,
        kind:          'provider',
        protocol:      'http',
        address:       address as string,
        auth:          auth as never,
        registered_at: Date.now(),
        last_seen_at:  null,
      })

      const res = await conduit.send({ target, method: 'POST', path, body })

      if (res.error) {
        // The channel is not marked tested. That is the whole point of the
        // stamp: it means something arrived.
        throw new BadRequest(`Delivery failed (${res.error.kind}): ${res.error.message}`)
      }

      return dbOf(ctx).notificationChannel.update({
        where: { id: channel.id },
        data:  { lastTestAt: new Date().toISOString() },
      })
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Every write is admin/owner, the same bar as the secrets service: a
        // channel holds a credential that posts as the workspace, and being
        // able to add one is being able to redirect where alerts land.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), captureCredential, stampChannel],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner'), captureCredential],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Testing sends real traffic to a third party under the workspace's
        // name, so it is not a read.
        test:   [requireWorkspaceRole(app, 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })

  // ─── helpers ───────────────────────────────────────────────────────────

  /** Read one field out of a channel's Secret. asSystem() because @encrypted
   *  values are absent from a scoped read — not redacted, absent. */
  async function readCredential(secretId: string | null, field: string): Promise<string | null> {
    if (!secretId) return null
    const secret = await sys().secret.findFirst({ where: { id: secretId } })
    if (!secret?.data) return null
    try { return JSON.parse(secret.data as string)?.[field] ?? null } catch { return null }
  }
}

/**
 * Take the credential off the wire, before the schema deletes it.
 *
 * `secret` is the credential in plaintext on its way to a `Secret` row. It is
 * deliberately not a column — and Junction's derived `autoValidate(model,
 * method)` strips every key the model does not declare. **User hooks run
 * before the derived ones**, so this is the only place the key still exists: by
 * the time a method body reads `ctx.data`, it is gone.
 *
 * Silent by construction. The first version pulled it off inside `create()`
 * and the service answered "Slack needs a credential — send it as `secret`"
 * about a request that carried exactly that. The same shape is what makes
 * `ip_address` come back null on the servers service.
 */
function captureCredential(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  if (typeof data.secret === 'string' && data.secret) ctx.locals.credential = data.secret
  delete data.secret
}

/** NotificationChannel has no `slug` column, so the shared stampWorkspace —
 *  which derives one from `name` — would add a key autoValidate then strips.
 *  Stamping what this model actually has says so out loud. */
function stampChannel(ctx: ServiceContext): void {
  const data = ctx.data as Record<string, unknown>
  if (!data) return
  data.workspaceId = wsOf(ctx)
  data.createdBy   = actorOf(ctx)
}

/** A URL, or null. `new URL()` throws on anything unparseable, and a throw out
 *  of a config read reaches the caller as a 500 rather than as the 400 it is. */
function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch { return null }
}
