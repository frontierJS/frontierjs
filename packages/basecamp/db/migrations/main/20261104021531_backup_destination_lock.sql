-- Litestone migration
-- Created:   2026-11-04T02:15:31.803Z
-- Changes:
--     ~ backup_destination  [alter]
--         + col  lockDays INTEGER
--         + col  lockAttestedAt TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "backup_destination": add columns
ALTER TABLE "backup_destination" ADD COLUMN "lockDays" INTEGER;
ALTER TABLE "backup_destination" ADD COLUMN "lockAttestedAt" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;