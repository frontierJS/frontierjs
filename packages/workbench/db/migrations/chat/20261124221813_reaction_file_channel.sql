-- Litestone migration (database: chat)
-- Created:   2026-11-24T22:18:13.698Z
-- Class:     contract
-- Changes:
--     ~ reaction  [alter]
--         + col  channelExternalId TEXT  ⚠ NOT NULL no default
--         + idx  (channelExternalId)
--     ~ file_info  [alter]
--         + col  channelExternalId TEXT  ⚠ NOT NULL no default
--         + idx  (channelExternalId)
--
-- Each row takes its post's room. An upload no post has claimed names no room
-- here, and the server forgets it unclaimed, so it is dropped (FJS-D2209: the
-- chat database is a mirror a resync refills).


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

DELETE FROM "reaction" WHERE "postExternalId" NOT IN (SELECT "externalId" FROM "post");

-- rebuild "reaction" — full table reconstruction required
CREATE TABLE "reaction__new" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "postExternalId" TEXT NOT NULL,
  "channelExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "emojiName" TEXT NOT NULL,
  "createdAt" TEXT,
  "missingSince" TEXT
) STRICT;

INSERT INTO "reaction__new" ("id", "externalId", "postExternalId", "channelExternalId", "profileExternalId", "emojiName", "createdAt", "missingSince")
  SELECT "id", "externalId", "postExternalId", (SELECT "channelExternalId" FROM "post" WHERE "post"."externalId" = "reaction"."postExternalId"), "profileExternalId", "emojiName", "createdAt", "missingSince" FROM "reaction";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of reaction lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "reaction__new") = (SELECT count(*) FROM "reaction") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "reaction";
ALTER TABLE "reaction__new" RENAME TO "reaction";

-- recreate indexes for "reaction"
CREATE INDEX IF NOT EXISTS "idx_reaction_postExternalId" ON "reaction" ("postExternalId");
CREATE INDEX IF NOT EXISTS "idx_reaction_channelExternalId" ON "reaction" ("channelExternalId");
CREATE INDEX IF NOT EXISTS "idx_reaction_profileExternalId" ON "reaction" ("profileExternalId");


DELETE FROM "file_info" WHERE "postExternalId" IS NULL OR "postExternalId" NOT IN (SELECT "externalId" FROM "post");

-- rebuild "file_info" — full table reconstruction required
CREATE TABLE "file_info__new" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "externalId" TEXT NOT NULL UNIQUE,
  "postExternalId" TEXT,
  "channelExternalId" TEXT NOT NULL,
  "profileExternalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "extension" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "hasPreviewImage" INTEGER NOT NULL,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "deletedAt" TEXT,
  "missingSince" TEXT
) STRICT;

INSERT INTO "file_info__new" ("id", "externalId", "postExternalId", "channelExternalId", "profileExternalId", "name", "extension", "size", "mimeType", "width", "height", "hasPreviewImage", "createdAt", "updatedAt", "deletedAt", "missingSince")
  SELECT "id", "externalId", "postExternalId", (SELECT "channelExternalId" FROM "post" WHERE "post"."externalId" = "file_info"."postExternalId"), "profileExternalId", "name", "extension", "size", "mimeType", "width", "height", "hasPreviewImage", "createdAt", "updatedAt", "deletedAt", "missingSince" FROM "file_info";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of file_info lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "file_info__new") = (SELECT count(*) FROM "file_info") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "file_info";
ALTER TABLE "file_info__new" RENAME TO "file_info";

-- recreate indexes for "file_info"
CREATE INDEX IF NOT EXISTS "idx_file_info_postExternalId" ON "file_info" ("postExternalId");
CREATE INDEX IF NOT EXISTS "idx_file_info_channelExternalId" ON "file_info" ("channelExternalId");
CREATE INDEX IF NOT EXISTS "idx_file_info_profileExternalId" ON "file_info" ("profileExternalId");


COMMIT;
PRAGMA foreign_keys = ON;