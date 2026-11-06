-- Litestone migration
-- Created:   2026-11-06T08:10:59.488Z
-- Changes:
--     ~ workspace  [rebuild]
--         + col  ingressCertSecretId TEXT
--         + col  ingressCertExpiresAt TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ app  [alter]
--         + col  isIngressNamePublished INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "workspace" — full table reconstruction required
CREATE TABLE "workspace__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "kind" TEXT NOT NULL DEFAULT 'team',
  "settings" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TEXT,
  "ingressSecretId" TEXT,
  "ingressZoneId" TEXT,
  "ingressZone" TEXT,
  "ingressCertSecretId" TEXT,
  "ingressCertExpiresAt" TEXT,
  "pushTopic" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('personal', 'team', 'enterprise', 'demo')),
  CHECK ("status" IN ('active', 'suspended')),
  CHECK ((ingressSecretId IS NULL) = (ingressZoneId IS NULL)),
  CHECK ((ingressSecretId IS NULL) = (ingressZone IS NULL)),
  CHECK ((ingressCertSecretId IS NULL) = (ingressCertExpiresAt IS NULL)),
  CHECK ((kind = 'demo') = (expiresAt IS NOT NULL)),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id")
) STRICT;

INSERT INTO "workspace__new" ("id", "accountId", "name", "slug", "kind", "settings", "status", "expiresAt", "ingressSecretId", "ingressZoneId", "ingressZone", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "accountId", "name", "slug", "kind", "settings", "status", "expiresAt", "ingressSecretId", "ingressZoneId", "ingressZone", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt" FROM "workspace";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of workspace lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "workspace__new") = (SELECT count(*) FROM "workspace") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "workspace";
ALTER TABLE "workspace__new" RENAME TO "workspace";

-- recreate indexes for "workspace"
CREATE INDEX IF NOT EXISTS "idx_workspace_accountId" ON "workspace" ("accountId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_workspace_deletedAt" ON "workspace" ("deletedAt") WHERE "deletedAt" IS NULL;

-- "app": add columns
ALTER TABLE "app" ADD COLUMN "isIngressNamePublished" INTEGER NOT NULL DEFAULT 1;

COMMIT;
PRAGMA foreign_keys = ON;