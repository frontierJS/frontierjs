// tests/context-db-types.ts
// FJS-370 — compiled, not run. `ctx.locals.db` is declared by the litestone
// adapter's own module augmentation, and for its whole life the declared type
// answered `unknown` for every MODEL ACCESSOR — which is every actual data
// call. So an app got `asSystem()` typed, wrote `dbOf(ctx): any` to get any
// work done, and lost the rest of the client's safety with it.
//
// The workspace typecheck is what runs this file. A regression here is a
// compile error in `bun run typecheck`, which is the only place a type can
// fail.

import type { ServiceContext } from '../src/core/context.ts'
import '../src/core/litestone.ts'   // the augmentation lives there

export async function usesTheClient(ctx: ServiceContext) {
  // The client's own API.
  const sys = ctx.locals.db?.asSystem()

  // A model accessor and its table — the half that was `unknown`.
  const rows  = await ctx.locals.db?.post.findMany({ where: { published: true } })
  const one   = await ctx.locals.db?.post.findUnique({ where: { id: 1 } })
  const count = await ctx.locals.db?.post.count()

  // The principal. Declared, and reached without a cast.
  const actor = ctx.auth.user?.userId ?? null

  // The page a `paginate()` hook leaves behind, in the one shape `clampPage`
  // answers rather than a third spelling of it.
  const page: { limit: number; offset: number } | undefined = ctx.locals.paginate

  return { sys, rows, one, count, actor, page }
}
