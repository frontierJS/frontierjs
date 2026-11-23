// src/notifications/AppCrashed.notification.ts

import { defineNotification, inApp, mail, push } from '@frontierjs/notifications'
import { declaredTransports, appUrl, marked } from './_shared.ts'

export interface AppCrashedPayload {
  appId:   string
  appName: string
  /** The thrown error's message, as the app reported it. */
  message: string
  /** The first frames of its stack; empty when the throw carried none. */
  stack:   string
  /** The machine the app died on, as the app named it. */
  host:    string
  /** Crashes inside the app's window before this one that paged nobody
   *  (`FJS-D2186`), so a loop reads as a loop and not as one crash. */
  missed:  number
}

const missedLine = (p: AppCrashedPayload) =>
  p.missed > 0 ? `Crashed ${p.missed} more time${p.missed === 1 ? '' : 's'} before this without a page.` : ''

export default defineNotification<AppCrashedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('App crashed')
    .body(`${p.appName} on ${p.host}: ${p.message}`)
    .action('View app', `/apps/${p.appId}/`)
    .context('App', p.appId)
    .data({ appName: p.appName, message: p.message, host: p.host, missed: p.missed }),

  push: (p) => push()
    .title(`${p.appName} crashed`)
    .body([p.message, missedLine(p)].filter(Boolean).join('\n'))
    .priority(5)
    .tags('rotating_light')
    .url(appUrl(`/apps/${p.appId}/`))
    .build(),

  email: (p) => {
    const m = mail()
      .subject(marked('error', `Crashed — ${p.appName}`))
      .line(`${p.appName} died of an uncaught error on ${p.host} and is restarting.`)
      .line(p.message)
    if (p.stack) m.line(p.stack)
    const missed = missedLine(p)
    if (missed) m.line(missed)
    return m.action('View app', appUrl(`/apps/${p.appId}/`))
  },
})
