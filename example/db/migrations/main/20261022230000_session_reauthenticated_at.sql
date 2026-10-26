-- Litestone migration
-- Created:   2026-10-22T23:00:00.000Z
-- Changes:
--     ~ session  [alter]
--         + col  reauthenticatedAt TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "session": add columns
ALTER TABLE "session" ADD COLUMN "reauthenticatedAt" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;