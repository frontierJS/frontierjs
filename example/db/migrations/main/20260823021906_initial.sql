-- Litestone migration
-- Created:   2026-08-23T09:19:06.696Z
-- Changes:
--     + Product  (new table)
--     + Colour  (new table)
--     + ProductVariant  (new table)
--     + ProductImage  (new table)
--     + Customer  (new table)
--     + Order  (new table)
--     + Cart  (new table)
--     + CartLine  (new table)
--     + StockReservation  (new table)
--     + InventoryMovement  (new table)
--     + Notification  (new table)

PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- A Product is the FAMILY, not the thing with a price on it. "FrontierJS Tee"
-- is a product; the navy one in medium is what a person puts in a basket and
-- what a warehouse counts down.
-- 
-- That split is why `sku`, `price` and `barcode` are NOT on this model. They
-- were, while every product was one buyable thing — and the moment one design
-- carried four colourways, a price on the family had no answer.
CREATE TABLE IF NOT EXISTS "product" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "brand" TEXT NOT NULL,
  "active" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("brand" IN ('frontierjs', 'junction', 'litestone'))
) STRICT;

-- The colourways this shop has run. `ProductVariant.colour` stores the NAME
-- rather than a foreign key, because the value has to outlive the row: a
-- colourway that is retired is still what the navy tees in the warehouse are,
-- and a deleted row must not take that answer with it.
CREATE TABLE IF NOT EXISTS "colour" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "hex" TEXT,
  "retired" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- The buyable thing. One row per option combination, and the row a basket
-- line, a price and a stock count all point at.
CREATE TABLE IF NOT EXISTS "product_variant" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "productId" INTEGER NOT NULL,
  "sku" TEXT NOT NULL UNIQUE,
  "colour" TEXT NOT NULL DEFAULT 'Default',
  "size" TEXT NOT NULL DEFAULT 'one',
  "price" REAL NOT NULL,
  "barcode" TEXT UNIQUE,
  "stock" INTEGER NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("size" IN ('one', 'xs', 's', 'm', 'l', 'xl', 'xxl')),
  UNIQUE ("productId", "colour", "size"),
  FOREIGN KEY ("productId") REFERENCES "product" ("id") ON DELETE CASCADE
) STRICT;

-- A photograph. The bytes live in object storage and this column holds the
-- reference — `File` is the type that means that, and `FileStorage` in
-- api/db.ts is what turns a path or an upload into one.
CREATE TABLE IF NOT EXISTS "product_image" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "productId" INTEGER NOT NULL,
  "variantId" INTEGER,
  "file" TEXT NOT NULL,
  "alt" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY ("productId") REFERENCES "product" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS "customer" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) VIRTUAL,
  "email" TEXT NOT NULL UNIQUE,
  "notes" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS "order" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "reference" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "total" REAL NOT NULL DEFAULT 0,
  "note" TEXT,
  "customerId" INTEGER NOT NULL,
  "trackingCode" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('pending', 'paid', 'shipped', 'refunded', 'cancelled')),
  FOREIGN KEY ("customerId") REFERENCES "customer" ("id") ON DELETE CASCADE
) STRICT;

-- A basket, and the one model in this app owned by NOBODY.
-- 
-- A shopper is a stranger — no account, no session, level 0 — and a stranger
-- still has to be the only person who can see their own basket. That cannot
-- be `userId == auth().id`, because there is no `auth().id` to compare, and it
-- must not be a service reading through `asSystem()`, because access is
-- declared in the schema and not in hooks (Invariant 6).
-- 
-- So the owner is a BEARER TOKEN, and `api/cart-claim.ts` turns the header
-- carrying it into a claim on the principal before the Data boundary scopes
-- the client. `auth().cartToken` is then a claim a stranger holds, and the
-- policies below are ordinary row policies over it.
-- 
-- The token is `@guarded`: the app writes it, `asSystem()` reads it, and no
-- caller ever gets it back in a response — the browser knows it because it
-- was handed it once, at creation, by the service that minted it.
CREATE TABLE IF NOT EXISTS "cart" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updatedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ("status" IN ('open', 'ordered', 'abandoned'))
) STRICT;
-- Auto-update updatedAt on every row change
CREATE TRIGGER IF NOT EXISTS "cart_updatedAt"
AFTER UPDATE ON "cart"
WHEN NEW."updatedAt" IS OLD."updatedAt"
BEGIN
  UPDATE "cart" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;
