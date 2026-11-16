-- Litestone migration
-- Created:   2026-11-16T16:28:49.103Z
-- Class:     expand
-- Changes:
--     + VariableVersion  (new table)
--     ~ variable  [alter]
--         + col  revision INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "variable_version" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "workspaceId" TEXT NOT NULL,
  "variableId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "secretValue" TEXT NOT NULL,
  "revokedAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("variableId", "revision"),
  FOREIGN KEY ("variableId") REFERENCES "variable" ("id") ON DELETE CASCADE
) STRICT;

-- ─── modified tables ───────────────────────────────────────────────

-- "variable": add columns
ALTER TABLE "variable" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

COMMIT;
PRAGMA foreign_keys = ON;