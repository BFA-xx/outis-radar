import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@outis/db';
import { HORIZONS, PaperTradeError, SIGNAL_RULES, closePaperTrade, loadPaperConfig, openPaperTrade, paperReport, performanceReport } from '@outis/engine';
import { z } from 'zod';
import { PRISMA } from '../common/prisma.module';
import { ZodPipe } from '../common/zod.pipe';
import { AdminGuard } from '../scoring/admin.guard';

const optPct = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number().positive().max(100_000).optional());
const openBody = z.object({
  tokenId: z.string().min(1).max(40),
  sizeUsd: z.coerce.number().positive().max(1_000_000),
  takeProfitPct: optPct,
  stopLossPct: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().positive().max(100).optional()),
  maxHoldMinutes: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().max(60 * 24 * 30).optional()),
  note: z.string().trim().max(300).optional(),
});
const perfQuery = z.object({ horizon: z.enum(HORIZONS.map((h) => h.key) as [string, ...string[]]).default('4h') });
const idParam = z.object({ id: z.string().min(1).max(40) });

/** BigInt-safe JSON. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

@Controller()
export class PaperController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Get('performance')
  async performance(@Query(new ZodPipe(perfQuery)) q: z.infer<typeof perfQuery>) {
    return plain({ ...(await performanceReport(this.prisma, { horizon: q.horizon as never })), horizons: HORIZONS, rulesCatalog: SIGNAL_RULES.map((r) => ({ id: r.id, label: r.label, description: r.description })) });
  }

  @Get('paper')
  async paper() {
    return plain(await paperReport(this.prisma, loadPaperConfig()));
  }

  @Post('paper/trades')
  @UseGuards(AdminGuard)
  async open(@Body(new ZodPipe(openBody)) b: z.infer<typeof openBody>) {
    try {
      return await openPaperTrade(this.prisma, b, loadPaperConfig());
    } catch (err) {
      if (err instanceof PaperTradeError) throw new BadRequestException({ code: 'paper_trade', message: err.message });
      throw err;
    }
  }

  @Post('paper/trades/:id/close')
  @UseGuards(AdminGuard)
  async close(@Param(new ZodPipe(idParam)) p: z.infer<typeof idParam>) {
    try {
      return await closePaperTrade(this.prisma, p.id);
    } catch (err) {
      if (err instanceof PaperTradeError) throw new NotFoundException({ code: 'paper_trade', message: err.message });
      throw err;
    }
  }
}
