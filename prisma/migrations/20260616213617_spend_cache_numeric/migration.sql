/*
  Warnings:

  - You are about to alter the column `amountSpent` on the `Contact` table. The data in that column could be lost. The data in that column will be cast from `String` to `Float`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "amountSpent" REAL NOT NULL DEFAULT 0,
    "currencyCode" TEXT,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "lastOrderAt" DATETIME,
    "lifecycleStage" TEXT NOT NULL DEFAULT 'LEAD',
    "ownerStaffId" TEXT,
    "source" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Contact" ("amountSpent", "createdAt", "currencyCode", "email", "firstName", "id", "lastName", "lastOrderAt", "lastSyncedAt", "lifecycleStage", "ordersCount", "ownerStaffId", "phone", "shop", "shopifyCustomerId", "source", "updatedAt") SELECT coalesce("amountSpent", 0) AS "amountSpent", "createdAt", "currencyCode", "email", "firstName", "id", "lastName", "lastOrderAt", "lastSyncedAt", "lifecycleStage", "ordersCount", "ownerStaffId", "phone", "shop", "shopifyCustomerId", "source", "updatedAt" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE INDEX "Contact_shop_idx" ON "Contact"("shop");
CREATE INDEX "Contact_shop_lifecycleStage_idx" ON "Contact"("shop", "lifecycleStage");
CREATE INDEX "Contact_shop_email_idx" ON "Contact"("shop", "email");
CREATE INDEX "Contact_shop_amountSpent_idx" ON "Contact"("shop", "amountSpent");
CREATE INDEX "Contact_shop_updatedAt_idx" ON "Contact"("shop", "updatedAt");
CREATE UNIQUE INDEX "Contact_shop_shopifyCustomerId_key" ON "Contact"("shop", "shopifyCustomerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
