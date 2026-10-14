-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "alphaAt" TIMESTAMP(3),
ADD COLUMN     "alphaDetail" JSONB,
ADD COLUMN     "alphaScore" INTEGER,
ADD COLUMN     "alphaTier" TEXT;

-- CreateIndex
CREATE INDEX "Token_alphaTier_alphaAt_idx" ON "Token"("alphaTier", "alphaAt");
