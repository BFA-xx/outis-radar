-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL,
    "priceUsd" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "momentumScore" DOUBLE PRECISION,
    "riskScore" INTEGER,
    "riskCoverage" DOUBLE PRECISION,
    "ageMinutes" DOUBLE PRECISION,
    "entryAt" TIMESTAMP(3),
    "entryPrice" DOUBLE PRECISION,
    "entryLiquidity" DOUBLE PRECISION,
    "outcomes" JSONB,
    "mfePct" DOUBLE PRECISION,
    "maePct" DOUBLE PRECISION,
    "collapsedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'tracking',
    "lastEvaluatedAt" TIMESTAMP(3),

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "pairId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "symbol" TEXT,
    "signalId" TEXT,
    "sizeUsd" DOUBLE PRECISION NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "takeProfitPct" DOUBLE PRECISION,
    "stopLossPct" DOUBLE PRECISION,
    "maxHoldMinutes" INTEGER,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "entryObservedAt" TIMESTAMP(3) NOT NULL,
    "entryLiquidity" DOUBLE PRECISION,
    "entryImpactPct" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedAt" TIMESTAMP(3),
    "exitPrice" DOUBLE PRECISION,
    "exitObservedAt" TIMESTAMP(3),
    "exitImpactPct" DOUBLE PRECISION,
    "exitReason" TEXT,
    "pnlUsd" DOUBLE PRECISION,
    "returnPct" DOUBLE PRECISION,
    "mfePct" DOUBLE PRECISION,
    "maePct" DOUBLE PRECISION,
    "note" TEXT,

    CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "equityUsd" DOUBLE PRECISION NOT NULL,
    "cashUsd" DOUBLE PRECISION NOT NULL,
    "openValueUsd" DOUBLE PRECISION NOT NULL,
    "realizedUsd" DOUBLE PRECISION NOT NULL,
    "openTrades" INTEGER NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Signal_firedAt_idx" ON "Signal"("firedAt");

-- CreateIndex
CREATE INDEX "Signal_status_idx" ON "Signal"("status");

-- CreateIndex
CREATE INDEX "Signal_pairId_idx" ON "Signal"("pairId");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_rule_tokenId_key" ON "Signal"("rule", "tokenId");

-- CreateIndex
CREATE INDEX "PaperTrade_status_idx" ON "PaperTrade"("status");

-- CreateIndex
CREATE INDEX "PaperTrade_openedAt_idx" ON "PaperTrade"("openedAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_at_idx" ON "PortfolioSnapshot"("at");
