-- Litestone migration
-- Created:   2026-11-03T03:51:44.677Z
-- Changes:
--     ~ api_key  [alter]
--         + col  publicKey TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "api_key": add columns
ALTER TABLE "api_key" ADD COLUMN "publicKey" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;