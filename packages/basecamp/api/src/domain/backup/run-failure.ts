// src/domain/backup/run-failure.ts — tell the workspace a scheduled backup or drill failed.
//
// A scheduled run has no caller to see its error: the failed row sits on a
// screen nobody opens, and the app's newest good copy quietly ages
// (`FJS-3879`). `app.backup-recent` grades the age; this is the notice at the
// moment of failure.

import type { App } from '@frontierjs/junction'
import { notifyPeople, workspaceMembers } from '../notification/notify.ts'

export async function noticeScheduledRunFailed(
  app:    App,
  target: { id: string; name: string; workspaceId: string },
  what:   'backup' | 'drill',
  error:  string | null | undefined,
): Promise<void> {
  try {
    await notifyPeople(app, 'AppBackupFailed', await workspaceMembers(app, target.workspaceId), {
      appId: target.id, appName: target.name, what, error: (error ?? 'no reason was recorded').slice(0, 500),
    }, target.workspaceId)
  } catch (err) {
    // The failed row is already written; a notice that cannot go costs nothing else.
    app.logger.child('run-failure').warn('notice not sent', { appId: target.id, reason: (err as Error).message })
  }
}
