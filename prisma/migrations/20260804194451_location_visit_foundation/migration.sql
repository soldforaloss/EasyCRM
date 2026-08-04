-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "lastVisitAt" TIMESTAMP(3),
ADD COLUMN     "lastVisitLocationId" TEXT;

-- AlterTable
ALTER TABLE "ProcessedOrder" ADD COLUMN     "currencyCode" TEXT,
ADD COLUMN     "lineItems" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "orderName" TEXT,
ADD COLUMN     "posDeviceId" TEXT,
ADD COLUMN     "posUserId" TEXT,
ADD COLUMN     "sourceName" TEXT,
ADD COLUMN     "total" TEXT;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "ianaTimezone" TEXT;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyLocationGid" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "city" TEXT,
    "provinceCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "visitDate" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'POS_ORDER',
    "orderGid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactLocation" (
    "contactId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),

    CONSTRAINT "ContactLocation_pkey" PRIMARY KEY ("contactId","locationId")
);

-- CreateTable
CREATE TABLE "ContactPreference" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffProfile" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "displayName" TEXT,
    "homeLocationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_shop_idx" ON "Location"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shop_legacyId_key" ON "Location"("shop", "legacyId");

-- CreateIndex
CREATE INDEX "Visit_shop_visitDate_idx" ON "Visit"("shop", "visitDate");

-- CreateIndex
CREATE INDEX "Visit_shop_locationId_visitDate_idx" ON "Visit"("shop", "locationId", "visitDate");

-- CreateIndex
CREATE INDEX "Visit_shop_contactId_idx" ON "Visit"("shop", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_shop_contactId_locationId_visitDate_key" ON "Visit"("shop", "contactId", "locationId", "visitDate");

-- CreateIndex
CREATE INDEX "ContactLocation_shop_locationId_idx" ON "ContactLocation"("shop", "locationId");

-- CreateIndex
CREATE INDEX "ContactPreference_shop_contactId_idx" ON "ContactPreference"("shop", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactPreference_contactId_key_source_key" ON "ContactPreference"("contactId", "key", "source");

-- CreateIndex
CREATE UNIQUE INDEX "StaffProfile_shop_staffId_key" ON "StaffProfile"("shop", "staffId");

-- CreateIndex
CREATE INDEX "Contact_shop_lastVisitAt_idx" ON "Contact"("shop", "lastVisitAt");

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_contactId_idx" ON "ProcessedOrder"("shop", "contactId");

-- CreateIndex
CREATE INDEX "ProcessedOrder_shop_occurredAt_idx" ON "ProcessedOrder"("shop", "occurredAt");

-- AddForeignKey
ALTER TABLE "ProcessedOrder" ADD CONSTRAINT "ProcessedOrder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLocation" ADD CONSTRAINT "ContactLocation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPreference" ADD CONSTRAINT "ContactPreference_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
