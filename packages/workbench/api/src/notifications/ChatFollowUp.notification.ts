// src/notifications/ChatFollowUp.notification.ts -- the member asked to be nudged if nobody replied to a post of theirs, and nobody has.
//
// Raised by `domain/chat/followup.ts` when the follow-up falls due. `held` is
// quiet hours, as in `ChatMention.notification.ts`.

import { defineNotification, inApp, push } from '@frontierjs/notifications'
import { appUrl } from './AutopilotReport.notification.ts'

export interface ChatFollowUpPayload {
  followUpId:        number
  postExternalId:    string
  channelExternalId: string
  /** Empty for a direct or group room, whose name is its members' ids. */
  room:              string
  /** Empty for a private room or a DM (`noticeExcerpt`). */
  excerpt:           string
  link:              string
  held:              boolean
  phone:             boolean
}

const where = (p: ChatFollowUpPayload) => p.room ? `in #${p.room}` : 'in a direct message'

export default defineNotification<ChatFollowUpPayload>({
  via: (p) => p.held || !p.phone ? ['inApp'] : ['inApp', 'push'],
  key: (p) => `followup:${p.followUpId}`,

  inApp: (p) => inApp()
    .title('Nobody has replied')
    .body(p.excerpt || `Your message ${where(p)}`)
    .action('Open', p.link)
    .data({ ...p }),

  push: (p) => push()
    .title('Nobody has replied')
    .body(p.excerpt || `Your message ${where(p)}`)
    .tags('hourglass')
    .url(appUrl(p.link))
    .build(),
})
