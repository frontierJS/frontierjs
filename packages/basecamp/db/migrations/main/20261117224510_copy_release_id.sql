-- Litestone migration
-- Created:   2026-11-17T22:45:10.315Z
-- Class:     expand
-- Changes:
--     ~ app_copy  [alter]
--         + col  releaseId TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "app_copy": add columns
ALTER TABLE "app_copy" ADD COLUMN "releaseId" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;