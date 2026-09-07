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
//
// **HOW a channel is reached lives in `core/delivery.ts`, not here.** The alert
// evaluator is its second caller, and a per-kind table in two places is a kind
// added to one of them — tests green, never delivers.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, ws, actor }
  from '../../core/resource.ts'
import { KINDS, deliverToChannel, testMessage } from '../../core/delivery.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

export function createChannelsService(app: BasecampApp) {

  /** The system client, typed once. `Secret.data` is `@encrypted`, so every
   *  read and write of the material has to go through `asSystem()` — the column
   *  is absent from the row a scoped client would produce, and absent from the
   *  one it would write. `litestone types` would make this unnecessary; until
   *  then it is one cast rather than four. */
  const sys = (): any => $.db.asSystem()

  /** A channel plus how many rules deliver through it. The count is what makes
   *  a channel legible — an unused channel and one carrying every page-out look
   *  identical without it, and it is also what `remove` refuses on. */
  async function withRuleCount(channel: Record<string, unknown>) {
    const rule_count = await db().alertRuleChannel.count({ where: { channelId: channel.id } })
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
    kind:  string,
    name:  string,
    value: string,
  ): Promise<string> {
    const field  = KINDS[kind].secretField as string
    // asSystem(): Secret.data is @encrypted, so a scoped client cannot write it
    // back either — the column is absent from the row it would produce.
    const secret = await sys().secret.create({
      data: {
        workspaceId: ws(),
        // The unique is [workspaceId, name] and a channel's name is already
        // unique in the workspace, so this cannot collide where the channel did
        // not. The prefix keeps it out of the way of secrets a person authored.
        name:      `channel:${name}`,
        kind:      'notification',
        data:      JSON.stringify({ [field]: value }),
        createdBy: actor(),
      },
    })
    return secret.id as string
  }

  return createService({
    name:  'channels',
    model: 'NotificationChannel',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const kind     = $.query.kind as string | undefined
      // The wire carries strings and the column is a boolean; comparing them
      // raw matches nothing and reports an empty list rather than an error.
      const isActive = $.query.isActive as string | boolean | undefined

      const page = await findScoped('notificationChannel', {
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
        (page.data as Record<string, unknown>[]).map(row => withRuleCount(row))
      )
      return { ...page, data }
    },

    async get() {
      return withRuleCount(await getScoped('notificationChannel', 'Channel'))
    },

    async create() {
      const data = $.data as Record<string, unknown>
      const kind = data.kind as string
      const spec = KINDS[kind]
      // The schema's CHECK already refuses an unknown kind and autoValidate
      // refuses it before this runs. This guard is about THIS table being
      // complete: a kind declared in the enum with no spec here would accept a
      // credential it could never send.
      if (!spec) throw new BadRequest(`kind must be one of ${Object.keys(KINDS).join(', ')}`)

      if (await db().notificationChannel.exists({ where: { workspaceId: ws(), name: data.name } }))
        throw new Conflict(`A channel named '${data.name}' already exists in this workspace`)

      // `secret` is @transient — validated by the model's own rules and lifted
      // off the payload by autoValidate, so `data` is columns only.
      const credential = $.transients.secret as string | undefined

      if (spec.secretField && kind !== 'webhook' && !credential)
        throw new BadRequest(`${spec.label} needs a credential — send it as \`secret\``)
      if (credential && !spec.secretField)
        throw new BadRequest(`${spec.label} channels carry no credential`)

      if (credential)
        data.secretId = await storeCredential(kind, data.name as string, credential)

      return withRuleCount(await db().notificationChannel.create({ data }))
    },

    async patch() {
      const channel = await getScoped('notificationChannel', 'Channel')
      const data    = $.data as Record<string, unknown>

      // Rotating the credential is allowed and is most of why patch exists.
      const credential = $.transients.secret as string | undefined

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
            channel.kind as string, channel.name as string, credential
          )
        }
      }

      if (changesNothing(patch)) return withRuleCount(channel)
      return withRuleCount(await db().notificationChannel.update({
        where: { id: channel.id }, data: patch,
      }))
    },

    async remove() {
      const channel = await getScoped('notificationChannel', 'Channel')

      // Refused rather than cascaded — the same call the networks service
      // makes about a populated network. The FK WOULD cascade the join rows,
      // which is right for integrity and wrong as a default: silently
      // unhooking a rule from the only place it pages anyone is how an alert
      // stops reaching a human without anybody deciding it should.
      const attached = await db().alertRuleChannel.count({ where: { channelId: channel.id } })
      if (attached > 0)
        throw new Conflict(`${attached} alert rule(s) still deliver here — detach them first`)

      const removed = await removeScoped('notificationChannel', 'Channel')

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
    async rules() {
      const channel = await getScoped('notificationChannel', 'Channel')
      $.dispatch = false

      const rows = await db().alertRuleChannel.findMany({
        where:   { channelId: channel.id },
        include: { rule: true },
        orderBy: { createdAt: 'asc' },
      })
      return { total: rows.length, data: rows }
    },

    // ── test ──────────────────────────────────────────────────────────
    // Deliver a test notification, for real, through app.conduit — the same
    // path an alert takes, because a test down a second path is a test of the
    // second path.
    async test() {
      const channel = await getScoped('notificationChannel', 'Channel')

      const res = await deliverToChannel(
        { conduit: app.conduit as never, sys },
        channel,
        testMessage(channel.name as string),
      )
      // The channel is not marked tested on a failure. That is the whole point
      // of the stamp: it means something arrived.
      if (!res.ok) throw new BadRequest(res.error)

      return db().notificationChannel.update({
        where: { id: channel.id },
        data:  { lastTestAt: new Date().toISOString(), version: channel.version },
      })
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        // Every write is admin/owner, the same bar as the secrets service: a
        // channel holds a credential that posts as the workspace, and being
        // able to add one is being able to redirect where alerts land.
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampChannel],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Testing sends real traffic to a third party under the workspace's
        // name, so it is not a read.
        test:   [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })

}

/** NotificationChannel has no `slug` column, so the shared deriveSlug —
 *  which derives one from `name` — would add a key autoValidate then strips.
 *  Stamping what this model actually has says so out loud. */
function stampChannel(): void {
  const data = $.data as Record<string, unknown>
  if (!data) return
  data.createdBy   = actor()
}
