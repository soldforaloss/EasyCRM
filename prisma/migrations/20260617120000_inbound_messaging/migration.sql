-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "brevoInboundSecret" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "brevoInboundToken" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MessageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
    "templateId" TEXT,
    "subject" TEXT,
    "bodySnapshot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "providerEventId" TEXT,
    "error" TEXT,
    "sentByStaffId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageLog_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageLog_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MessageLog" ("bodySnapshot", "channel", "contactId", "createdAt", "error", "id", "providerMessageId", "sentByStaffId", "shop", "status", "subject", "templateId") SELECT "bodySnapshot", "channel", "contactId", "createdAt", "error", "id", "providerMessageId", "sentByStaffId", "shop", "status", "subject", "templateId" FROM "MessageLog";
DROP TABLE "MessageLog";
ALTER TABLE "new_MessageLog" RENAME TO "MessageLog";
CREATE INDEX "MessageLog_shop_contactId_idx" ON "MessageLog"("shop", "contactId");
CREATE INDEX "MessageLog_shop_createdAt_idx" ON "MessageLog"("shop", "createdAt");
CREATE UNIQUE INDEX "MessageLog_shop_providerEventId_key" ON "MessageLog"("shop", "providerEventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Contact_shop_phone_idx" ON "Contact"("shop", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_brevoInboundToken_key" ON "ShopSettings"("brevoInboundToken");

