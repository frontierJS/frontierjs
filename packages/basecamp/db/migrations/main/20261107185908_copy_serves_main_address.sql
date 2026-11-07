-- Litestone migration
-- Created:   2026-11-07T18:59:08.152Z
-- Changes:
--     ~ app_copy  [alter]
--         + col  isServingMainAddress INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "app_copy": add columns
ALTER TABLE "app_copy" ADD COLUMN "isServingMainAddress" INTEGER NOT NULL DEFAULT 0;

COMMIT;
PRAGMA foreign_keys = ON;