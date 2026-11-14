-- Litestone migration
-- Created:   2026-11-14T17:31:27.669Z
-- Class:     unknown
-- Changes:
--     ~ blueprint  [alter]
--         + col  environment TEXT
--     ~ blueprint_param  [rebuild]
--         + col  generateLength INTEGER
--         + col  validRegex TEXT
--         ~ CHECK constraints changed (an enum's members, or an @check)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "blueprint": add columns
ALTER TABLE "blueprint" ADD COLUMN "environment" TEXT NOT NULL DEFAULT '{}';

-- rebuild "blueprint_param" — full table reconstruction required
CREATE TABLE "blueprint_param__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "blueprintId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "hint" TEXT,
  "defaultValue" TEXT,
  "isRequired" INTEGER NOT NULL DEFAULT 0,
  "isSecret" INTEGER NOT NULL DEFAULT 0,
  "generate" TEXT,
  "generateLength" INTEGER,
  "validRegex" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  CHECK ("generate" IN ('randomHex', 'randomAlphanumeric', 'randomBase64', 'uuid')),
  UNIQUE ("blueprintId", "key"),
  CHECK (generate IS NULL OR generate = 'uuid' OR generateLength IS NOT NULL),
  CHECK (generate IS NOT 'uuid' OR generateLength IS NULL),
  FOREIGN KEY ("blueprintId") REFERENCES "blueprint" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "blueprint_param__new" ("id", "blueprintId", "key", "label", "hint", "defaultValue", "isRequired", "isSecret", "generate", "position")
  SELECT "id", "blueprintId", "key", "label", "hint", "defaultValue", "isRequired", "isSecret", "generate", "position" FROM "blueprint_param";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of blueprint_param lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "blueprint_param__new") = (SELECT count(*) FROM "blueprint_param") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "blueprint_param";
ALTER TABLE "blueprint_param__new" RENAME TO "blueprint_param";

-- recreate indexes for "blueprint_param"
CREATE INDEX IF NOT EXISTS "idx_blueprint_param_blueprintId" ON "blueprint_param" ("blueprintId");

COMMIT;
PRAGMA foreign_keys = ON;