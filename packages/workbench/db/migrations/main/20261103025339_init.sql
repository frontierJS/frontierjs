-- Litestone migration
-- Created:   2026-11-03T02:53:39.686Z
-- Changes:
--     + Member  (new table)
--     + Session  (new table)
--     + ClaudeTranscript  (new table)
--     + ClaudeMessage  (new table)
--     + ClaudeWrite  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- Whoever signed in at the door. One row on a laptop; a table so the principal
-- is read the way every other app's is, and so a second person is a row.
CREATE TABLE IF NOT EXISTS "member" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "nick" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- What the login mints (`api/src/login.ts`), and what `verifySession` reads a
-- token back to. A Grant: the token leaves in the login's answer and only its
-- digest is stored. Nothing below the system reads or writes one.
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
CREATE INDEX IF NOT EXISTS "idx_session_memberId" ON "session" ("memberId");

CREATE TABLE IF NOT EXISTS "claude_transcript" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "path" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "cwd" TEXT,
  "isSubagent" INTEGER NOT NULL DEFAULT 0,
  "agent" TEXT,
  "isHeadless" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT,
  "firstPrompt" TEXT,
  "offset" INTEGER NOT NULL DEFAULT 0,
  "turnSkills" TEXT NOT NULL DEFAULT '',
  "size" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TEXT,
  "lastAt" TEXT,
  "isGone" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_claude_transcript_sessionId" ON "claude_transcript" ("sessionId");
CREATE INDEX IF NOT EXISTS "idx_claude_transcript_cwd" ON "claude_transcript" ("cwd");

CREATE TABLE IF NOT EXISTS "claude_message" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "messageId" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "cwd" TEXT,
  "model" TEXT NOT NULL,
  "at" TEXT NOT NULL,
  "input" INTEGER NOT NULL,
  "cacheWrite" INTEGER NOT NULL,
  "cacheWrite1h" INTEGER NOT NULL DEFAULT 0,
  "cacheRead" INTEGER NOT NULL,
  "output" INTEGER NOT NULL,
  "tools" TEXT NOT NULL DEFAULT '',
  "skills" TEXT NOT NULL DEFAULT '',
  "isSubagent" INTEGER NOT NULL DEFAULT 0,
  "agent" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_claude_message_at" ON "claude_message" ("at");
CREATE INDEX IF NOT EXISTS "idx_claude_message_cwd" ON "claude_message" ("cwd");
CREATE INDEX IF NOT EXISTS "idx_claude_message_sessionId" ON "claude_message" ("sessionId");

CREATE TABLE IF NOT EXISTS "claude_write" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "action" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "project" TEXT,
  "scope" TEXT,
  "keys" TEXT NOT NULL DEFAULT '',
  "before" TEXT,
  "digest" TEXT,
  "undoneAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_claude_write_createdAt" ON "claude_write" ("createdAt");

COMMIT;
PRAGMA foreign_keys = ON;