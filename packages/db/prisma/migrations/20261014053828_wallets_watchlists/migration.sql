-- CreateTable
CREATE TABLE "TrackedWallet" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trackedFrom" TIMESTAMP(3) NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "syncCursor" JSONB,
    "source" TEXT,

    CONSTRAINT "TrackedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransfer" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT,
    "blockTime" TIMESTAMP(3) NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "symbol" TEXT,
    "direction" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "amountRaw" TEXT NOT NULL,
    "decimals" INTEGER,
    "counterparty" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "note" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedWallet_lastSyncAt_idx" ON "TrackedWallet"("lastSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedWallet_chainId_address_key" ON "TrackedWallet"("chainId", "address");

-- CreateIndex
CREATE INDEX "WalletTransfer_walletId_blockTime_idx" ON "WalletTransfer"("walletId", "blockTime");

-- CreateIndex
CREATE INDEX "WalletTransfer_chainId_tokenAddress_blockTime_idx" ON "WalletTransfer"("chainId", "tokenAddress", "blockTime");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransfer_walletId_txHash_tokenAddress_logIndex_direct_key" ON "WalletTransfer"("walletId", "txHash", "tokenAddress", "logIndex", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_name_key" ON "Watchlist"("name");

-- CreateIndex
CREATE INDEX "WatchlistItem_kind_chainId_address_idx" ON "WatchlistItem"("kind", "chainId", "address");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_watchlistId_kind_chainId_address_key" ON "WatchlistItem"("watchlistId", "kind", "chainId", "address");

-- AddForeignKey
ALTER TABLE "WalletTransfer" ADD CONSTRAINT "WalletTransfer_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TrackedWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
