-- Litestone migration
-- Created:   2026-10-16T16:41:56.038Z
-- Changes:
--     ~ user  [rebuild]
--         - col  accountId

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns and the rows of these tables:
-- ║     user.accountId
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

-- rebuild "user" — full table reconstruction required
CREATE TABLE "user__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "role" TEXT NOT NULL DEFAULT 'user',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "isStaff" INTEGER NOT NULL DEFAULT 0,
  "isSystemAdmin" INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO "user__new" ("id", "email", "name", "emailVerified", "role", "createdAt", "updatedAt", "isStaff", "isSystemAdmin")
  SELECT "id", "email", "name", "emailVerified", "role", "createdAt", "updatedAt", "isStaff", "isSystemAdmin" FROM "user";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of user lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "user__new") = (SELECT count(*) FROM "user") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "user";
ALTER TABLE "user__new" RENAME TO "user";

COMMIT;
PRAGMA foreign_keys = ON;