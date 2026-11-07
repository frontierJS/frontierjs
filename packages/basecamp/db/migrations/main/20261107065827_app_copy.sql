-- Litestone migration
-- Created:   2026-11-07T06:58:27.908Z
-- Changes:
--     + AppCopy  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "app_copy" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL UNIQUE,
  "serverId" TEXT NOT NULL,
  "cron" TEXT NOT NULL,
  "status" TEXT,
  "asOf" TEXT,
  "error" TEXT,
  "refreshedAt" TEXT,
  "requestedBy" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'running', 'success', 'failed', 'timeout')),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("serverId") REFERENCES "server" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_app_copy_serverId" ON "app_copy" ("serverId");

COMMIT;
PRAGMA foreign_keys = ON;