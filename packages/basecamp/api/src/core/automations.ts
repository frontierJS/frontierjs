// src/core/automations.ts — the nodes this app contributes to orion.
//
// Orion runs a workspace's flows as the member who owns them. What it cannot do
// on its own is reach a `NotificationChannel`: the credential is in a `Secret`,
// and how each kind is spoken to is `core/delivery.ts`'s, which has two callers
// already. A flow node that rendered its own Slack body would be the third copy
// of that table, so `basecamp.page` is a thin door onto `deliverToChannel`.
//
// **The channel is read as the flow's owner.** `NotificationChannel` reads at
// VIEWER(2) and is scoped to the workspace, so a flow can page only a channel
// its owner could see in that workspace — the same answer the channels screen
// gives. The Secret behind it is read through system, as the other two callers
// read it, because an `@encrypted` column is absent from a scoped read.
//
// **A dry run pages nobody** (`FJS-D283`): it answers which channel it would
// have reached, and the channel's `lastDeliveryAt` does not move.

import type { JunctionActor, INodeImplementation, NodeContext, NodeResult, PluginManifest } from '@frontierjs/orion/plugin'
import type { BasecampApp } from '../basecamp.types.ts'
import { deliverToChannel, type Message } from './delivery.ts'

const SEVERITIES = ['info', 'warning', 'critical'] as const

// Typed against orion's own contribution shape rather than inferred: an object
// literal gives `category: string`, which is not the union, and the mismatch
// surfaces at `orion({ plugins })` as a structural error about a field nobody
// got wrong.
export function basecampNodes(app: BasecampApp): { manifest: PluginManifest; implementations: INodeImplementation[] } {
  const page: INodeImplementation = {
    type: 'basecamp.page',
    async execute(ctx: NodeContext): Promise<NodeResult> {
      const actor = ctx.actor as JunctionActor | undefined
      if (!actor) return { ok: false, error: 'basecamp.page runs inside a flow, as its owner' }
      const db = actor.db as any

      const { channelId, title, text = '', severity = 'warning', dedupKey } = ctx.config as {
        channelId?: string; title?: string; text?: string; severity?: string; dedupKey?: string
      }
      if (typeof channelId !== 'string' || !channelId) return { ok: false, error: 'channelId is required' }
      if (typeof title !== 'string' || !title)         return { ok: false, error: 'title is required' }
      if (!SEVERITIES.includes(severity as never))
        return { ok: false, error: `severity must be one of ${SEVERITIES.join(', ')}` }

      const channel = await db.notificationChannel.findFirst({ where: { id: channelId } })
      // One sentence for absent and for not-yours: the owner's read is what
      // decided, and saying which would tell a flow author what another
      // workspace holds.
      if (!channel)                  return { ok: false, error: `No channel '${channelId}' this flow's owner can page` }
      if (channel.isActive === false) return { ok: false, error: `Channel '${channel.name}' is switched off` }

      if (ctx.dryRun) return { ok: true, data: { channel: channel.name, sent: false } }

      const sys = db.asSystem()
      const msg: Message = {
        title, text: String(text), severity: severity as Message['severity'], action: 'trigger',
        ...(typeof dedupKey === 'string' && dedupKey ? { dedupKey } : {}),
      }
      const res = await deliverToChannel({ conduit: app.conduit as never, sys: () => sys }, channel, msg)
      // A refused delivery is the receiver's answer and is not retried here —
      // conduit already retried the transport, and a flow wanting another try
      // says so on an error edge.
      if (!res.ok) return { ok: false, error: res.error }

      await sys.notificationChannel.update({
        where: { id: channel.id },
        data:  { lastDeliveryAt: new Date().toISOString(), version: channel.version },
      })
      return { ok: true, data: { channel: channel.name, sent: true } }
    },
  }

  return {
    manifest: {
      id: 'basecamp', name: 'Basecamp', version: '0.0.0',
      nodes: [{
        type:        'basecamp.page',
        category:    'data',
        label:       'Page a channel',
        description: "Posts to one of this workspace's notification channels — Slack, PagerDuty or a webhook — as the flow's owner.",
        configSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string' },
            title:     { type: 'string' },
            text:      { type: 'string' },
            severity:  { type: 'string', enum: [...SEVERITIES] },
            dedupKey:  { type: 'string' },
          },
          required: ['channelId', 'title'],
        },
        outputSchema: {
          type: 'object',
          properties: { channel: { type: 'string' }, sent: { type: 'boolean' } },
        },
      }],
    },
    implementations: [page],
  }
}
