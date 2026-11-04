-- Litestone migration
-- Created:   2026-11-04T07:16:37.245Z
-- Changes:
--     ~ app  [alter]
--         + col  stopGrace INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "app": add columns
ALTER TABLE "app" ADD COLUMN "stopGrace" INTEGER;

COMMIT;
PRAGMA foreign_keys = ON;