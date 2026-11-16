// ScheduledPost -- local to this laptop: the chat server refuses scheduled
// posts unlicensed. The caller's own rows; the chat-scheduled job sends each
// one as its member when sendAt passes (`domain/chat/scheduled.ts`).
//
//   create { channelExternalId, rootExternalId?, message?, fileExternalIds?, sendAt }
//          -> the row, status scheduled; sendAt in the future, a message or a file
//   patch  { message?, fileExternalIds?, sendAt?, channelExternalId?, rootExternalId? }
//          while the row is scheduled and its send has not begun
//   patch  { status: 'cancelled' } -> cancels it; the row stays
//   remove deletes the row in any state
import { createService, BadRequest, Conflict, NotFound, $ } from '@frontierjs/junction'
import { idList, linkedCaller, oneRow } from '../../domain/chat/local.ts'

function future (v: unknown): string {
  const t = Date.parse(String(v ?? ''))
  if (!Number.isFinite(t)) throw new BadRequest('sendAt is a date and time')
  if (t <= Date.now()) throw new BadRequest('sendAt is in the past')
  return new Date(t).toISOString()
}

const hasContent = (d: { message?: unknown, fileExternalIds?: unknown }) =>
  (typeof d.message === 'string' && !!d.message.trim()) || (Array.isArray(d.fileExternalIds) && d.fileExternalIds.length > 0)

function scheduled (ctx: any): void {
  const d = oneRow(ctx, 'create')
  const { memberId, profile } = linkedCaller('scheduling a post')
  if ('status' in d && d.status !== 'scheduled') throw new BadRequest('a scheduled post starts scheduled')
  const row: Record<string, unknown> = { ...d, sendAt: future(d.sendAt), status: 'scheduled', memberId, profileExternalId: profile }
  if ('fileExternalIds' in d) row.fileExternalIds = idList(d.fileExternalIds, 'fileExternalIds')
  if (!hasContent(row)) throw new BadRequest('a scheduled post needs a message or a file')
  ctx.data = row
  ctx.system.add('memberId')
  ctx.system.add('profileExternalId')
}

async function stillScheduled (ctx: any): Promise<void> {
  const d = oneRow(ctx, 'patch')
  const cur = await ($.db as any).scheduledPost.findUnique({ where: { id: Number(ctx.id) } })
  if (!cur) throw new NotFound('no such scheduled post')
  if (cur.status !== 'scheduled') throw new Conflict(`it is ${cur.status}, not scheduled`)
  if (cur.sentAt) throw new Conflict('it is being sent')
  if ('status' in d && d.status !== 'scheduled' && d.status !== 'cancelled') throw new BadRequest('a scheduled post is only cancelled by hand')
  if (d.status === 'scheduled') delete d.status
  if ('sendAt' in d) d.sendAt = future(d.sendAt)
  if ('fileExternalIds' in d) d.fileExternalIds = idList(d.fileExternalIds, 'fileExternalIds')
  if (d.status !== 'cancelled' && !hasContent({ ...cur, ...d })) throw new BadRequest('a scheduled post needs a message or a file')
}

export default createService({
  model:    'ScheduledPost',
  channel:  'scheduledPosts',
  paginate: { default: 100, max: 500 },
  hooks: {
    before: {
      create: [scheduled],
      patch:  [stillScheduled],
      update: [stillScheduled],
    },
  },
} as any)
