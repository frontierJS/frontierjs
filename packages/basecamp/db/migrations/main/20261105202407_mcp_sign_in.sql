-- Litestone migration
-- Created:   2026-11-06T09:18:49.603Z
-- Changes:
--     ~ workspace  [rebuild]
--         + col  ingressZone TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ credential  [alter]
--         + col  clientId TEXT
--         + col  redirectUri TEXT
--     ~ session  [rebuild]
--         + col  clientId TEXT
--         + col  refreshToken TEXT
--         + col  previousRefreshToken TEXT
--         + col  rotatedAt TEXT
--         ~ col  token  notnull: true → false
--         + UNIQUE (refreshToken)  (rebuild; the copy fails if existing rows violate it)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- A pair set before ingressZone existed has no name, only the vendor can
-- answer one (FJS-D1962), and the new CHECK refuses the copy without it. The
-- pair is cleared, and setting it again on the workspace stores the name.
UPDATE "workspace" SET "ingressSecretId" = NULL, "ingressZoneId" = NULL
  WHERE "ingressSecretId" IS NOT NULL OR "ingressZoneId" IS NOT NULL;

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
  "pushTopic" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('personal', 'team', 'enterprise', 'demo')),
  CHECK ("status" IN ('active', 'suspended')),
  CHECK ((ingressSecretId IS NULL) = (ingressZoneId IS NULL)),
  CHECK ((ingressSecretId IS NULL) = (ingressZone IS NULL)),
  CHECK ((kind = 'demo') = (expiresAt IS NOT NULL)),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id")
) STRICT;

INSERT INTO "workspace__new" ("id", "accountId", "name", "slug", "kind", "settings", "status", "expiresAt", "ingressSecretId", "ingressZoneId", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "accountId", "name", "slug", "kind", "settings", "status", "expiresAt", "ingressSecretId", "ingressZoneId", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt" FROM "workspace";

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

-- "credential": add columns
ALTER TABLE "credential" ADD COLUMN "clientId" TEXT;
ALTER TABLE "credential" ADD COLUMN "redirectUri" TEXT;

-- rebuild "session" — full table reconstruction required
CREATE TABLE "session__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "userId" TEXT NOT NULL,
  "token" TEXT UNIQUE,
  "expiresAt" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "isEnrollmentOnly" INTEGER NOT NULL DEFAULT 0,
  "reauthenticatedAt" TEXT,
  "impersonatingUserId" TEXT,
  "impersonationReason" TEXT,
  "impersonationEndsAt" TEXT,
  "clientId" TEXT,
  "refreshToken" TEXT UNIQUE,
  "previousRefreshToken" TEXT,
  "rotatedAt" TEXT,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "session__new" ("id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "isEnrollmentOnly", "reauthenticatedAt", "impersonatingUserId", "impersonationReason", "impersonationEndsAt")
  SELECT "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "isEnrollmentOnly", "reauthenticatedAt", "impersonatingUserId", "impersonationReason", "impersonationEndsAt" FROM "session";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of session lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "session__new") = (SELECT count(*) FROM "session") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "session";
ALTER TABLE "session__new" RENAME TO "session";

-- recreate indexes for "session"
CREATE INDEX IF NOT EXISTS "idx_session_userId" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "idx_session_expiresAt" ON "session" ("expiresAt");

COMMIT;
PRAGMA foreign_keys = ON;