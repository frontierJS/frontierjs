-- Litestone migration
-- Created:   2026-11-03T00:22:31.365Z
-- Changes:
--     ~ notification_preference  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "notification_preference" — full table reconstruction required
CREATE TABLE "notification_preference__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "email" INTEGER NOT NULL DEFAULT 0,
  "inApp" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("kind" IN ('DeploySuccess', 'DeployFailed', 'AlertFiring', 'AlertResolved', 'ServerUnreachable', 'MonitorDown', 'MonitorUp', 'PostureFailed', 'HubPostureFailed', 'DependencyVulnerable', 'MemberJoined', 'JobFailed', 'WeeklyDigest', 'ReplicaFound', 'AutopilotReport')),
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

COMMIT;
PRAGMA foreign_keys = ON;