-- Litestone migration
-- Created:   2026-11-23T16:31:11.423Z
-- Class:     unknown
-- Changes:
--     + AppChannel  (new table)
--     ~ notification  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ notification_preference  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ app  [alter]
--         + col  isCrashAlerted INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "app_channel" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("appId", "channelId"),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("channelId") REFERENCES "notification_channel" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_app_channel_channelId" ON "app_channel" ("channelId");

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "notification" — full table reconstruction required
CREATE TABLE "notification__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "deliveryKey" TEXT,
  "readAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("subjectType" IN ('Deployment', 'Alert', 'JobRun', 'Server', 'Workspace', 'Monitor', 'App')),
  UNIQUE ("userId", "type", "deliveryKey"),
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "notification__new" ("id", "userId", "type", "data", "subjectType", "subjectId", "deliveryKey", "readAt", "createdAt")
  SELECT "id", "userId", "type", "data", "subjectType", "subjectId", "deliveryKey", "readAt", "createdAt" FROM "notification";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of notification lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "notification__new") = (SELECT count(*) FROM "notification") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "notification";
ALTER TABLE "notification__new" RENAME TO "notification";

-- recreate indexes for "notification"
CREATE INDEX IF NOT EXISTS "idx_notification_userId_readAt" ON "notification" ("userId", "readAt");
CREATE INDEX IF NOT EXISTS "idx_notification_createdAt" ON "notification" ("createdAt");

-- rebuild "notification_preference" — full table reconstruction required
CREATE TABLE "notification_preference__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "email" INTEGER NOT NULL DEFAULT 0,
  "inApp" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("kind" IN ('DeploySuccess', 'DeployFailed', 'AlertFiring', 'AlertResolved', 'ServerUnreachable', 'MonitorDown', 'MonitorUp', 'PostureFailed', 'HubPostureFailed', 'DependencyVulnerable', 'MemberJoined', 'JobFailed', 'WeeklyDigest', 'ReplicaFound', 'MonitorCertExpiring', 'AppBackupFailed', 'AppCrashed')),
  UNIQUE ("userId", "kind"),
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "notification_preference__new" ("id", "userId", "kind", "email", "inApp", "updatedAt")
  SELECT "id", "userId", "kind", "email", "inApp", "updatedAt" FROM "notification_preference";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of notification_preference lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "notification_preference__new") = (SELECT count(*) FROM "notification_preference") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "notification_preference";
ALTER TABLE "notification_preference__new" RENAME TO "notification_preference";

-- recreate indexes for "notification_preference"
CREATE INDEX IF NOT EXISTS "idx_notification_preference_userId" ON "notification_preference" ("userId");

-- "app": add columns
ALTER TABLE "app" ADD COLUMN "isCrashAlerted" INTEGER NOT NULL DEFAULT 1;

COMMIT;
PRAGMA foreign_keys = ON;