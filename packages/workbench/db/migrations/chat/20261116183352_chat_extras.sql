-- Litestone migration (database: chat)
-- Created:   2026-11-16T18:33:52.006Z
-- Class:     unknown
-- Changes:
--     + Draft  (new table)
--     + SavedPost  (new table)
--     ~ profile  [rebuild]
--         + col  status TEXT
--         + col  statusManual INTEGER
--         + col  lastActivityAt TEXT
--         + col  dndEndAt TEXT
--         + col  customEmoji TEXT
--         + col  customText TEXT
--         + col  customExpiresAt TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ channel_member  [alter]
--         + col  isFavorite INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "draft" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "profileExternalId" TEXT NOT NULL,
  "channelExternalId" TEXT NOT NULL,
  "rootExternalId" TEXT,
  "message" TEXT NOT NULL,
  "props" TEXT NOT NULL,
  "fileExternalIds" TEXT NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_draft_profileExternalId" ON "draft" ("profileExternalId");

CREATE TABLE IF NOT EXISTS "saved_post" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "profileExternalId" TEXT NOT NULL,
  "postExternalId" TEXT NOT NULL,
  "missingSince" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_saved_post_profileExternalId" ON "saved_post" ("profileExternalId");

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "profile" — full table reconstruction required
CREATE TABLE "profile__new" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "username" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "email" TEXT,
  "roles" TEXT NOT NULL,
  "locale" TEXT,
  "isBot" INTEGER NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "status" TEXT,
  "statusManual" INTEGER NOT NULL DEFAULT 0,
  "lastActivityAt" TEXT,
  "dndEndAt" TEXT,
  "customEmoji" TEXT,
  "customText" TEXT,
  "customExpiresAt" TEXT,
  "missingSince" TEXT,
  CHECK ("status" IN ('online', 'away', 'offline', 'dnd'))
) STRICT;

INSERT INTO "profile__new" ("id", "externalId", "username", "firstName", "lastName", "nickname", "email", "roles", "locale", "isBot", "createdAt", "updatedAt", "deletedAt", "missingSince")
  SELECT "id", "externalId", "username", "firstName", "lastName", "nickname", "email", "roles", "locale", "isBot", "createdAt", "updatedAt", "deletedAt", "missingSince" FROM "profile";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of profile lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "profile__new") = (SELECT count(*) FROM "profile") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "profile";
ALTER TABLE "profile__new" RENAME TO "profile";

-- "channel_member": add columns
ALTER TABLE "channel_member" ADD COLUMN "isFavorite" INTEGER NOT NULL DEFAULT 0;

COMMIT;
PRAGMA foreign_keys = ON;