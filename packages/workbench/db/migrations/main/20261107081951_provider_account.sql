-- Litestone migration
-- Created:   2026-11-07T08:19:51.465Z
-- Changes:
--     + ProviderAccount  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provider_account" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "label" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("provider" IN ('hetzner', 'digitalocean'))
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;