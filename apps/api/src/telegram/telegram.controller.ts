import { Body, Controller, Headers, HttpCode, Inject, Logger, NotFoundException, Post, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@outis/db';
import { TOKEN_SHAPE, allowedUserIdsFromEnv, createBot } from '@outis/bot';
import { PRISMA } from '../common/prisma.module';

type Bot = ReturnType<typeof createBot>;

/**
 * Telegram webhook, for deployments with no always-on process. Telegram
 * proves each call with the secret we registered (`--set-webhook`); anything
 * else is refused. Alerts are not sent from here — the scheduled job does that.
 */
@Controller('telegram')
export class TelegramController {
  private bot: Promise<Bot> | null = null;
  private readonly log = new Logger('telegram');

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private getBot(token: string): Promise<Bot> {
    // One bot per warm instance; init() fetches getMe once.
    this.bot ??= (async () => {
      const bot = createBot(token, { prisma: this.prisma, allowedUserIds: allowedUserIdsFromEnv(), dashboardUrl: process.env.DASHBOARD_URL?.trim() || null });
      await bot.init();
      return bot;
    })().catch((err) => {
      this.bot = null;
      throw err;
    });
    return this.bot;
  }

  @Post('webhook')
  @HttpCode(200)
  @SkipThrottle()
  async webhook(@Headers('x-telegram-bot-api-secret-token') given: string | undefined, @Body() update: unknown): Promise<{ ok: true }> {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    if (!TOKEN_SHAPE.test(token) || secret.length < 24) throw new NotFoundException();
    const a = Buffer.from(given ?? '');
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    try {
      await (await this.getBot(token)).handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
    } catch (err) {
      // Answer 200 anyway: a non-200 makes Telegram redeliver the same update forever.
      this.log.error(`update failed: ${(err as Error).message.slice(0, 200)}`);
    }
    return { ok: true };
  }
}
