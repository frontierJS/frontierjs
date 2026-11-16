-- Litestone migration
-- Created:   2026-11-16T15:55:03.903Z
-- Class:     contract
-- Changes:
--     ~ member  [rebuild]
--         + col  chatToken TEXT
--         + col  profileExternalId TEXT
--         + col  chatSyncedAt TEXT
--         + UNIQUE (profileExternalId)  (rebuild; the copy fails if existing rows violate it)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "member" — full table reconstruction required
CREATE TABLE "member__new" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "nick" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "chatToken" TEXT,
  "profileExternalId" TEXT UNIQUE,
  "chatSyncedAt" TEXT
) STRICT;

INSERT INTO "member__new" ("id", "nick", "createdAt")
  SELECT "id", "nick", "createdAt" FROM "member";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of member lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "member__new") = (SELECT count(*) FROM "member") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "member";
ALTER TABLE "member__new" RENAME TO "member";

COMMIT;
PRAGMA foreign_keys = ON;