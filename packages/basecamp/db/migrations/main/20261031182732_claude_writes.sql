-- Litestone migration
-- Created:   2026-10-31T18:27:32.090Z
-- Changes:
--     + ClaudeWrite  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

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