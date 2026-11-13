-- Litestone migration
-- Created:   2026-11-13T04:30:47.979Z
-- Class:     unknown
-- Changes:
--     ~ secret  [rebuild]
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "secret" — full table reconstruction required
CREATE TABLE "secret__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'generic',
  "data" TEXT NOT NULL DEFAULT '{}',
  "verifiedAt" TEXT,
  "verifyError" TEXT,
  "createdBy" TEXT,
  "providerKind" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("kind" IN ('sshKey', 'providerKey', 'registryAuth', 'tlsCert', 'notification', 'backup', 'generic')),
  CHECK ("providerKind" IN ('custom', 'hetzner', 'digitalocean', 'cloudflare', 'github', 'anthropic')),
  UNIQUE ("workspaceId", "name"),
  CHECK (kind != 'providerKey' OR providerKind IS NOT NULL),
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "secret__new" ("id", "workspaceId", "name", "kind", "data", "verifiedAt", "verifyError", "createdBy", "providerKind", "version", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "workspaceId", "name", "kind", "data", "verifiedAt", "verifyError", "createdBy", "providerKind", "version", "createdAt", "updatedAt", "deletedAt" FROM "secret";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of secret lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "secret__new") = (SELECT count(*) FROM "secret") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "secret";
ALTER TABLE "secret__new" RENAME TO "secret";

-- recreate indexes for "secret"
CREATE INDEX IF NOT EXISTS "idx_secret_workspaceId_providerKind" ON "secret" ("workspaceId", "providerKind") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_secret_deletedAt" ON "secret" ("deletedAt") WHERE "deletedAt" IS NULL;

COMMIT;
PRAGMA foreign_keys = ON;