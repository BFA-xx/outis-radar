-- CreateTable
CREATE TABLE "Chain" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "evmChainId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "symbol" TEXT,
    "name" TEXT,
    "decimals" INTEGER,
    "imageUrl" TEXT,
    "metadataSource" TEXT,
    "metadataUpdatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenSource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pair" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "dexId" TEXT,
    "baseTokenId" TEXT NOT NULL,
    "quoteTokenAddress" TEXT NOT NULL,
    "quoteTokenSymbol" TEXT,
    "quoteTokenName" TEXT,
    "url" TEXT,
    "pairCreatedAt" TIMESTAMP(3),
    "pairCreatedAtSource" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "discoveryReasons" TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priceUsd" DOUBLE PRECISION,
    "priceNative" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "fdvUsd" DOUBLE PRECISION,
    "marketCapUsd" DOUBLE PRECISION,
    "volumeM5" DOUBLE PRECISION,
    "volumeH1" DOUBLE PRECISION,
    "volumeH6" DOUBLE PRECISION,
    "volumeH24" DOUBLE PRECISION,
    "priceChangeM5" DOUBLE PRECISION,
    "priceChangeH1" DOUBLE PRECISION,
    "priceChangeH6" DOUBLE PRECISION,
    "priceChangeH24" DOUBLE PRECISION,
    "txns" JSONB,
    "txnsH1" INTEGER,
    "txnsH24" INTEGER,
    "buyersH24" INTEGER,
    "sellersH24" INTEGER,
    "fieldSources" JSONB,
    "estimatedFields" TEXT[],
    "marketUpdatedAt" TIMESTAMP(3),
    "refreshAttemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "pairId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "priceUsd" DOUBLE PRECISION,
    "liquidityUsd" DOUBLE PRECISION,
    "fdvUsd" DOUBLE PRECISION,
    "marketCapUsd" DOUBLE PRECISION,
    "volumeM5" DOUBLE PRECISION,
    "volumeH1" DOUBLE PRECISION,
    "volumeH24" DOUBLE PRECISION,
    "txnsH1" INTEGER,
    "txnsH24" INTEGER,
    "buyersH1" INTEGER,
    "sellersH1" INTEGER,
    "priceChangeH1" DOUBLE PRECISION,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastLatencyMs" INTEGER,
    "requestsTotal" INTEGER NOT NULL DEFAULT 0,
    "errorsTotal" INTEGER NOT NULL DEFAULT 0,
    "rateLimitedTotal" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionCheckpoint" (
    "key" TEXT NOT NULL,
    "cursor" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionCheckpoint_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "chains" TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "stats" JSONB,
    "error" TEXT,

    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Token_symbol_idx" ON "Token"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Token_chainId_address_key" ON "Token"("chainId", "address");

-- CreateIndex
CREATE INDEX "Pair_isPrimary_pairCreatedAt_idx" ON "Pair"("isPrimary", "pairCreatedAt");

-- CreateIndex
CREATE INDEX "Pair_isPrimary_liquidityUsd_idx" ON "Pair"("isPrimary", "liquidityUsd");

-- CreateIndex
CREATE INDEX "Pair_isPrimary_volumeH24_idx" ON "Pair"("isPrimary", "volumeH24");

-- CreateIndex
CREATE INDEX "Pair_baseTokenId_idx" ON "Pair"("baseTokenId");

-- CreateIndex
CREATE INDEX "Pair_marketUpdatedAt_idx" ON "Pair"("marketUpdatedAt");

-- CreateIndex
CREATE INDEX "Pair_chainId_refreshAttemptedAt_idx" ON "Pair"("chainId", "refreshAttemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Pair_chainId_address_key" ON "Pair"("chainId", "address");

-- CreateIndex
CREATE INDEX "MarketSnapshot_pairId_observedAt_idx" ON "MarketSnapshot"("pairId", "observedAt");

-- CreateIndex
CREATE INDEX "MarketSnapshot_observedAt_idx" ON "MarketSnapshot"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketSnapshot_pairId_source_bucket_key" ON "MarketSnapshot"("pairId", "source", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderHealth_provider_scope_key" ON "ProviderHealth"("provider", "scope");

-- CreateIndex
CREATE INDEX "ScanRun_job_startedAt_idx" ON "ScanRun"("job", "startedAt");

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "Chain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pair" ADD CONSTRAINT "Pair_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "Chain"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pair" ADD CONSTRAINT "Pair_baseTokenId_fkey" FOREIGN KEY ("baseTokenId") REFERENCES "Token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketSnapshot" ADD CONSTRAINT "MarketSnapshot_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "Pair"("id") ON DELETE CASCADE ON UPDATE CASCADE;
