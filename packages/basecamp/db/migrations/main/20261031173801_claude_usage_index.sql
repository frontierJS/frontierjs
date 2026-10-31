-- Litestone migration
-- Created:   2026-10-31T17:38:01.608Z
-- Changes:
--     + ClaudeTranscript  (new table)
--     + ClaudeMessage  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "claude_transcript" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "path" TEXT NOT NULL UNIQUE,
  "sessionId" TEXT NOT NULL,
  "cwd" TEXT,
  "subagent" INTEGER NOT NULL DEFAULT 0,
  "headless" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT,
  "firstPrompt" TEXT,
  "offset" INTEGER NOT NULL DEFAULT 0,
  "size" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TEXT,
  "lastAt" TEXT,
  "gone" INTEGER NOT NULL DEFAULT 0,
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
  "subagent" INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_claude_message_at" ON "claude_message" ("at");
CREATE INDEX IF NOT EXISTS "idx_claude_message_cwd" ON "claude_message" ("cwd");
CREATE INDEX IF NOT EXISTS "idx_claude_message_sessionId" ON "claude_message" ("sessionId");

COMMIT;
PRAGMA foreign_keys = ON;