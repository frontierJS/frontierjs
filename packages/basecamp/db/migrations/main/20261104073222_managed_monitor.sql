-- Litestone migration
-- Created:   2026-11-04T07:32:22.809Z
-- Changes:
--     ~ monitor  [alter]
--         + col  isManaged INTEGER
--         + idx  (appId, isManaged)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "monitor": add columns
ALTER TABLE "monitor" ADD COLUMN "isManaged" INTEGER NOT NULL DEFAULT 0;

-- "monitor": add indexes
CREATE INDEX IF NOT EXISTS "idx_monitor_appId_isManaged" ON "monitor" ("appId", "isManaged");

COMMIT;
PRAGMA foreign_keys = ON;