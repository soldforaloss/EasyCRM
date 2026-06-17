-- CreateTable
CREATE TABLE "ProcessedOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_idx" ON "ProcessedOrder"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedOrder_shop_orderGid_key" ON "ProcessedOrder"("shop", "orderGid");
