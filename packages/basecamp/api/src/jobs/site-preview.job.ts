// src/jobs/site-preview.job.ts — a draft's preview, built on the machine the
// App is placed on and uploaded to its Worker (`IDEAS/owner-editing.md` 1.3).
// Dispatched as `site:preview` by `drafts.open`, `drafts.save` and
// `drafts.preview`; the work is `domain/site/site-preview.ts`.
//
// The app's own work, dispatched `actor: null`: an editor holds a grant and no
// membership, so there is no standing to run it as, and the grant was read by
// the method that dispatched it. One attempt — a build that failed fails the
// same way again, and the next save dispatches anew. `unique` per draft, so a
// save during a build is picked up by that build's next round, not queued
// beside it.

import { defineJob }         from '@frontierjs/caravan'
import { runsAsApp }         from './context.ts'
import { buildDraftPreview } from '../domain/site/site-preview.ts'
import { BUILD_TIMEOUT_MS }  from '../providers/executor.ts'

const sitePreview = defineJob<{ appId: string; draft: string }>({
  name: 'site:preview',
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'site:preview')
    const status = await buildDraftPreview(app, ctx.data.appId, ctx.data.draft)
    app.logger.child('site-preview').info(status?.state ?? 'nothing to build', {
      appId: ctx.data.appId, draft: ctx.data.draft, commit: status?.commit ?? null, error: status?.error ?? null,
    })
  },
  maxAttempts: 1,
  // Up to three rounds of a build, each bounded by the machine's own.
  timeout:     3 * BUILD_TIMEOUT_MS,
})

export default sitePreview

/** Queue the draft's preview; a no-op while one is building, which builds the newest head anyway. */
export const dispatchPreview = (app: { jobs: { dispatch: Function } }, appId: string, draft: string) =>
  app.jobs.dispatch(sitePreview, { appId, draft }, { unique: `site:preview:${appId}:${draft}`, actor: null, tenant: null })