END;

-- One line. The quantity and the PRICE THE SHOPPER WAS SHOWN, which is not
-- the same fact as the variant's price today — a basket left overnight must
-- either honor what it quoted or say out loud that it changed, and it can do
-- neither if the number was never written down.
CREATE TABLE IF NOT EXISTS "cart_line" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "cartId" INTEGER NOT NULL,
  "variantId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unitPrice" REAL NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "token" TEXT NOT NULL,
  UNIQUE ("cartId", "variantId"),
  FOREIGN KEY ("cartId") REFERENCES "cart" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE CASCADE
) STRICT;

-- Stock set aside for one basket, until a moment.
-- 
-- ─── Why this is a row and not a column on CartLine ──────────────────────
-- 
-- It would fit there — a line already names a variant and a quantity, and an
-- `heldUntil` column would have been three characters of schema. It is wrong
-- for one reason and the reason is a POLICY: CartLine is scoped by the
-- shopper's token (`@@allow('read', token == auth().cartToken)`), and
-- availability is a sum over *everybody's* holds. Summing CartLine from a
-- shopper's own client answers a sum over their own basket — a number that is
-- always plausible, usually zero, and never the one asked for. It is the exact
-- shape the house rule warns about: a wrong policy is an empty screen, not an
-- error.
-- 
-- A hold is a fact about the SHELF, so it is a table about the shelf, and the
-- gate says who may look: an administrator reads them (that is the inventory
-- screen), and nothing below `asSystem()` writes one. There is no row policy
-- because there is no caller-facing read — the shopper learns about their own
-- hold from the basket the `carts` service builds for them.
CREATE TABLE IF NOT EXISTS "stock_reservation" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "variantId" INTEGER NOT NULL,
  "cartId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE ("cartId", "variantId"),
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("cartId") REFERENCES "cart" ("id") ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_stock_reservation_variantId_expiresAt" ON "stock_reservation" ("variantId", "expiresAt");

-- Why the shelf is at the number it is at. Append-only.
-- 
-- `stock` is the running total and this is the tape behind it: nothing writes
-- that column without writing a row here in the same breath, which is what
-- makes the two reconcilable at all. It is not the audit trail — `@@log(audit)`
-- records that SOMEBODY changed a row and Litestone owns its format. This
-- records what happened to the SHELF, in the shop's own words, and a customer
-- service agent reads it.
-- 
-- ─── The gate is "5.5.9.9" and each digit is deliberate ──────────────────
-- 
-- read   5  an administrator; a movement names orders and quantities
-- create 5  receiving stock is an administrator's act, so the Data boundary
-- is what refuses it — `inventory.receive` contains no check of
-- its own and needs none
-- update 9  LOCKED — nothing passes 9, `asSystem()` included
-- delete 9  LOCKED
-- 
-- 9 is what "append-only" is spelled with. A comment saying the same thing is
-- a comment; this is enforced at the Data boundary for every caller including
-- the application itself, which is the only version of the promise worth
-- having.
-- 
-- The one movement an ADMINISTRATOR does not write is `sold`: that one is
-- written by a shopper at level 0 checking out, so `carts.checkout` makes it
-- through `asSystem()` — the shop recording a sale on its own behalf. Which
-- client a `move()` is handed is therefore a real decision at every call site,
-- and it is why `api/inventory.ts` takes one rather than reaching for a global.
CREATE TABLE IF NOT EXISTS "inventory_movement" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "variantId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "stockBefore" INTEGER NOT NULL,
  "stockAfter" INTEGER NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("kind" IN ('received', 'sold', 'returned', 'adjusted', 'damaged')),
  FOREIGN KEY ("variantId") REFERENCES "product_variant" ("id") ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS "notification" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "contextType" TEXT,
  "contextId" INTEGER,
  "readAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

COMMIT;
PRAGMA foreign_keys = ON;