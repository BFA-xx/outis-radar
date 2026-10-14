-- AlterTable
ALTER TABLE "AlertEvent" ADD COLUMN     "replyToId" TEXT,
ADD COLUMN     "telegramMessageId" BIGINT;

-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "links" JSONB;
