-- Litestone migration
-- Created:   2026-11-07T07:43:22.067Z
-- Changes:
--     ~ deployment  [alter]
--         + col  imageSha256 TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "deployment": add columns
ALTER TABLE "deployment" ADD COLUMN "imageSha256" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;