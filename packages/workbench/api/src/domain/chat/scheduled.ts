// api/src/domain/chat/scheduled.ts -- sends the scheduled posts that are due,
// each as its member through posts.create, so it reaches the chat server on
// their own token and lands in the mirror like a post typed now. The
// chat-scheduled job runs it every minute.

import type { App } from '@frontierjs/junction'

/** How long a claimed send may run before a later pass calls it cut off. */
const CUT_OFF_MS = 10 * 60_000

const reason = (err: unknown) => String((err as Error)?.message ?? err ?? 'the send failed').slice(0, 500)

export async function sendDue (app: App, now = new Date()): Promise<{ sent: number, failed: number }> {
  const sys = (app.db as any).asSystem()
  let sent = 0, failed = 0

  // A process stopped mid-send leaves the claim and no answer: whether the
  // post reached the room is unknown, so a second send could post it twice.
  const cut = await sys.scheduledPost.updateMany({
    where: { status: 'scheduled', sentAt: { not: null, lt: new Date(now.getTime() - CUT_OFF_MS).toISOString() } },
    data:  { status: 'failed', error: 'the send was cut off; check the room before scheduling it again' },
  })
  failed += cut?.count ?? 0

  const due = await sys.scheduledPost.findMany({ where: { status: 'scheduled', sentAt: null, sendAt: { lte: now.toISOString() } }, orderBy: { sendAt: 'asc' } })
  for (const row of due) {
    // The claim is the condition and the stamp in one statement, so a cancel
    // or an overlapping pass that read the same row finds it taken.
    const claim = await sys.scheduledPost.updateMany({ where: { id: row.id, status: 'scheduled', sentAt: null }, data: { sentAt: new Date().toISOString() } })
    if (claim?.count !== 1) continue
    const fail = async (error: string) => { failed++; await sys.scheduledPost.update({ where: { id: row.id }, data: { status: 'failed', error } }) }

    const member = await sys.member.findUnique({ where: { id: row.memberId }, select: { chatToken: true, profileExternalId: true } })
    if (!member?.chatToken || member.profileExternalId !== row.profileExternalId) {
      await fail('the member\'s chat link is gone; connect the chat and schedule it again')
      continue
    }
    const files = Array.isArray(row.fileExternalIds) ? row.fileExternalIds : []
    const data = { channelExternalId: row.channelExternalId, message: row.message, ...(row.rootExternalId ? { rootExternalId: row.rootExternalId } : {}), ...(files.length ? { fileExternalIds: files } : {}) }
    try {
      const post = await app.runAs(String(row.memberId), () => app.service('posts').create(data)) as { externalId?: string } | null
      if (!post?.externalId) { await fail('the chat server answered no post'); continue }
      sent++
      await sys.scheduledPost.update({ where: { id: row.id }, data: { status: 'sent', sentPostExternalId: post.externalId, sentAt: new Date().toISOString() } })
    } catch (err) {
      await fail(reason(err))
    }
  }
  return { sent, failed }
}
