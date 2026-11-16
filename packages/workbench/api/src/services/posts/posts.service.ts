// Post -- mirrored. create posts as the caller, update edits or pins, remove
// deletes -- each forwarded through the claim. Pass pendingPostId on create so
// a lost answer is replayed into one message rather than two. Pass
// fileExternalIds (from POST /files) to post uploads.
import { createService } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { attach } from '../../providers/chat/index.ts'

export default createService({
  model:    'Post',
  channel:  'posts',
  paginate: { default: 20, max: 500 },
  hooks: {
    // The server claimed the uploads with the post; their rows follow now
    // rather than on the socket's echo, so the sender's room draws them at once.
    after: {
      create: [async (ctx: any) => {
        const ids = (ctx.data as { fileExternalIds?: unknown } | undefined)?.fileExternalIds
        const post = ctx.result as { externalId?: string, profileExternalId?: string } | null
        if (!Array.isArray(ids) || !post?.externalId || !post.profileExternalId) return
        await attach(ctx.app as App, { externalId: post.externalId, profileExternalId: post.profileExternalId }, ids.map(String))
      }],
    },
  },
} as any)
