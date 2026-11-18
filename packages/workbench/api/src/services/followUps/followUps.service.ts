// FollowUp -- local to this laptop. The caller's own nudges on posts of theirs:
// the chat-followup job raises a bell row at remindAt unless someone answered
// first (`domain/chat/followup.ts`).
//
//   create { postExternalId, remindAt } -> the row, status pending; the post is the
//          caller's own, remindAt is in the future, and one post has one pending nudge
//   patch  { status: 'cancelled' } -> cancels a pending one; the row stays
//   remove deletes the row in any state
import { createService, BadRequest, Conflict, Forbidden, NotFound, $ } from '@frontierjs/junction'
import { linkedCaller, oneRow } from '../../domain/chat/local.ts'

async function followUp (ctx: any): Promise<void> {
  const d = oneRow(ctx, 'create')
  const { memberId, profile } = linkedCaller('asking to be reminded')
  if ('status' in d && d.status !== 'pending') throw new BadRequest('a follow-up starts pending')
  const id = String(d.postExternalId ?? '')
  const post = id ? await ($.db as any).post.findUnique({ where: { externalId: id }, select: { profileExternalId: true, deletedAt: true } }) : null
  if (!post || post.deletedAt) throw new NotFound('no such post')
  if (post.profileExternalId !== profile) throw new Forbidden('a reminder is for a post of your own')
  const t = Date.parse(String(d.remindAt ?? ''))
  if (!Number.isFinite(t)) throw new BadRequest('remindAt is a date and time')
  if (t <= Date.now()) throw new BadRequest('remindAt is in the past')
  if (await ($.db as any).followUp.findFirst({ where: { postExternalId: id, status: 'pending' }, select: { id: true } })) throw new Conflict('a reminder is already set on this post')
  ctx.data = { postExternalId: id, remindAt: new Date(t).toISOString(), status: 'pending', memberId, profileExternalId: profile }
  ctx.system.add('memberId')
  ctx.system.add('profileExternalId')
}

async function onlyCancel (ctx: any): Promise<void> {
  const d = oneRow(ctx, 'patch')
  const cur = await ($.db as any).followUp.findUnique({ where: { id: Number(ctx.id) } })
  if (!cur) throw new NotFound('no such reminder')
  if (cur.status !== 'pending') throw new Conflict(`it is ${cur.status}, not pending`)
  if (Object.keys(d).some(k => k !== 'status') || d.status !== 'cancelled') throw new BadRequest('a reminder is only cancelled by hand')
}

export default createService({
  model:    'FollowUp',
  channel:  'followUps',
  paginate: { default: 100, max: 500 },
  hooks: {
    before: {
      create: [followUp],
      patch:  [onlyCancel],
      update: [onlyCancel],
    },
  },
} as any)
