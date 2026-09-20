-- Litestone migration
-- Created:   2026-09-20T18:07:03.399Z
-- Changes:
--     + PickupPoint  (new table)
--     + CartGrant  (new table)
--     ~ product_variant  [alter]
--         + col  version INTEGER
--     ~ cart  [rebuild]
--         - col  token
--         - UNIQUE (token)
--     ~ cart_line  [rebuild]
--         - col  token

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns:
-- ║     cart.token
-- ║     cart_line.token
-- ║
-- ║ To keep them, copy the values somewhere before the old table is dropped.
-- ╚══════════════════════════════════════════════════════════════════════════╝
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- A place a customer collects an order from, and the one model in this shop
-- whose rows are found by WHERE THEY ARE.
-- 
-- The `Collect` shipping method existed with nowhere to collect from, which is
-- what this is: a shop with branches, a storefront that asks *which one is
-- near me*, and a staff screen that puts one on the map by typing two numbers.
-- 
-- `site Json @point(lat, lng)` is the whole declaration. It emits two REAL
-- generated columns over `json_extract`, a composite index on the pair, and a
-- `CHECK` that refuses a half-set coordinate and an out-of-range one — so a
-- migration, a seed and `asSystem()` are all held to it, none of which reaches
-- a validator. `near` is the only filter it answers and distance the only
-- ordering; every other operator is refused by name, because the column holds
-- JSON and JSON compares as text.
-- 
-- Readable at 0 for `ShippingMethod`'s reason and one degree sharper: a
-- storefront asks this question with no session at all, and a shop's own
-- address is public by the time it is printed on the door. `@point` warns
-- about an ungated coordinate only where the model reads above STRANGER —
-- a residential address would be that model, and this is not one
-- (`FJS-D322`).
CREATE TABLE IF NOT EXISTS "pickup_point" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "address" TEXT NOT NULL,
  "site" TEXT,
  "hours" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "siteLat" REAL GENERATED ALWAYS AS (json_extract("site", '$.lat')) VIRTUAL,
  "siteLng" REAL GENERATED ALWAYS AS (json_extract("site", '$.lng')) VIRTUAL,
  CHECK ("site" IS NULL OR (json_type("site") = 'object' AND coalesce(json_type("site", '$.lat'), '-') IN ('integer', 'real') AND coalesce(json_type("site", '$.lng'), '-') IN ('integer', 'real') AND json_extract("site", '$.lat') BETWEEN -90 AND 90 AND json_extract("site", '$.lng') BETWEEN -180 AND 180))
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_pickup_point_site" ON "pickup_point" ("siteLat", "siteLng");

-- A way into one basket.
-- 
-- The shopper holds a token; this row holds its DIGEST, keyed on the app's own
-- secret (`@frontierjs/toolbelt/bearer`). So a copy of this table is not a set
-- of live baskets, and the only place the token exists is the header the
-- browser sends.
-- 
-- Why a row rather than a column on `Cart` (`FJS-D343`): a basket handed to
-- another origin needs a SECOND way in, and minting one here is a row rather
-- than a shared secret — revoke it and that origin is out while the tab that
-- started the basket is not. It is also what lets the line policy below be an
-- ordinary foreign key instead of a copied secret.
-- 
-- No `expiresAt` and no `revokedAt`, which is a statement rather than an
-- omission: `bearerClaim` reads those columns where a model declares them, and
-- a basket's grant lives as long as the basket, which the sweep abandons.
CREATE TABLE IF NOT EXISTS "cart_grant" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "cartId" INTEGER NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("cartId") REFERENCES "cart" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_cart_grant_cartId" ON "cart_grant" ("cartId");

-- ─── modified tables ───────────────────────────────────────────────

-- "product_variant": add columns
ALTER TABLE "product_variant" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- rebuild "cart" — full table reconstruction required
CREATE TABLE "cart__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "discountId" INTEGER,
  "shippingMethodId" INTEGER,
  "handoffCode" TEXT UNIQUE,
  "handoffExpires" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ("status" IN ('open', 'ordered', 'abandoned')),
  FOREIGN KEY ("discountId") REFERENCES "discount" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("shippingMethodId") REFERENCES "shipping_method" ("id") ON DELETE SET NULL
) STRICT;

INSERT INTO "cart__new" ("id", "userId", "status", "discountId", "shippingMethodId", "handoffCode", "handoffExpires", "createdAt", "updatedAt")
  SELECT "id", "userId", "status", "discountId", "shippingMethodId", "handoffCode", "handoffExpires", "createdAt", "updatedAt" FROM "cart";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of cart lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "cart__new") = (SELECT count(*) FROM "cart") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "cart";
ALTER TABLE "cart__new" RENAME TO "cart";

-- recreate indexes for "cart"
CREATE INDEX IF NOT EXISTS "idx_cart_discountId" ON "cart" ("discountId");
CREATE INDEX IF NOT EXISTS "idx_cart_shippingMethodId" ON "cart" ("shippingMethodId");

-- rebuild "cart_line" — full table reconstruction required
CREATE TABLE "cart_line__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "cartId" INTEGER NOT NULL,
  "variantId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" INTEGER NOT NULL CHECK ("unitPrice" BETWEEN -9007199254740991 AND 9007199254740991),
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("cartId", "variantId"),
  FOREIGN KEY ("cartId") REFERENCES "cart" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE CASCADE
) STRICT;

INSERT INTO "cart_line__new" ("id", "cartId", "variantId", "quantity", "unitPrice", "createdAt")
  SELECT "id", "cartId", "variantId", "quantity", "unitPrice", "createdAt" FROM "cart_line";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of cart_line lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "cart_line__new") = (SELECT count(*) FROM "cart_line") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "cart_line";
ALTER TABLE "cart_line__new" RENAME TO "cart_line";

-- recreate indexes for "cart_line"
CREATE INDEX IF NOT EXISTS "idx_cart_line_variantId" ON "cart_line" ("variantId");

COMMIT;
PRAGMA foreign_keys = ON;