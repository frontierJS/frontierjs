-- Litestone migration
-- Created:   2026-11-07T17:51:46.856Z
-- Changes:
--     ~ domain  [rebuild]
--         + col  copyCertSecretId TEXT
--         + col  copyCertExpiresAt TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ app_copy  [alter]
--         + col  certError TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "domain" — full table reconstruction required
CREATE TABLE "domain__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "isPrimary" INTEGER NOT NULL DEFAULT 0,
  "redirectTo" TEXT,
  "port" INTEGER NOT NULL DEFAULT 443,
  "isProxied" INTEGER NOT NULL DEFAULT 0,
  "sslMode" TEXT NOT NULL DEFAULT 'fullStrict',
  "certSecretId" TEXT,
  "certKind" TEXT,
  "certIssuedAt" TEXT,
  "certExpiresAt" TEXT,
  "copyCertSecretId" TEXT,
  "copyCertExpiresAt" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("sslMode" IN ('off', 'flexible', 'full', 'fullStrict')),
  CHECK ("certKind" IN ('acme', 'originCa', 'uploaded')),
  UNIQUE ("workspaceId", "hostname"),
  CHECK ((copyCertSecretId IS NULL) = (copyCertExpiresAt IS NULL)),
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "domain__new" ("id", "workspaceId", "appId", "hostname", "isPrimary", "redirectTo", "port", "isProxied", "sslMode", "certSecretId", "certKind", "certIssuedAt", "certExpiresAt", "version", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "workspaceId", "appId", "hostname", "isPrimary", "redirectTo", "port", "isProxied", "sslMode", "certSecretId", "certKind", "certIssuedAt", "certExpiresAt", "version", "createdAt", "updatedAt", "deletedAt" FROM "domain";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of domain lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "domain__new") = (SELECT count(*) FROM "domain") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "domain";
ALTER TABLE "domain__new" RENAME TO "domain";

-- recreate indexes for "domain"
CREATE INDEX IF NOT EXISTS "idx_domain_appId" ON "domain" ("appId") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_domain_deletedAt" ON "domain" ("deletedAt") WHERE "deletedAt" IS NULL;

-- "app_copy": add columns
ALTER TABLE "app_copy" ADD COLUMN "certError" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;