-- Litestone migration
-- Created:   2026-11-20T00:11:39.822Z
-- Class:     expand
-- Changes:
--     ~ member  [alter]
--         + col  agent INTEGER


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "member": add columns
ALTER TABLE "member" ADD COLUMN "agent" INTEGER NOT NULL DEFAULT 0;

COMMIT;
PRAGMA foreign_keys = ON;