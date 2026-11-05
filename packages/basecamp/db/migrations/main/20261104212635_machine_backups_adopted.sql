-- Litestone migration
-- Created:   2026-11-04T21:26:35.346Z
-- Changes:
--     ~ server  [alter]
--         + col  adopted INTEGER
--     ~ server_event  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "server": add columns
ALTER TABLE "server" ADD COLUMN "adopted" INTEGER NOT NULL DEFAULT 0;

-- rebuild "server_event" — full table reconstruction required
CREATE TABLE "server_event__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "serverId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "noticeOwedAt" TEXT,
  CHECK ("kind" IN ('created', 'removed', 'rebootRequested', 'drainStarted', 'drainCancelled', 'provisionRequested', 'provisionCreated', 'provisionReady', 'provisionTimeout', 'destroyRequested', 'destroyFinished', 'enrollmentIssued', 'syncRequested', 'statusSynced', 'statusSyncIgnored', 'syncFailed', 'syncNoAccount', 'syncUnsupported', 'syncUnrecognized', 'backupsReadFailed', 'backupsSet', 'backupsRestored', 'backupsRestoreFailed', 'adopted', 'cameOnline', 'unreachable', 'rebooted', 'containerCrashLooping', 'containerRecovered', 'unitFailed', 'unitRestored', 'recipeRan', 'recipeFailed', 'cleanupQueued', 'cleanupRan', 'cleanupFailed', 'volumeRemoved', 'volumesPruned', 'postureFailed', 'postureRestored')),
  FOREIGN KEY ("serverId") REFERENCES "server" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "server_event__new" ("id", "serverId", "kind", "message", "metadata", "createdAt", "noticeOwedAt")
  SELECT "id", "serverId", "kind", "message", "metadata", "createdAt", "noticeOwedAt" FROM "server_event";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of server_event lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "server_event__new") = (SELECT count(*) FROM "server_event") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "server_event";
ALTER TABLE "server_event__new" RENAME TO "server_event";

-- recreate indexes for "server_event"
CREATE INDEX IF NOT EXISTS "idx_server_event_serverId" ON "server_event" ("serverId");
CREATE INDEX IF NOT EXISTS "idx_server_event_noticeOwedAt" ON "server_event" ("noticeOwedAt");

COMMIT;
PRAGMA foreign_keys = ON;