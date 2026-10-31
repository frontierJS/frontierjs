-- Litestone migration
-- Created:   2026-10-31T19:54:52.757Z
-- Changes:
--     ~ claude_transcript  [alter]
--         + col  agent TEXT
--         + col  turnSkills TEXT
--     ~ claude_message  [alter]
--         + col  skills TEXT
--         + col  agent TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "claude_transcript": add columns
ALTER TABLE "claude_transcript" ADD COLUMN "agent" TEXT;
ALTER TABLE "claude_transcript" ADD COLUMN "turnSkills" TEXT NOT NULL DEFAULT '';

-- "claude_message": add columns
ALTER TABLE "claude_message" ADD COLUMN "skills" TEXT NOT NULL DEFAULT '';
ALTER TABLE "claude_message" ADD COLUMN "agent" TEXT;

-- Rows indexed before these columns existed hold none of them: re-read every
-- transcript from 0, where each message collapses onto its row and fills them.
UPDATE "claude_transcript" SET "offset" = 0;

COMMIT;
PRAGMA foreign_keys = ON;