import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AlertsController } from './alerts/alerts.controller';
import { StatusController } from './chains/status.controller';
import { PrismaModule } from './common/prisma.module';
import { ReadGuard } from './common/read.guard';
import { DiscoveryController } from './discovery/discovery.controller';
import { LaunchpadsController } from './launchpads/launchpads.controller';
import { PaperController } from './paper/paper.controller';
import { ScoringController } from './scoring/scoring.controller';
import { SettingsController } from './settings/settings.controller';
import { TelegramController } from './telegram/telegram.controller';
import { WalletsController } from './wallets/wallets.controller';
import { WatchlistsController } from './wallets/watchlists.controller';

@Module({
  imports: [
    PrismaModule,
    // Per-IP: 120 requests/minute. The dashboard polls a handful of endpoints.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
  ],
  controllers: [AlertsController, DiscoveryController, LaunchpadsController, PaperController, StatusController, ScoringController, SettingsController, TelegramController, WalletsController, WatchlistsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ReadGuard },
  ],
})
export class AppModule {}
