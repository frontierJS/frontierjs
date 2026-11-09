-- Litestone migration
-- Created:   2026-11-09T19:25:32.002Z
-- Class:     contract
-- Changes:
--     ~ domain_route  [rebuild]
--         + col  deletedAt TEXT
--         - UNIQUE (domainId, pathPrefix)
--         + idx  (appId)
--         + idx  (domainId, pathPrefix)
--         + idx  (deletedAt)
--         - idx  idx_domain_route_appId


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "domain_route" — full table reconstruction required
CREATE TABLE "domain_route__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "domainId" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "pathPrefix" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT,
  FOREIGN KEY ("domainId") REFERENCES "domain" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("appId") REFERENCES "app" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "domain_route__new" ("id", "workspaceId", "domainId", "appId", "pathPrefix", "createdAt", "updatedAt")
  SELECT "id", "workspaceId", "domainId", "appId", "pathPrefix", "createdAt", "updatedAt" FROM "domain_route";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of domain_route lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "domain_route__new") = (SELECT count(*) FROM "domain_route") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "domain_route";
ALTER TABLE "domain_route__new" RENAME TO "domain_route";

-- recreate indexes for "domain_route"
CREATE INDEX IF NOT EXISTS "idx_domain_route_appId" ON "domain_route" ("appId") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_domain_route_domainId_pathPrefix" ON "domain_route" ("domainId", "pathPrefix") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_domain_route_deletedAt" ON "domain_route" ("deletedAt") WHERE "deletedAt" IS NULL;

COMMIT;
PRAGMA foreign_keys = ON;