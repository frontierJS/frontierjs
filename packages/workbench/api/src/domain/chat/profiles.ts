// api/src/domain/chat/profiles.ts -- a person's chat profile picture, as a raw
// route (a service answers JSON only).
//
//   GET /profiles/{id}/image   the bytes, to a signed-in member who may read the Profile
//
// The browser never asks the chat server for a picture: it asks this route,
// which reads the Profile through the service first (so the schema's @@allow
// decides, and a row they may not read is a 404 like one that does not exist)
// and then asks the server with the caller's own token.

import type { App, RouteHandler } from '@frontierjs/junction'
import { profileImageOf } from '../../providers/chat/index.ts'

export const PROFILE_IMAGE_PATH = '/profiles/{id}/image'

type Person = { externalId: string, deletedAt: string | null }

export const profileImageRoute = (app: App): RouteHandler => async (ctx: any) => {
  if (!ctx.user) return ctx.json({ message: 'Sign in first' }, 401)
  const id = String(ctx.route.id)

  const page = await (app as any).service('profiles').find({ externalId: id }, { directives: { limit: 1 } }) as { data?: Person[] }
  const person = page.data?.[0]
  if (!person || person.deletedAt) return ctx.json({ message: 'Not found' }, 404)

  const { bytes, type, error } = await profileImageOf(app, person.externalId)
  if (!bytes) {
    return error?.kind === 'gone' || error?.kind === 'forbidden'
      ? ctx.json({ message: 'Not found' }, 404)
      : ctx.json({ message: `The chat server did not answer the picture (${error?.kind ?? 'no answer'})` }, 502)
  }

  // A picture changes rarely and the URL carries no version, so an hour is how stale one may draw.
  return new Response(new Uint8Array(bytes), { headers: {
    'content-type':           type ?? 'image/png',
    'x-content-type-options': 'nosniff',
    'content-disposition':    'inline',
    'cache-control':          'private, max-age=3600',
  } })
}
