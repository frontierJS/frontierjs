// src/core/capabilities.ts — what each role may do on the models that declare a grid.
//
// The gate is a LADDER and this is a GRID, and they are ANDed (`FJS-D146`): a
// caller needs the level from `core/gate.ts` AND the grant from here. Neither
// subsumes the other, which is the whole reason both exist —
//
//   the ladder   answers *is this caller senior enough*, from one number, with
//                no query, which is what makes it usable at a bootstrap
//   the grid     answers *is this act theirs at all*, which a number cannot
//                express: every developer grades USER(4) and only some of them
//                are on call for the machines
//
// ─── Why a role is a DEFAULT set and not a synonym for one ─────────────────
//
// `WorkspaceMember.capabilities` is a column, so an operator may take one grant
// away from one person without inventing a role to hold the difference — which
// is the request that produces a `developer_no_reboot` role in every system that
// only has roles. The role is what a fresh membership is STAMPED with, here, and
// after that the column is the truth. `setMemberRole` re-stamps, because a role
// change is a statement about authority and leaving the old grants behind would
// make the new role mean nothing.
//
// ─── The table is bounded by the gate above it ────────────────────────────
//
// A grant a role's LEVEL cannot reach is dead: `Server.drain` is `@gate(5)`, so
// granting it to a developer (4) produces a caller who holds the capability and
// is refused by the ladder, with a message about levels. So each row here stops
// where the gate does, and `capabilityLadderAgrees()` below is the executed
// check rather than a comment claiming it.

import type { WorkspaceRole } from '../../../db/schema.d.ts'

/**
 * The grants a role is stamped with.
 *
 * Keyed by the enum in db/schema.lite. A role this map does not know is stamped
 * with NOTHING rather than defaulted upward — the same fail-closed rule
 * `WORKSPACE_ROLE_LEVEL` follows, and for the same reason: an enum value added
 * to the schema and forgotten here must refuse, not grant.
 */
const ROLE_GRANTS: Record<string, readonly string[]> = {
  // Reads the workspace; writes nothing on either model.
  viewer:    [],
  // Reads everything, writes only billing — and there is no billing model yet,
  // so it holds nothing here. It is NOT a subset of `developer` and never was,
  // which is what `refuseGrantAboveOwn` grades and a level comparison cannot
  // (`FJS-529`).
  billing:   [],
  // The machines and the environments they run in — USER(4), so the two moves
  // at `@gate(5)` are absent rather than dead.
  developer: [
    'Server.create', 'Server.update', 'Server.reboot',
    'Environment.create', 'Environment.update', 'Environment.variables',
  ],
  // ADMINISTRATOR(5) — everything a developer holds, plus the destructive half
  // and the two gated moves.
  admin:     [
    'Server.create', 'Server.update', 'Server.delete',
    'Server.reboot', 'Server.drain', 'Server.undrain',
    'Environment.create', 'Environment.update', 'Environment.delete', 'Environment.variables',
  ],
  // OWNER(6) — the same grid. What separates an owner from an administrator is
  // the workspace itself (delete it, remove the last admin), which is the
  // ladder's business and not the grid's.
  owner:     [
    'Server.create', 'Server.update', 'Server.delete',
    'Server.reboot', 'Server.drain', 'Server.undrain',
    'Environment.create', 'Environment.update', 'Environment.delete', 'Environment.variables',
  ],
}

/** What a fresh membership at this role is stamped with. A copy, so a caller
 *  editing the result cannot edit the table. */
export function grantsFor(role: WorkspaceRole | string | null | undefined): string[] {
  return [...(ROLE_GRANTS[role ?? ''] ?? [])]
}

/**
 * Is everything in `granted` also in `held`?
 *
 * The rule `refuseGrantAboveOwn` enforces, and the reason it is a SET operation:
 * *you may only hand out what you hold yourself* is exact, where *not a role
 * above your own* is an ordinal approximation that cannot see a sideways move
 * (`FJS-529`). Two roles that are peers on the ladder can hold sets neither of
 * which contains the other, and the ladder reports that as fine.
 */
export function grantsWithin(granted: Iterable<string>, held: Iterable<string>): string[] {
  const mine = held instanceof Set ? held : new Set(held)
  return [...granted].filter(g => !mine.has(g))
}

/** Every capability this app hands out, for a check that wants the whole set. */
export function allGrants(): string[] {
  return [...new Set(Object.values(ROLE_GRANTS).flat())].sort()
}
