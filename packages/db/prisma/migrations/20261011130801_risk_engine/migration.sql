-- DropForeignKey
ALTER TABLE "Pair" DROP CONSTRAINT "Pair_baseTokenId_fkey";

-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "contractCheckedAt" TIMESTAMP(3),
ADD COLUMN     "momentum" JSONB,
ADD COLUMN     "momentumAt" TIMESTAMP(3),
ADD COLUMN     "momentumScore" DOUBLE PRECISION,
ADD COLUMN     "riskAssessedAt" TIMESTAMP(3),
ADD COLUMN     "riskCoverage" DOUBLE PRECISION,
ADD COLUMN     "riskLevel" TEXT,
ADD COLUMN     "riskScore" INTEGER;

-- CreateTable
CREATE TABLE "TokenCheck" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "evidence" JSONB,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" BIGSERIAL NOT NULL,
    "tokenId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "categories" JSONB NOT NULL,
    "flaggedChecks" TEXT[],
    "momentumScore" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringConfig" (
    "key" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringConfig_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TokenCheck_checkId_status_idx" ON "TokenCheck"("checkId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TokenCheck_tokenId_checkId_key" ON "TokenCheck"("tokenId", "checkId");

-- CreateIndex
CREATE INDEX "RiskAssessment_tokenId_computedAt_idx" ON "RiskAssessment"("tokenId", "computedAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_computedAt_idx" ON "RiskAssessment"("computedAt");

-- CreateIndex
CREATE INDEX "Token_chainId_contractCheckedAt_idx" ON "Token"("chainId", "contractCheckedAt");

-- AddForeignKey
ALTER TABLE "TokenCheck" ADD CONSTRAINT "TokenCheck_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pair" ADD CONSTRAINT "Pair_baseTokenId_fkey" FOREIGN KEY ("baseTokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
