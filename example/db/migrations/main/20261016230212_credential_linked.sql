-- Litestone migration
-- Created:   2026-10-16T23:02:12.638Z
-- Changes:
--     ~ credential  [alter]
--         + col  linked INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "credential": add columns
ALTER TABLE "credential" ADD COLUMN "linked" INTEGER;

COMMIT;
PRAGMA foreign_keys = ON;