import { Body, Controller, Get, Inject, Post, Put, UseGuards } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@outis/db';
import { SCORING_CONFIG_KEY, assessTokens, loadScoringConfig } from '@outis/engine';
import { CHECKS, DEFAULT_SCORING_CONFIG, MOMENTUM_FACTORS, scoringConfigSchema } from '@outis/shared';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from './admin.guard';

const RESCORE_LIMIT = 3000;

@Controller()
export class ScoringController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** The check catalog: what is checked, per chain family, from which source. */
  @Get('risk/checks')
  checks() {
    return CHECKS;
  }

  @Get('scoring/config')
  async config() {
    const row = await this.prisma.scoringConfig.findUnique({ where: { key: SCORING_CONFIG_KEY } });
    return {
      effective: await loadScoringConfig(this.prisma),
      defaults: DEFAULT_SCORING_CONFIG,
      stored: row ? { updatedAt: row.updatedAt.toISOString(), valid: scoringConfigSchema.safeParse(row.config).success } : null,
      momentumFactors: MOMENTUM_FACTORS,
    };
  }

  /** Replace the scoring config. Takes effect at the next assessment (or POST /scoring/rescore). */
  @Put('scoring/config')
  @UseGuards(AdminGuard)
  async setConfig(@Body(new ZodPipe(scoringConfigSchema)) body: z.infer<typeof scoringConfigSchema>) {
    const row = await this.prisma.scoringConfig.upsert({
      where: { key: SCORING_CONFIG_KEY },
      create: { key: SCORING_CONFIG_KEY, config: body as Prisma.InputJsonValue },
      update: { config: body as Prisma.InputJsonValue },
    });
    return { ok: true, updatedAt: row.updatedAt.toISOString() };
  }

  @Post('scoring/reset')
  @UseGuards(AdminGuard)
  async reset() {
    await this.prisma.scoringConfig.deleteMany({ where: { key: SCORING_CONFIG_KEY } });
    return { ok: true, config: DEFAULT_SCORING_CONFIG };
  }

  /** Re-score recently active tokens now (DB-only; no provider calls). */
  @Post('scoring/rescore')
  @UseGuards(AdminGuard)
  async rescore() {
    const since = new Date(Date.now() - 72 * 60 * 60_000);
    const tokens = await this.prisma.token.findMany({
      where: { pairs: { some: { isPrimary: true, marketUpdatedAt: { gte: since } } } },
      select: { id: true },
      orderBy: { firstSeenAt: 'desc' },
      take: RESCORE_LIMIT,
    });
    const stats = await assessTokens(this.prisma, tokens.map((t) => t.id));
    return { ok: true, ...stats, limit: RESCORE_LIMIT };
  }
}
