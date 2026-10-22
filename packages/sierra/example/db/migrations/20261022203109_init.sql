-- Litestone migration
-- Created:   2026-10-22T20:31:09.781Z
-- Changes:
--     + Account  (new table)
--     + Lead  (new table)
--     + Tag  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── implicit m2m join tables (idempotent) ────────────────────────
CREATE TABLE IF NOT EXISTS "_lead_tag" (
  "leadId" INTEGER NOT NULL REFERENCES "lead"("id") ON DELETE CASCADE,
  "tagId" INTEGER NOT NULL REFERENCES "tag"("id") ON DELETE CASCADE,
  PRIMARY KEY ("leadId", "tagId")
) STRICT;
CREATE INDEX IF NOT EXISTS "_lead_tag_tagId_idx" ON "_lead_tag"("tagId");

-- ─── new tables ────────────────────────────────────────────────────

-- db/schema.lite — the seed.
-- 
-- This file is the only place any of the following is written down. Everything
-- the example does with it is derived, at build time or at runtime:
-- 
-- the tables               ← autoMigrate(db)
-- CRUD + pagination        ← createService({}) reads the model
-- 401 / 403                ← @@gate, via junction's derived gateAuth hook
-- 400 on bad input         ← the field rules, via junction's autoValidate hook
-- make() defaults          ← generateJsonSchema → registerSchemas → the browser
-- fields / enum options    ← the same document, $ref resolved client-side
-- client-side validation   ← the same rules again, checked before the request
-- relation pickers         ← x-relations
-- which buttons to render  ← x-gate
-- 
-- Model names are PascalCase and singular — ALWAYS.
CREATE TABLE IF NOT EXISTS "account" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS "lead" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "value" REAL NOT NULL DEFAULT 0,
  "slug" TEXT UNIQUE,
  "notes" TEXT,
  "accountId" INTEGER NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("stage" IN ('new', 'contacted', 'qualified', 'won', 'lost')),
  FOREIGN KEY ("accountId") REFERENCES "account" ("id") ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS "tag" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL UNIQUE
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;