-- Litestone migration
-- Created:   2026-11-19T20:16:08.836Z
-- Class:     contract
-- Changes:
--     ~ app  [rebuild]
--         + col  projectId TEXT  NOT NULL, an existing row's taken from its environment (FJS-D1662)
--         ~ foreign keys changed


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "app" — full table reconstruction required
CREATE TABLE "app__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'container',
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "source" TEXT NOT NULL DEFAULT '{}',
  "port" INTEGER,
  "containerPort" INTEGER,
  "volumePath" TEXT,
  "healthCheck" TEXT,
  "cpuLimit" REAL,
  "memLimitMb" INTEGER,
  "stopGraceSeconds" INTEGER,
  "healthTimeoutSeconds" INTEGER,
  "command" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("command") AND json_type("command") = 'array'),
  "hasExposedPort" INTEGER NOT NULL DEFAULT 0,
  "isIngressNamePublished" INTEGER NOT NULL DEFAULT 1,
  "swap" TEXT NOT NULL DEFAULT 'stopFirst',
  "isDeployedOnPush" INTEGER NOT NULL DEFAULT 0,
  "pushSecret" TEXT,
  "pushTokenHash" TEXT,
  "pushActorId" TEXT,
  "deployPublicKey" TEXT,
  "blueprintId" TEXT,
  "backupCron" TEXT,
  "backupDestinationId" TEXT,
  "replicaDestinationId" TEXT UNIQUE,
  "drillCron" TEXT,
  "replicaFoundAt" TEXT,
  "replicaSyncedAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('container', 'worker', 'database', 'daemon', 'cron', 'static', 'function')),
  CHECK ("status" IN ('unknown', 'stopped', 'starting', 'running', 'stopping', 'deploying', 'error')),
  CHECK ("swap" IN ('startFirst', 'stopFirst')),
  UNIQUE ("environmentId", "slug"),
  FOREIGN KEY ("environmentId") REFERENCES "environment" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("projectId") REFERENCES "project" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("blueprintId") REFERENCES "blueprint" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("backupDestinationId") REFERENCES "backup_destination" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("replicaDestinationId") REFERENCES "backup_destination" ("id") ON DELETE SET NULL
) STRICT;

INSERT INTO "app__new" ("id", "workspaceId", "environmentId", "projectId", "name", "slug", "kind", "status", "source", "port", "containerPort", "volumePath", "healthCheck", "cpuLimit", "memLimitMb", "stopGraceSeconds", "healthTimeoutSeconds", "command", "hasExposedPort", "isIngressNamePublished", "swap", "isDeployedOnPush", "pushSecret", "pushTokenHash", "pushActorId", "deployPublicKey", "blueprintId", "backupCron", "backupDestinationId", "replicaDestinationId", "drillCron", "replicaFoundAt", "replicaSyncedAt", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "workspaceId", "environmentId", (SELECT "projectId" FROM "environment" WHERE "environment"."id" = "app"."environmentId"), "name", "slug", "kind", "status", "source", "port", "containerPort", "volumePath", "healthCheck", "cpuLimit", "memLimitMb", "stopGraceSeconds", "healthTimeoutSeconds", "command", "hasExposedPort", "isIngressNamePublished", "swap", "isDeployedOnPush", "pushSecret", "pushTokenHash", "pushActorId", "deployPublicKey", "blueprintId", "backupCron", "backupDestinationId", "replicaDestinationId", "drillCron", "replicaFoundAt", "replicaSyncedAt", "createdAt", "updatedAt", "deletedAt" FROM "app";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of app lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "app__new") = (SELECT count(*) FROM "app") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "app";
ALTER TABLE "app__new" RENAME TO "app";

-- recreate indexes for "app"
CREATE INDEX IF NOT EXISTS "idx_app_workspaceId" ON "app" ("workspaceId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_environmentId" ON "app" ("environmentId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_status" ON "app" ("status") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_blueprintId" ON "app" ("blueprintId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_backupDestinationId" ON "app" ("backupDestinationId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_app_deletedAt" ON "app" ("deletedAt") WHERE "deletedAt" IS NULL;


COMMIT;
PRAGMA foreign_keys = ON;