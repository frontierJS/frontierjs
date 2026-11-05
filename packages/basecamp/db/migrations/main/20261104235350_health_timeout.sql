-- Litestone migration
-- Created:   2026-11-04T23:53:50.306Z
-- Changes:
--     ~ app  [alter]
--         + col  healthTimeout INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "app": add columns
ALTER TABLE "app" ADD COLUMN "healthTimeout" INTEGER;

COMMIT;
PRAGMA foreign_keys = ON;