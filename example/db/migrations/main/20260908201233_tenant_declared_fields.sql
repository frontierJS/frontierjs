-- Litestone migration
-- Created:   2026-09-09T03:12:33.325Z
-- Changes:
--     ~ product  [alter]
--         + col  fields TEXT
--     ~ customer  [rebuild]
--         + col  fieldsSlots TEXT
--         - col  slots
--         ~ col  t1  generated: "json_extract(\"slots\", '$.t1')" → "json_extract(\"fieldsSlots\", '$.t1')"
--         ~ col  t2  generated: "json_extract(\"slots\", '$.t2')" → "json_extract(\"fieldsSlots\", '$.t2')"
--         ~ col  n1  generated: "json_extract(\"slots\", '$.n1')" → "json_extract(\"fieldsSlots\", '$.n1')"
--         ~ col  t3  generated: "json_extract(\"slots\", '$.t3')" → "json_extract(\"fieldsSlots\", '$.t3')"
--         ~ col  t4  generated: "json_extract(\"slots\", '$.t4')" → "json_extract(\"fieldsSlots\", '$.t4')"
--         ~ col  n2  generated: "json_extract(\"slots\", '$.n2')" → "json_extract(\"fieldsSlots\", '$.n2')"
--         ~ col  t5  generated: "json_extract(\"slots\", '$.t5')" → "json_extract(\"fieldsSlots\", '$.t5')"
--         ~ col  t6  generated: "json_extract(\"slots\", '$.t6')" → "json_extract(\"fieldsSlots\", '$.t6')"
--         ~ col  n3  generated: "json_extract(\"slots\", '$.n3')" → "json_extract(\"fieldsSlots\", '$.n3')"
--         ~ col  t7  generated: "json_extract(\"slots\", '$.t7')" → "json_extract(\"fieldsSlots\", '$.t7')"
--         ~ col  t8  generated: "json_extract(\"slots\", '$.t8')" → "json_extract(\"fieldsSlots\", '$.t8')"
--         ~ col  n4  generated: "json_extract(\"slots\", '$.n4')" → "json_extract(\"fieldsSlots\", '$.n4')"
--         + idx  (t1, t2, n1, t3, t4, n2, t5, t6, n3, t7, t8, n4)
--         - idx  idx_customer_t1_t2_t3_t4_n1_n2_t5_t6_t7_t8_n3_n4
--     ~ custom_field  [rebuild]
--         + col  model TEXT  ⚠ NOT NULL no default
--         + col  defaultValue TEXT
--         + col  show INTEGER
--         + UNIQUE (model, key)  (rebuild; the copy fails if existing rows violate it)
--         + UNIQUE (model, slot)  (rebuild; the copy fails if existing rows violate it)
--         - UNIQUE (key)
--         - UNIQUE (slot)

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns:
-- ║     customer.slots (renamed to "fieldsSlots"?)
-- ║
-- ║ To keep them, replace the rebuild below with a rename:
-- ║     ALTER TABLE "customer" RENAME COLUMN "slots" TO "fieldsSlots";
-- ╚══════════════════════════════════════════════════════════════════════════╝
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "product": add columns
ALTER TABLE "product" ADD COLUMN "fields" TEXT NOT NULL DEFAULT '{}';

-- rebuild "customer" — full table reconstruction required
CREATE TABLE "customer__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) VIRTUAL,
  "email" TEXT NOT NULL UNIQUE,
  "notes" TEXT,
  "userId" TEXT UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "fields" TEXT NOT NULL DEFAULT '{}',
  "deletedAt" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "fieldsSlots" TEXT NOT NULL DEFAULT '{}',
  "t1" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t1')) VIRTUAL,
  "t2" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t2')) VIRTUAL,
  "n1" REAL GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.n1')) VIRTUAL,
  "t3" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t3')) VIRTUAL,
  "t4" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t4')) VIRTUAL,
  "n2" REAL GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.n2')) VIRTUAL,
  "t5" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t5')) VIRTUAL,
  "t6" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t6')) VIRTUAL,
  "n3" REAL GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.n3')) VIRTUAL,
  "t7" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t7')) VIRTUAL,
  "t8" TEXT GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.t8')) VIRTUAL,
  "n4" REAL GENERATED ALWAYS AS (json_extract("fieldsSlots", '$.n4')) VIRTUAL
) STRICT;

INSERT INTO "customer__new" ("id", "name", "firstName", "lastName", "email", "notes", "userId", "createdAt", "fields", "deletedAt", "version")
  SELECT "id", "name", "firstName", "lastName", "email", "notes", "userId", "createdAt", "fields", "deletedAt", "version" FROM "customer";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of customer lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "customer__new") = (SELECT count(*) FROM "customer") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "customer";
ALTER TABLE "customer__new" RENAME TO "customer";

-- recreate indexes for "customer"
CREATE INDEX IF NOT EXISTS "idx_customer_t1_t2_n1_t3_t4_n2_t5_t6_n3_t7_t8_n4" ON "customer" ("t1", "t2", "n1", "t3", "t4", "n2", "t5", "t6", "n3", "t7", "t8", "n4") WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_customer_deletedAt" ON "customer" ("deletedAt") WHERE "deletedAt" IS NULL;

-- rebuild "custom_field", with `model` BACKFILLED.
--
-- `migrate create` wrote this block commented out and it was right to: `model`
-- is NOT NULL with no DEFAULT, so a rebuild copying the old columns leaves every
-- existing row without one and SQLite refuses the copy. There is no expression
-- the differ could have supplied — what the old rows MEANT is a fact about this
-- app and not about the schema.
--
-- Here it is 'Customer', and it is exact rather than a guess: `key` was `@unique`
-- on its own until this change, which is only correct while ONE model has any
-- declarations, and `Customer` was that model. A second model declaring the same
-- key is the write that made the old constraint wrong, and it could not have
-- happened yet.
--
-- This is what any app adopting `@@extensible` over a live declarations table
-- pays for once, and it is a backfill rather than a migration hazard: the column
-- is new, the rows are real, and only the app knows which model they were about.

CREATE TABLE "custom_field__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "model" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "defaultValue" TEXT,
  "show" INTEGER NOT NULL DEFAULT 1,
  "slot" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("type" IN ('text', 'number')),
  UNIQUE ("model", "key"),
  UNIQUE ("model", "slot")
) STRICT;

INSERT INTO "custom_field__new" ("id", "model", "key", "label", "type", "slot", "createdAt")
  SELECT "id", 'Customer', "key", "label", "type", "slot", "createdAt" FROM "custom_field";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of custom_field lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "custom_field__new") = (SELECT count(*) FROM "custom_field") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "custom_field";
ALTER TABLE "custom_field__new" RENAME TO "custom_field";

COMMIT;
PRAGMA foreign_keys = ON;