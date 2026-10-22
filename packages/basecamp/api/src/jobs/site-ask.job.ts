// src/jobs/site-ask.job.ts — an owner's ask on a draft, run as a model's edit
// of a copy of its content (`IDEAS/owner-editing.md` 4.1). Dispatched as
// `site:ask` by `drafts.ask`; the work is `core/site-ask.ts`.
//
// The app's own work, dispatched `actor: null`, for `site:preview`'s reason:
// an editor holds a grant and no membership. One attempt — a retry would spend
// the run's budget again. `unique` per draft, so a second press while one runs
// queues nothing beside it.

import { defineJob }      from '@frontierjs/caravan'
import { runsAsApp }      from './context.ts'
import { ASK_TIMEOUT_MS, askDraft } from '../core/site-ask.ts'

const siteAsk = defineJob<{ appId: string; draft: string }>({
  name: 'site:ask',
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'site:ask')
    const status = await askDraft(app, ctx.data.appId, ctx.data.draft)
    app.logger.child('site-ask').info(status?.state ?? 'nothing queued', {
      appId: ctx.data.appId, draft: ctx.data.draft, files: status?.files.length ?? 0, cost: status?.cost ?? null, error: status?.error ?? null,
    })
  },
  maxAttempts: 1,
  // The run stops itself at ASK_TIMEOUT_MS; the export and the tree around it are git.
  timeout:     ASK_TIMEOUT_MS + 120_000,
})

export default siteAsk

export const dispatchAsk = (app: { jobs: { dispatch: Function } }, appId: string, draft: string) =>
  app.jobs.dispatch(siteAsk, { appId, draft }, { unique: `site:ask:${appId}:${draft}`, actor: null, tenant: null })
