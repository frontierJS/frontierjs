// src/core/gate.ts — the one place a session becomes a number.
//
// Litestone owns the SCALE (0–7). Each app owns the mapping from its own
// principal onto it, and Basecamp's principal is not a user: it is a user IN A
// WORKSPACE. The same person is `owner` in one workspace and `viewer` in the
// next, so the level is a fact about the request, not about the row in `user`.
//
// ─── What makes this app's mapping different ──────────────────────────────
//
// `sessionGateLevel()` grades a session on standing that travels with the user
// — isSystemAdmin / isOwner / isAdmin / the lifecycle stamps. None of those can
// express *admin of THIS workspace*, so grading through it would give every
// authenticated caller USER(4) everywhere, in every workspace they are not a
// member of. This grades `WorkspaceMember.role` instead, and the role reaches
// the principal through applyStanding() in core/hooks.ts — which is what makes
// the standing per-request rather than per-user.
//
// `isSystemAdmin` still wins, because it is standing rather than membership:
// the hub tier is not a role a workspace can grant. It is also the one field
// this mapping shares with sessionGateLevel(), which is deliberate — the hub's
// own reads go through asSystem() because `User` is @@gate("8"), a level even
// SYSADMIN does not pass.
//
// ─── The ladder, and where the roles land ─────────────────────────────────
//
//   no session                          STRANGER      0
//   suspended                           STRANGER      0
//   authenticated, no workspace         VISITOR       1   reads Workspace only
//   member: viewer | billing            READER        2   reads the workspace
//   member: developer                   USER          4   apps, deploys, jobs
//   member: admin                       ADMINISTRATOR 5   servers, secrets, keys
//   member: owner                       OWNER         6   + delete the workspace
//   isSystemAdmin                       SYSADMIN      7   the hub tier
//
// CREATOR(3) is unused. Nothing here is *submit but cannot manage*: the
// narrowest role reads, and the next one up writes.
//
// The levels are not invented — they are read off the hooks that were doing
// this job in service files. `requireWorkspaceRole(app, 'developer', …)` on a
// create is what @@gate("2.4.…") says, in the schema, for every service at
// once. See DECISIONS.md § Basecamp's gate ladder.
//
// ─── Two things it deliberately does not do ───────────────────────────────
//
//   • It does not grade `pending_verification` down. Whether an unverified
//     account may sign in at all is the login door's question, and today it
//     may (core/session-auth.ts refuses `suspended` only). Grading it here
//     would refuse a user the door had already admitted, in the middle of a
//     screen, with a message about levels.
//   • It does not scope rows. A gate is per MODEL: it answers *may this caller
//     touch Server at all*, never *may they touch THAT server*. Tenancy stays
//     where it is — the workspaceId filter in every service read, and
//     scopeToWorkspace refusing a non-member before any of it runs.

import { LEVELS } from '@frontierjs/litestone'

/**
 * WorkspaceRole → level.
 *
 * Keyed by the enum in db/schema.lite. A role this map does not know is graded
 * VISITOR rather than defaulted upward: an enum value added to the schema and
 * forgotten here must fail closed, and the CHECK constraint means the only way
 * to reach that state is a migration that landed ahead of this file.
 */
export const WORKSPACE_ROLE_LEVEL: Record<string, number> = {
  viewer:    LEVELS.READER,          // 2
  billing:   LEVELS.READER,          // 2 — reads everything, writes only billing
  developer: LEVELS.USER,            // 4
  admin:     LEVELS.ADMINISTRATOR,   // 5
  owner:     LEVELS.OWNER,           // 6
}

/**
 * What the gate reads off the principal.
 *
 * `memberRole` is not a column on `user`. applyStanding() puts it on the
 * principal handed to `$setAuth`, once per request, from the WorkspaceMember
 * row for the workspace the request is FOR.
 */
export interface BasecampPrincipal {
  userId?:        string
  status?:        string
  isSystemAdmin?: boolean
  memberRole?:    string
  workspaceId?:   string
}

export function basecampGateLevel(user?: BasecampPrincipal | null): number {
  if (!user) return LEVELS.STRANGER

  // Suspension is refused at two doors already (login, and an app-level before
  // hook for a token issued earlier). This is the third, and it is the only one
  // a job calling a service in-process passes through — a hook refuses a
  // REQUEST, and the Data boundary does not take a caller's word for anything.
  if (user.status === 'suspended') return LEVELS.STRANGER

  // Standing outranks membership: the hub is not a role a workspace can grant,
  // and a system administrator with no membership anywhere is still one.
  if (user.isSystemAdmin) return LEVELS.SYSADMIN

  if (user.memberRole) return WORKSPACE_ROLE_LEVEL[user.memberRole] ?? LEVELS.VISITOR

  // Authenticated, but this request named no workspace or the caller is not in
  // it. VISITOR(1) is deliberately above STRANGER and below every workspace
  // model: it is the level that reads `Workspace` — which is how a fresh login
  // finds the workspaces it may then act in — and nothing else.
  return LEVELS.VISITOR
}

/**
 * The ladder read backwards: which role does a caller need to reach level N.
 *
 * One caller — the error mapper in app.ts, turning a `TransitionGateError` into
 * a sentence an operator can act on. Litestone owns the SCALE and says so:
 * "Transition 'drain' on Server.status requires level 5, user has level 4" is
 * exactly right and names nothing this app's screens use. A gate declared in
 * the schema is still this app's rule, so the translation back is this app's
 * job, and it reads the same table `basecampGateLevel` grades with rather than
 * a second list of role names.
 *
 * The LOWEST role that reaches the level, because a gate is a floor. A level no
 * role reaches — 7 is `isSystemAdmin`, 8 is the machine tier — has no role to
 * name and answers null, so the caller renders litestone's own sentence.
 */
export function roleForLevel(level: number): string | null {
  let best: string | null = null
  let bestLevel = Infinity
  for (const [role, roleLevel] of Object.entries(WORKSPACE_ROLE_LEVEL)) {
    if (roleLevel >= level && roleLevel < bestLevel) { best = role; bestLevel = roleLevel }
  }
  return best
}
