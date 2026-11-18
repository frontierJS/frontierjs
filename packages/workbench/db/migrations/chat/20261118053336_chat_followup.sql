-- Litestone migration (database: chat)
-- Created:   2026-11-18T05:33:36.176Z
-- Class:     expand
-- Changes:
--     + FollowUp  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "follow_up" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "memberId" INTEGER NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "postExternalId" TEXT NOT NULL,
  "remindAt" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'raised', 'cleared', 'cancelled'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_follow_up_status_remindAt" ON "follow_up" ("status", "remindAt");
CREATE INDEX IF NOT EXISTS "idx_follow_up_memberId" ON "follow_up" ("memberId");

COMMIT;
PRAGMA foreign_keys = ON;