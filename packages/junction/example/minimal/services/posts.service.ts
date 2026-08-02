// The minimal Junction service file — this is the whole thing.
//
// No db wiring   (inherited from app.db)
// No name        (derived from this filename: posts.service.ts → 'posts')
// No model       (resolved from the service name: 'posts' → db.post)
//
// That last one is the naming seam worth understanding, because a FrontierJS
// app spells one model three ways:
//
//   model Post          in db/schema.lite   — PascalCase singular, always
//   posts.service.ts    → service 'posts'   — the filename, and the URL
//   db.post             the Litestone accessor
//
// The accessor is tried literally first and then singularised, so
// `createBaseService({})`, `{ model: 'posts' }` and `{ model: 'post' }` all
// reach `model Post`. Name it explicitly when the mapping isn't regular
// (an @@external model mirroring a foreign table, say).
//
// In your own project this import is: '@frontierjs/junction'
import { createBaseService } from '../../../index.ts'

export function createPostsService() {
  return createBaseService({})
}
