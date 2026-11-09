-- Litestone migration
-- Created:   2026-11-09T22:03:02.201Z
-- Class:     expand
-- Changes:
--     ~ hub_config  [alter]
--         + col  logoUrl TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "hub_config": add columns
ALTER TABLE "hub_config" ADD COLUMN "logoUrl" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;