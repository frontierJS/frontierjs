-- Litestone migration (database: chat)
-- Created:   2026-11-26T02:40:10.693Z
-- Class:     expand
-- Changes:
--     ~ draft  [alter]
--         + col  hiddenAt TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "draft": add columns
ALTER TABLE "draft" ADD COLUMN "hiddenAt" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;