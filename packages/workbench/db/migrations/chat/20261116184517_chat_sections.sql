-- Litestone migration (database: chat)
-- Created:   2026-11-16T18:45:17.336Z
-- Class:     expand
-- Changes:
--     + ChatSection  (new table)
--     ~ post  [alter]
--         + col  embeds TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "chat_section" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "profileExternalId" TEXT NOT NULL,
  "teamExternalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "channelExternalIds" TEXT NOT NULL DEFAULT '[]',
  "missingSince" TEXT,
  CHECK ("kind" IN ('favorites', 'channels', 'direct', 'custom'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_chat_section_profileExternalId_teamExternalId" ON "chat_section" ("profileExternalId", "teamExternalId");

-- ─── modified tables ───────────────────────────────────────────────

-- "post": add columns
ALTER TABLE "post" ADD COLUMN "embeds" TEXT NOT NULL DEFAULT '[]';

COMMIT;
PRAGMA foreign_keys = ON;