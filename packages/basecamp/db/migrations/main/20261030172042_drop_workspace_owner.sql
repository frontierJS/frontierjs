-- Litestone migration
-- Created:   2026-10-30T17:20:42.796Z
-- Changes:
--     ~ workspace  [rebuild]
--         - col  ownerId
--         ~ foreign keys changed

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns and the rows of these tables:
-- ║     workspace.ownerId
-- ║
-- ║ To keep them, copy the values before the old table is dropped, then delete this box.
-- ║ To lose them, change the "no" below to "yes".
-- ║ migrate apply refuses this file until one of the two is done.
-- ║
-- ║ Accept data loss: yes
-- ╚══════════════════════════════════════════════════════════════════════════╝
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "workspace" — full table reconstruction required
CREATE TABLE "workspace__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "type" TEXT NOT NULL DEFAULT 'team',
  "settings" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TEXT,
  "ingressAccountId" TEXT,
  "ingressZoneId" TEXT,
  "pushTopic" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  CHECK ("type" IN ('personal', 'team', 'enterprise', 'demo')),
  CHECK ("status" IN ('active', 'suspended')),
  CHECK ((ingressAccountId IS NULL) = (ingressZoneId IS NULL)),
  CHECK ((type = 'demo') = (expiresAt IS NOT NULL)),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id")
) STRICT;

INSERT INTO "workspace__new" ("id", "accountId", "name", "slug", "type", "settings", "status", "expiresAt", "ingressAccountId", "ingressZoneId", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt")
  SELECT "id", "accountId", "name", "slug", "type", "settings", "status", "expiresAt", "ingressAccountId", "ingressZoneId", "pushTopic", "version", "createdAt", "updatedAt", "deletedAt" FROM "workspace";

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

COMMIT;
PRAGMA foreign_keys = ON;