// api/src/domain/chat/followup.ts -- raises the nudges that are due: a post the
// member asked to hear back on, with nobody having answered by remindAt. An
// answered one is cleared and says nothing. The chat-followup job runs it every
// minute.

import type { App } from '@frontierjs/junction'
import { raiseFollowUp } from './notice.ts'
import { answeredSince } from './waiting.ts'

export async function raiseDue (app: App, now = new Date()): Promise<{ raised: number, cleared: number }> {
  const sys = (app.db as any).asSystem()
  let raised = 0, cleared = 0

  const due = await sys.followUp.findMany({ where: { status: 'pending', remindAt: { lte: now.toISOString() } }, orderBy: { remindAt: 'asc' } })
  for (const row of due) {
    const post = await sys.post.findUnique({ where: { externalId: row.postExternalId } })
    const room = post ? await sys.channel.findUnique({ where: { externalId: post.channelExternalId }, select: { type: true } }) : null
    const quiet = !post || post.deletedAt || !room || await answeredSince(sys, post, room.type)
    // The notice is keyed on the row, so a pass cut off before it settled the row raises it once, not twice;
    // and the settle is conditional, so a cancel that landed meanwhile stands.
    if (!quiet) await raiseFollowUp(app, sys, row.id, row.memberId, row.profileExternalId, post, now)
    const settled = await sys.followUp.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: quiet ? 'cleared' : 'raised' } })
    if (settled?.count === 1) quiet ? cleared++ : raised++
  }
  return { raised, cleared }
}
