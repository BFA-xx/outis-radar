-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "graduatedAt" TIMESTAMP(3),
ADD COLUMN     "launchpad" TEXT,
ADD COLUMN     "launchpadEvidence" TEXT,
ADD COLUMN     "launchpadStage" TEXT;

-- CreateIndex
CREATE INDEX "Token_launchpad_idx" ON "Token"("launchpad");

-- CreateIndex
CREATE INDEX "Token_graduatedAt_idx" ON "Token"("graduatedAt");
