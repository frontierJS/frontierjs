-- Litestone migration
-- Created:   2026-11-03T03:43:55.375Z
-- Changes:
--     + Notification  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "notification" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "deliveryKey" TEXT,
  "readAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("userId", "type", "deliveryKey"),
  FOREIGN KEY ("userId") REFERENCES "member" ("id") ON DELETE CASCADE
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;