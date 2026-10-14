-- DropIndex
DROP INDEX "Token_chainId_contractCheckedAt_idx";

-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "contractNextCheckAt" TIMESTAMP(3),
ADD COLUMN     "riskDetail" JSONB;

-- CreateIndex
CREATE INDEX "Token_contractNextCheckAt_idx" ON "Token"("contractNextCheckAt");

-- CreateIndex
CREATE INDEX "Token_riskScore_idx" ON "Token"("riskScore");

-- CreateIndex
CREATE INDEX "Token_momentumScore_idx" ON "Token"("momentumScore");
