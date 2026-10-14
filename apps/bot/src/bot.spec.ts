/** Bot handlers driven by real grammY updates; Telegram API calls are intercepted. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readPrefs } from '@outis/shared';
import { createBot, telegramSender } from './bot';

const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.DATABASE_URL_TEST;

const BOT_INFO = { id: 1, is_bot: true as const, first_name: 'Radar', username: 'radar_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false };
const OWNER = 4242;
const STRANGER = 9999;

let updateId = 1;
function msg(text: string, from = OWNER, chatType: 'private' | 'group' = 'private'): Update {
  const chat = chatType === 'private' ? { id: from, type: 'private' as const, first_name: 'u' } : { id: -100, type: 'group' as const, title: 'g' };
  const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0].length }] : undefined;
  return { update_id: updateId++, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat, from: { id: from, is_bot: false, first_name: 'u', username: 'owner' }, text, entities } };
}

describe.skipIf(!url)('bot handlers', () => {
  let prisma: PrismaClient;
  const replies: Array<{ method: string; text?: string; chat_id?: number }> = [];

  function makeBot() {
    const bot = createBot('123456:TEST_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { prisma: prisma as never, allowedUserIds: new Set([String(OWNER)]), botInfo: BOT_INFO });
    bot.api.config.use(async (_prev, method, payload) => {
      replies.push({ method, text: (payload as { text?: string }).text, chat_id: (payload as { chat_id?: number }).chat_id });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: OWNER, type: 'private' }, text: '' } } as never;
    });
    return bot;
  }
  const last = () => replies[replies.length - 1]?.text ?? '';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    replies.length = 0;
    await prisma.$executeRawUnsafe('TRUNCATE "AlertEvent", "TelegramSubscriber", "WatchlistItem", "Watchlist" CASCADE');
  });

  it('tells a stranger only their own id, and stores nothing', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/start', STRANGER));
    expect(last()).toContain(String(STRANGER));
    expect(last()).toMatch(/private/);
    await bot.handleUpdate(msg('/status', STRANGER));
    expect(replies).toHaveLength(1); // no answer to anything else
    expect(await prisma.telegramSubscriber.count()).toBe(0);
  });

  it('a pasted contract address gets a token card; other text gets guidance', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/start'));
    await prisma.$executeRawUnsafe('TRUNCATE "Pair", "Token" CASCADE');
    const t = await prisma.token.create({
      data: { chainId: 'solana', address: 'CardMint1111111111111111111111111pump', symbol: 'CARD', name: 'Card Token', firstSeenSource: 'test', launchpad: 'pumpfun', launchpadStage: 'curve', launchpadEvidence: 'dex', contractCheckedAt: new Date(), riskScore: 12, riskLevel: 'no_major_flags', riskCoverage: 0.7 },
    });
    // Fresh market data and a recent contract check: answered from the database, no network.
    await prisma.pair.create({ data: { chainId: 'solana', address: 'card-pair', baseTokenId: t.id, quoteTokenAddress: 'So11111111111111111111111111111111111111112', isPrimary: true, priceUsd: 0.0012, liquidityUsd: 30_000, marketUpdatedAt: new Date(), pairCreatedAt: new Date(Date.now() - 90 * 60_000) } });
    replies.length = 0;
    await bot.handleUpdate(msg('what about CardMint1111111111111111111111111pump ?'));
    expect(replies[0].text).toContain('Looking it up');
    const card = replies.find((r) => r.method === 'editMessageText')?.text ?? '';
    expect(card).toContain('CARD');
    expect(card).toContain('pump.fun');
    expect(card).toContain('Risk 12');
    expect(card).toContain('Research only');
    replies.length = 0;
    await bot.handleUpdate(msg('gm'));
    expect(last()).toMatch(/contract address/);
    await bot.handleUpdate(msg('/nonsense'));
    expect(last()).toMatch(/Unknown command/);
  });

  it('refuses group chats', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/start', OWNER, 'group'));
    expect(last()).toMatch(/private chat/);
    expect(await prisma.telegramSubscriber.count()).toBe(0);
  });

  it('/start subscribes with defaults; /set and /chains change prefs with validation', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/start'));
    expect(last()).toMatch(/subscribed/);
    await bot.handleUpdate(msg('/set minliq 75k'));
    expect(last()).toMatch(/updated/);
    await bot.handleUpdate(msg('/set maxrisk 500'));
    expect(last()).toMatch(/❌/);
    await bot.handleUpdate(msg('/chains solana, robinhood'));
    await bot.handleUpdate(msg('/chains narnia'));
    expect(last()).toMatch(/Unknown chain/);
    const s = await prisma.telegramSubscriber.findFirstOrThrow();
    const p = readPrefs(s.prefs);
    expect(p.discovery.minLiquidityUsd).toBe(75_000);
    expect(p.discovery.maxRisk).toBe(44);
    expect(p.chains).toEqual(['solana', 'robinhood']);
  });

  it('/pause and /resume flip delivery; /watch adds to the Telegram watchlist', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/start'));
    await bot.handleUpdate(msg('/pause'));
    expect((await prisma.telegramSubscriber.findFirstOrThrow()).active).toBe(false);
    await bot.handleUpdate(msg('/resume'));
    expect((await prisma.telegramSubscriber.findFirstOrThrow()).active).toBe(true);
    await bot.handleUpdate(msg('/watch base 0x4200000000000000000000000000000000000006'));
    expect(await prisma.watchlistItem.count()).toBe(1);
    await bot.handleUpdate(msg('/watch base not-an-address'));
    expect(last()).toMatch(/not a Base address/);
  });

  it('commands before /start ask for /start', async () => {
    const bot = makeBot();
    await bot.handleUpdate(msg('/prefs'));
    expect(last()).toMatch(/\/start/);
  });
});

describe('telegramSender error mapping', () => {
  const fakeBot = (err: unknown) => ({ api: { sendMessage: async () => Promise.reject(err) } }) as never;
  const ge = (code: number, description: string, retry_after?: number) =>
    new GrammyError('call failed', { ok: false, error_code: code, description, parameters: retry_after ? { retry_after } : {} }, 'sendMessage', {});

  it('429 → retry after the time Telegram asks for', async () => {
    expect(await telegramSender(fakeBot(ge(429, 'Too Many Requests', 7)))(1n, 'x')).toMatchObject({ ok: false, retryAfterMs: 7000 });
  });
  it('403 / chat not found → permanent', async () => {
    expect(await telegramSender(fakeBot(ge(403, 'Forbidden: bot was blocked by the user')))(1n, 'x')).toMatchObject({ permanent: true });
    expect(await telegramSender(fakeBot(ge(400, 'Bad Request: chat not found')))(1n, 'x')).toMatchObject({ permanent: true });
  });
  it('other errors → temporary', async () => {
    expect(await telegramSender(fakeBot(new Error('ECONNRESET')))(1n, 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/network/) });
  });
});
