// ChatGroup -- local to this laptop: the chat server refuses groups
// unlicensed. Every member reads every group; its creator alone changes it.
// The composer expands @handle into the people's @usernames at send.
//
//   create { handle, name, profileExternalIds } -> the row; handle unique, [a-z0-9-]
//   patch  { handle?, name?, profileExternalIds? }  (the creator only)
//   remove                                         (the creator only)
import { createService } from '@frontierjs/junction'
import { idList, linkedCaller, oneRow } from '../../domain/chat/local.ts'

function made (ctx: any): void {
  const d = oneRow(ctx, 'create')
  const { profile } = linkedCaller('making a group')
  ctx.data = { ...d, profileExternalIds: idList(d.profileExternalIds ?? [], 'profileExternalIds'), createdByProfileExternalId: profile }
  ctx.system.add('createdByProfileExternalId')
}

function changed (ctx: any): void {
  const d = oneRow(ctx, 'patch')
  if ('profileExternalIds' in d) d.profileExternalIds = idList(d.profileExternalIds, 'profileExternalIds')
}

export default createService({
  model:    'ChatGroup',
  channel:  'chatGroups',
  paginate: { default: 200, max: 500 },
  hooks: { before: { create: [made], patch: [changed], update: [changed] } },
} as any)
