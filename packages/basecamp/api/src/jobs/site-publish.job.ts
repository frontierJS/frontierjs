// src/jobs/site-publish.job.ts — an owner's Publish of a draft: merged, built
// and deployed on the App's placement, then the site's branch moved
// (`IDEAS/owner-editing.md` 1.4). Dispatched as `site:publish` by
// `drafts.publish`, which wrote the release row; the work is
// `core/site-publish.ts`.
//
// The app's own work, dispatched `actor: null`, as `site:preview` is: the
// publisher holds a grant and need hold no membership. One attempt, because
// a publish half done has already merged; the next press is a new release.
// `unique` per App, so two publishes of one site never merge at once.

import { defineJob }        from '@frontierjs/caravan'
import { runsAsApp }        from './context.ts'
import { runPublish }       from '../core/site-publish.ts'
import { BUILD_TIMEOUT_MS } from '../providers/executor.ts'

const sitePublish = defineJob<{ deploymentId: string }>({
  name: 'site:publish',
  queue: 'deployments',
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'site:publish')
    const { status } = await runPublish(app, ctx.data.deploymentId)
    app.logger.child('site-publish').info(status, { deploymentId: ctx.data.deploymentId })
  },
  maxAttempts: 1,
  timeout:     BUILD_TIMEOUT_MS + 300_000,
})

export default sitePublish

export const dispatchPublish = (app: { jobs: { dispatch: Function } }, appId: string, deploymentId: string) =>
  app.jobs.dispatch(sitePublish, { deploymentId }, { unique: `site:publish:${appId}`, actor: null, tenant: null, queue: 'deployments' })
