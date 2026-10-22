-- Litestone migration
-- Created:   2026-10-22T20:31:09.706Z
-- Changes:
--     + Member  (new table)
--     + Room  (new table)
--     + Message  (new table)
--     + Game  (new table)
--     + Vote  (new table)
--     + Miss  (new table)
--     + Session  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "member" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "nick" TEXT NOT NULL UNIQUE,
  "publicKey" TEXT NOT NULL UNIQUE,
  "role" TEXT,
  "bannedAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS "room" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "pairLoId" INTEGER,
  "pairHiId" INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS "message" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "roomId" INTEGER NOT NULL,
  "memberId" INTEGER NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "toId" INTEGER,
  FOREIGN KEY ("roomId") REFERENCES "room" ("id"),
  FOREIGN KEY ("memberId") REFERENCES "member" ("id")
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_message_roomId_createdAt" ON "message" ("roomId", "createdAt");

-- The checkers a pair plays across their table (`api/src/checkers.ts`,
-- `IDEAS/haven.md` 9.1b): one row per booth, begun again in place when a game
-- is over. Written by `games` as the system and read by the pair alone, as
-- the booth's lines are -- so a move is never a thing a client says about the
-- board, only a path the service checks against the rules before it writes.
CREATE TABLE IF NOT EXISTS "game" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "roomId" INTEGER NOT NULL UNIQUE,
  "redId" INTEGER NOT NULL,
  "blackId" INTEGER NOT NULL,
  "board" TEXT NOT NULL,
  "turn" TEXT NOT NULL,
  "winnerId" INTEGER,
  "last" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("roomId") REFERENCES "room" ("id")
) STRICT;

-- A member's aye or nay on one idea of `IDEAS/overview.md`, as it stands in
-- the town hall (`IDEAS/haven.md` Phase 15). One per member and idea: a second
-- vote changes the first, and withdrawing it removes the row. Cast through
-- `votes.cast`, which also refuses an idea the hall does not hold.
CREATE TABLE IF NOT EXISTS "vote" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "memberId" INTEGER NOT NULL,
  "idea" TEXT NOT NULL,
  "aye" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("memberId", "idea"),
  FOREIGN KEY ("memberId") REFERENCES "member" ("id")
) STRICT;

-- A question the barkeep could not answer from the books (`IDEAS/haven.md`
-- 8.4). The count of these is what would justify a model behind the bar
-- (`FJS-D994`), and the words are what the docs lack. Not who asked: the
-- question is the finding, and a stranger's name beside it is nobody's use.
-- Written by `barkeep.ask` as the system; read by the owner, from the database.
CREATE TABLE IF NOT EXISTS "miss" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "question" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- What a login mints once the signature verifies (`api/src/login.ts`), and
-- what `verifySession` reads a token back to. A Grant: the token leaves in the
-- login's answer and only its digest is stored. Nothing below the system
-- reads or writes one — a member holds the token, never the row.
CREATE TABLE IF NOT EXISTS "session" (
  "tokenHash" TEXT NOT NULL UNIQUE,
  "revokedAt" TEXT,
  "lastUsedAt" TEXT,
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "memberId" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "expiresAt" TEXT NOT NULL,
  FOREIGN KEY ("memberId") REFERENCES "member" ("id")
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;