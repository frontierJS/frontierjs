// src/domain/notification/push-test.ts — the Workspace card's Test ping.
//
// Not a kind. A kind is what a person can be told about (`kinds.ts`), and a
// test ping tells nobody anything; making it one would add an enum value, a
// row on the preferences screen with email and in-app switches that mean
// nothing, and a file the loader stamps. So this is a definition with its
// `type:` stated, kept OUT of `notifications/` where the loader globs, and sent
// through `app.notify` to the same `{ pushTopic, transports: ['push'] }`
// recipient `notifyPeople()` builds -- the test rings the real path, builder
// and driver included, or it proves nothing.

import { defineNotification, push } from '@frontierjs/notifications'

export interface PushTestPayload {
  workspaceName: string
  /** Who pressed the button, named in the body so a phone that rings in
   *  somebody else's pocket says whose test it was. */
  by: string
  url: string
}

export default defineNotification<PushTestPayload>({
  type: 'PushTest',
  via:  () => ['push'],
  // Default priority, no tag: a test must not ring through do-not-disturb
  // (`FJS-D1588`), and a phone that stays quiet on a test is set up as it should be.
  push: (p) => push()
    .title(`Test ping — ${p.workspaceName}`)
    .body(`${p.by} pressed Test ping. Outages on this topic ring at priority 5.`)
    .url(p.url)
    .build(),
})
