-- Litestone migration
-- Created:   2026-11-04T06:16:56.661Z
-- Changes:
--     ~ deployment  [rebuild]
--         + col  swap TEXT
--         + col  swapReason TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "deployment" — full table reconstruction required
CREATE TABLE "deployment__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "appId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "trigger" TEXT NOT NULL DEFAULT 'button',
  "fromImage" TEXT,
  "toImage" TEXT,
  "commitSha" TEXT,
  "commitMessage" TEXT,
  "branch" TEXT,
  "author" TEXT,
  "builtImage" TEXT,
  "swap" TEXT,
  "swapReason" TEXT,
  "platformVersion" TEXT,
  "previousDeploymentId" TEXT,
  "configSnapshot" TEXT NOT NULL DEFAULT '{}',
  "triggeredBy" TEXT,
  "queuedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "startedAt" TEXT,
  "finishedAt" TEXT,
  "durationMs" INTEGER,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'building', 'success', 'failed', 'cancelled', 'rolledBack')),
  CHECK ("trigger" IN ('button', 'push', 'laptop', 'rollback', 'rebind', 'publish', 'freeze', 'observed')),
  CHECK ("swap" IN ('startFirst', 'stopFirst')),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("triggeredBy") REFERENCES "user" ("id")
) STRICT;

INSERT INTO "deployment__new" ("id", "appId", "workspaceId", "status", "trigger", "fromImage", "toImage", "commitSha", "commitMessage", "branch", "author", "builtImage", "platformVersion", "previousDeploymentId", "configSnapshot", "triggeredBy", "queuedAt", "startedAt", "finishedAt", "durationMs", "createdAt", "updatedAt")
  SELECT "id", "appId", "workspaceId", "status", "trigger", "fromImage", "toImage", "commitSha", "commitMessage", "branch", "author", "builtImage", "platformVersion", "previousDeploymentId", "configSnapshot", "triggeredBy", "queuedAt", "startedAt", "finishedAt", "durationMs", "createdAt", "updatedAt" FROM "deployment";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of deployment lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "deployment__new") = (SELECT count(*) FROM "deployment") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "deployment";
ALTER TABLE "deployment__new" RENAME TO "deployment";

-- recreate indexes for "deployment"
CREATE INDEX IF NOT EXISTS "idx_deployment_appId" ON "deployment" ("appId");
CREATE INDEX IF NOT EXISTS "idx_deployment_workspaceId" ON "deployment" ("workspaceId");
CREATE INDEX IF NOT EXISTS "idx_deployment_status" ON "deployment" ("status");
CREATE INDEX IF NOT EXISTS "idx_deployment_triggeredBy" ON "deployment" ("triggeredBy");

COMMIT;
PRAGMA foreign_keys = ON;