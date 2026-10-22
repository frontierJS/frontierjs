-- Litestone migration
-- Created:   2026-10-22T20:31:09.654Z
-- Changes:
--     ~ session  [alter]
--         + col  enrollmentOnly INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "session": add columns
ALTER TABLE "session" ADD COLUMN "enrollmentOnly" INTEGER NOT NULL DEFAULT 0;

COMMIT;
PRAGMA foreign_keys = ON;