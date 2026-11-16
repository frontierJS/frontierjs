// api/src/domain/chat/local.ts -- what the chat's laptop-only services share:
// who the caller is on the chat server, and the checks their hooks make.

import { BadRequest, $ } from '@frontierjs/junction'

/** The caller's member id and chat profile; a member who has not linked the chat has no profile to own a row. */
export function linkedCaller (what: string): { memberId: number, profile: string } {
  const me = $.me as { id?: string | number, profileExternalId?: string | null } | null | undefined
  if (!me?.profileExternalId) throw new BadRequest(`link the team chat before ${what}`)
  return { memberId: Number(me.id), profile: me.profileExternalId }
}

/** One write at a time: a bulk create or patch would skip the per-row checks. */
export function oneRow (ctx: { data?: unknown, id?: unknown }, verb: 'create' | 'patch'): Record<string, unknown> {
  if (verb === 'patch' && ctx.id == null) throw new BadRequest('change one row at a time, by id')
  if (!ctx.data || typeof ctx.data !== 'object' || Array.isArray(ctx.data)) throw new BadRequest('send one row')
  return ctx.data as Record<string, unknown>
}

/** A list of the chat server's ids, as a group's people or a post's files are held. */
export function idList (v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) throw new BadRequest(`${key} is a list of ids`)
  return [...new Set(v as string[])]
}
