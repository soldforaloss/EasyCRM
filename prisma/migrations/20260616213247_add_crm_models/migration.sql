-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "amountSpent" TEXT,
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

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ContactTag" (
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("contactId", "tagId"),
    CONSTRAINT "ContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorStaffId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contactId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assigneeStaffId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MessageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateId" TEXT,
    "subject" TEXT,
    "bodySnapshot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentByStaffId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageLog_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageLog_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "brevoApiKeyEncrypted" TEXT,
    "brevoConnected" BOOLEAN NOT NULL DEFAULT false,
    "brevoAccountEmail" TEXT,
    "brevoSenderEmail" TEXT,
    "brevoSenderName" TEXT,
    "brevoSmsSender" TEXT,
    "lifecycleStages" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Contact_shop_idx" ON "Contact"("shop");

-- CreateIndex
CREATE INDEX "Contact_shop_lifecycleStage_idx" ON "Contact"("shop", "lifecycleStage");

-- CreateIndex
CREATE INDEX "Contact_shop_email_idx" ON "Contact"("shop", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_shop_shopifyCustomerId_key" ON "Contact"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "Tag_shop_idx" ON "Tag"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_shop_name_key" ON "Tag"("shop", "name");

-- CreateIndex
CREATE INDEX "ContactTag_tagId_idx" ON "ContactTag"("tagId");

-- CreateIndex
CREATE INDEX "ContactTag_shop_idx" ON "ContactTag"("shop");

-- CreateIndex
CREATE INDEX "Note_shop_contactId_idx" ON "Note"("shop", "contactId");

-- CreateIndex
CREATE INDEX "Activity_shop_contactId_occurredAt_idx" ON "Activity"("shop", "contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "Activity_shop_occurredAt_idx" ON "Activity"("shop", "occurredAt");

-- CreateIndex
CREATE INDEX "Task_shop_status_dueAt_idx" ON "Task"("shop", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_shop_contactId_idx" ON "Task"("shop", "contactId");

-- CreateIndex
CREATE INDEX "Segment_shop_idx" ON "Segment"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Segment_shop_name_key" ON "Segment"("shop", "name");

-- CreateIndex
CREATE INDEX "MessageTemplate_shop_channel_idx" ON "MessageTemplate"("shop", "channel");

-- CreateIndex
CREATE INDEX "MessageLog_shop_contactId_idx" ON "MessageLog"("shop", "contactId");

-- CreateIndex
CREATE INDEX "MessageLog_shop_createdAt_idx" ON "MessageLog"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
