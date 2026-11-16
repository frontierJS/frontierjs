-- Litestone migration (database: chat)
-- Created:   2026-11-16T19:24:53.291Z
-- Class:     expand
-- Changes:
--     + ScheduledPost  (new table)
--     + ChatGroup  (new table)
--     + QuietSchedule  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "scheduled_post" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "memberId" INTEGER NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "channelExternalId" TEXT NOT NULL,
  "rootExternalId" TEXT,
  "message" TEXT NOT NULL DEFAULT '',
  "fileExternalIds" TEXT NOT NULL DEFAULT '[]',
  "sendAt" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "error" TEXT,
  "sentPostExternalId" TEXT,
  "sentAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('scheduled', 'sent', 'failed', 'cancelled'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_scheduled_post_status_sendAt" ON "scheduled_post" ("status", "sendAt");
CREATE INDEX IF NOT EXISTS "idx_scheduled_post_memberId" ON "scheduled_post" ("memberId");

CREATE TABLE IF NOT EXISTS "chat_group" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "handle" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "profileExternalIds" TEXT NOT NULL DEFAULT '[]',
  "createdByProfileExternalId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS "quiet_schedule" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "profileExternalId" TEXT NOT NULL UNIQUE,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "days" TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  "fromMinute" INTEGER NOT NULL,
  "toMinute" INTEGER NOT NULL,
  "timezone" TEXT NOT NULL
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;