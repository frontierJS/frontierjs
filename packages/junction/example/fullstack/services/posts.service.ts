// services/posts.service.ts
//
// The whole service. There is no second file.
//
//   name    ← this filename          ('posts.service.ts' → 'posts' → /api/posts)
//   model   ← the service name        ('posts' → db.post)
//   db      ← app.db, scoped per request to the calling user
//   CRUD    ← generated from the model
//   401s    ← the model's @@gate
//   400s    ← the model's field rules
//
// Everything above is derived. Nothing here restates db/schema.lite, which is
// the whole point: there is no second place for the two halves to disagree.
//
// In your own project the import is: '@frontierjs/junction'
import { createBaseService } from '../../../index.ts'

export function createPostsService() {
  return createBaseService({
    // Broadcast every mutation to the 'posts' channel. One line, declared next
    // to the service it belongs to — this used to be three steps in app.ts:
    // import publish(), build the hook, attach it to create/patch/remove
    // individually (and know that `after: { all }` would broadcast READS).
    //
    // Scope this before you ship: every connection in the channel receives
    // every row, and @@allow policies are enforced on READ, not on broadcast.
    // For per-tenant delivery use the function form:
    //   channel: (rows, ctx) => app.channel(`workspace:${ctx.auth.user.workspaceId}`)
    channel: 'posts',

    // Bulk writes are opt-in — POSTing an array
    // without this is a 400, so a missing `id` in a patch can't wipe a table by
    // accident. With it on, a bulk create returns PARTIAL SUCCESS: the rows
    // that saved in `data`, the ones that didn't in `errors`, each paired with
    // its input and the reason.
    //
    //   curl -X POST .../api/posts -H 'content-type: application/json' \
    //        -H "authorization: Bearer $TOKEN" \
    //        -d '[{"title":"fine"},{"title":""}]'
    //   → { kind:'list', data:[…1 row…], errors:[{ data:{title:''}, error:{…} }] }
    allowBulk: true,
  })
}
