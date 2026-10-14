// A line said in a room — the bubble over a figure, and the tavern's history.
//
// Broadcast to the room it was said in, graded per recipient by Message's read
// policy, so a banned member receives no line and nobody receives theirs.
// `memberId` is a `@createdBy` stamp: a payload naming somebody else is
// overwritten with the caller.
import { createService, rateLimitHook } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'

import { roomChannelName } from '../rooms.ts'

type ChannelApp = App & { channel: (name: string) => unknown }

export function createMessagesService (app: App) {
  return createService({
    model:   'Message',
    methods: ['find', 'get', 'create'],
    channel: (row) => (app as ChannelApp).channel(roomChannelName((row as { roomId: number }).roomId)),
    hooks: {
      before: {
        // Per member, over either transport. A key minted in a loop is a new
        // member each time, which is the transport's per-IP limit to answer.
        create: [rateLimitHook({ max: 5, window: '10s', message: 'Slow down — five lines in ten seconds' })],
      },
    },
  })
}
