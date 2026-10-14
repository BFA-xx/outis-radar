-- CreateTable
CREATE TABLE "TelegramSubscriber" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "userId" BIGINT,
    "username" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "prefs" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "text" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramSubscriber_chatId_key" ON "TelegramSubscriber"("chatId");

-- CreateIndex
CREATE INDEX "AlertEvent_status_createdAt_idx" ON "AlertEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AlertEvent_subscriberId_createdAt_idx" ON "AlertEvent"("subscriberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertEvent_subscriberId_dedupKey_key" ON "AlertEvent"("subscriberId", "dedupKey");

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "TelegramSubscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
