-- Remove the dormant email/SMS stack. Manual outreach remains stored in Activity rows.
DELETE FROM "Job" WHERE "type" = 'SEND_ONE';

DROP TABLE "MessageLog";
DROP TABLE "MessageBatch";
DROP TABLE "MessageTemplate";

ALTER TABLE "Contact"
  DROP COLUMN "emailMarketingState",
  DROP COLUMN "smsMarketingState";

ALTER TABLE "ShopSettings"
  DROP COLUMN "brevoApiKeyEncrypted",
  DROP COLUMN "brevoConnected",
  DROP COLUMN "brevoAccountEmail",
  DROP COLUMN "brevoSenderEmail",
  DROP COLUMN "brevoSenderName",
  DROP COLUMN "brevoSmsSender",
  DROP COLUMN "businessAddress",
  DROP COLUMN "unsubscribeUrl",
  DROP COLUMN "brevoInboundToken",
  DROP COLUMN "brevoInboundSecret";
