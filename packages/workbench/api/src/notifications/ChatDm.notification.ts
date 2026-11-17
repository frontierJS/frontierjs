// src/notifications/ChatDm.notification.ts -- a post in a direct or group-direct room the member is in.
//
// Raised by `domain/chat/notice.ts` from a live socket frame only; `held` is
// quiet hours, as in `ChatMention.notification.ts`.

import { defineNotification, inApp, push } from '@frontierjs/notifications'
import { appUrl } from './AutopilotReport.notification.ts'
import type { ChatNoticePayload } from './ChatMention.notification.ts'

export default defineNotification<ChatNoticePayload>({
  via: (p) => p.held || !p.phone ? ['inApp'] : ['inApp', 'push'],
  key: (p) => `chat:${p.postExternalId}`,

  inApp: (p) => inApp()
    .title(p.author)
    .body(p.excerpt || 'Sent you a message')
    .action('Open', p.link)
    .data({ ...p }),

  push: (p) => push()
    .title(p.author)
    .body(p.excerpt || 'Sent you a message')
    .tags('speech_balloon')
    .url(appUrl(p.link))
    .build(),
})
