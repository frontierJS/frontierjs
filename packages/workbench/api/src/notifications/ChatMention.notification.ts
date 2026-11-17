// src/notifications/ChatMention.notification.ts -- a post in a team chat room named the member.
//
// Raised by `domain/chat/notice.ts` from a live socket frame only. `held`
// is quiet hours: the bell row is still written and the push is not sent,
// nor queued for later -- a stack of pings at seven in the morning is what
// quiet hours were set to avoid.

import { defineNotification, inApp, push } from '@frontierjs/notifications'
import { appUrl } from './AutopilotReport.notification.ts'

export interface ChatNoticePayload {
  postExternalId:    string
  channelExternalId: string
  author:            string
  room:              string
  excerpt:           string
  /** `/messages/<channel>/`, with `?thread=<root>` for a reply. */
  link:              string
  held:              boolean
  /** The recipient owns the machine's one ntfy topic; anyone else gets the bell row only. */
  phone:             boolean
}

export default defineNotification<ChatNoticePayload>({
  via: (p) => p.held || !p.phone ? ['inApp'] : ['inApp', 'push'],
  // The same post on a redelivered frame writes no second row.
  key: (p) => `chat:${p.postExternalId}`,

  inApp: (p) => inApp()
    .title(`${p.author} in #${p.room}`)
    .body(p.excerpt)
    .action('Open', p.link)
    .data({ ...p }),

  push: (p) => push()
    .title(`${p.author} in #${p.room}`)
    .body(p.excerpt || 'Mentioned you')
    .tags('speech_balloon')
    .url(appUrl(p.link))
    .build(),
})
