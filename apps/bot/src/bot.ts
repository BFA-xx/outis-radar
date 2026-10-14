/**
 * Telegram bot handlers. Built by a factory so tests can drive real grammY
 * updates against a fake Telegram API.
 *
 * Access: default-deny. Only Telegram user ids listed in
 * TELEGRAM_ALLOWED_USER_IDS can use it, and only in private chats. Anyone else
 * gets their own id back (so the owner can allowlist themselves) and nothing
 * else — no data leaves for an unknown user.
 */
import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { type Prisma, type PrismaClient } from '@outis/db';
import { analysisCard, esc, extractAddress, lookupToken, recapDraft, type Sender } from '@outis/engine';
import {
  ALERT_KINDS,
  type AlertKind,
  type AlertPrefs,
  CHAINS,
  DEFAULT_ALERT_PREFS,
  LAUNCHPADS,
  PREF_SETTERS,
  applyPrefSetting,
  getChain,
  getLaunchpad,
  isPlausibleAddress,
  normalizeAddress,
  readPrefs,
} from '@outis/shared';

export interface BotDeps {
  prisma: PrismaClient;
  allowedUserIds: Set<string>;
  /** Public dashboard URL for links in cards. */
  dashboardUrl?: string | null;
  /** For tests: skip getMe. */
  botInfo?: UserFromGetMe;
}

const KIND_LABEL: Record<AlertKind, string> = {
  alpha: '🔥 Alpha calls',
  sweep: '📡 Hourly radar sweep',
  followup: '🚀 Call follow-ups',
  recap: '🗓 Daily recap',
  discovery: 'Raw feed: every new token',
  launchpad: 'Raw feed: every graduation',
  risk: 'Risk escalations',
  wallet: 'Wallet trades',
  watch: 'Watchlist moves',
};

const HELP = [
  '<b>OUTIS RADAR</b> — early-token radar across 15 chains',
  '',
  '🔎 <b>Paste any contract address</b> (or a DEX Screener / pump.fun link) for a full analysis card.',
  '🔥 <b>Alpha calls</b> arrive only when several signals line up on a token with clean contract checks — expect a few a day, sometimes none.',
  '🚀 Calls get follow-ups under them at 2×, 5×, 10× — or a warning if they die. A daily recap scores every call.',
  '',
  '/recap — how today\'s calls are doing',
  '/prefs — your settings, with on/off switches',
  '/set &lt;key&gt; &lt;value&gt; — e.g. <code>/set minliq 50k</code>',
  `   keys: ${Object.keys(PREF_SETTERS).join(', ')}`,
  '/chains solana,base — limit alerts to chains (<code>/chains all</code> to reset)',
  '/launchpads pumpfun,fourmeme — which launchpads send graduation alerts (<code>/launchpads all</code>)',
  '/watch &lt;chain&gt; &lt;address&gt; — add a token to your watchlist',
  '/unwatch &lt;address&gt; — remove it',
  '/wallets — tracked wallets',
  '/status — scans and alert counts',
  '/pause · /resume — stop/start all alerts',
  '/test — send yourself a sample alert',
  '',
  '<i>Research only — nothing here is a recommendation.</i>',
].join('\n');

/** The command menu Telegram shows. */
export const BOT_COMMANDS = [
  { command: 'check', description: 'Check a token by contract address' },
  { command: 'recap', description: "How today's calls are doing" },
  { command: 'prefs', description: 'Your alert settings' },
  { command: 'set', description: 'Change a threshold' },
  { command: 'chains', description: 'Limit alerts to chains' },
  { command: 'launchpads', description: 'Graduation alerts per launchpad' },
  { command: 'watch', description: 'Watch a token' },
  { command: 'wallets', description: 'Tracked wallets' },
  { command: 'status', description: 'Scans and alert counts' },
  { command: 'pause', description: 'Pause alerts' },
  { command: 'resume', description: 'Resume alerts' },
  { command: 'help', description: 'Help' },
];

/** Telegram bot tokens look like "<digits>:<secret>". */
export const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export function allowedUserIdsFromEnv(): Set<string> {
  return new Set((process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function describePrefs(p: AlertPrefs, active: boolean): string {
  const d = p.discovery;
  return [
    `<b>Alerts ${active ? 'ON' : 'PAUSED'}</b>`,
    ...ALERT_KINDS.map((k) => `${p.kinds[k] ? '✅' : '⬜️'} ${KIND_LABEL[k]}`),
    '',
    `<b>Chains:</b> ${p.chains.length ? p.chains.map((c) => esc(getChain(c)?.displayName ?? c)).join(', ') : 'all scanned'}`,
    `<b>Alpha calls:</b> score ≥ ${p.alpha.minScore} (change: <code>/set minalpha 80</code>) · recap at ${String(p.recapHourUtc).padStart(2, '0')}:00 UTC`,
    p.mutedTokens.length ? `<b>Muted tokens:</b> ${p.mutedTokens.length}` : '',
    '<b>Raw new-token feed filter</b> (if switched on)',
    `  liquidity ≥ $${d.minLiquidityUsd.toLocaleString('en-US')} · 24h volume ≥ $${d.minVolumeH24.toLocaleString('en-US')}`,
    `  age ≤ ${d.maxAgeMinutes} min · momentum ≥ ${d.minMomentum} · risk ≤ ${d.maxRisk}`,
    `  at least ${Math.round(d.minRiskCoverage * 100)}% of risk checks must have run`,
    `<b>Graduations:</b> ${p.launchpad.ids.length ? p.launchpad.ids.map((id) => esc(getLaunchpad(id)?.name ?? id)).join(', ') : 'all known launchpads'} · liquidity ≥ $${p.launchpad.minLiquidityUsd.toLocaleString('en-US')} · known risk ≤ ${p.launchpad.maxRisk}`,
    `<b>Watchlist move:</b> ±${p.watch.priceMovePct}% in 1h`,
    `<b>Wallet trades:</b> ≥ ${p.wallet.minNative} native coin`,
    `<b>Cap:</b> ${p.maxPerHour} alerts/hour (follow-ups and the recap are never held back)`,
  ]
    .filter(Boolean)
    .join('\n');
}

function kindsKeyboard(p: AlertPrefs): InlineKeyboard {
  const kb = new InlineKeyboard();
  ALERT_KINDS.forEach((k, i) => {
    kb.text(`${p.kinds[k] ? '✅' : '⬜️'} ${KIND_LABEL[k]}`, `toggle:${k}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);
  const { prisma } = deps;

  const subscriberFor = (ctx: Context) => prisma.telegramSubscriber.findUnique({ where: { chatId: BigInt(ctx.chat!.id) } });
  const savePrefs = (chatId: number, prefs: AlertPrefs) =>
    prisma.telegramSubscriber.update({ where: { chatId: BigInt(chatId) }, data: { prefs: prefs as unknown as Prisma.InputJsonValue } });

  // ── Gate: allowlisted users, private chats ───────────────────────────────
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || !ctx.chat) return;
    if (!deps.allowedUserIds.has(String(uid))) {
      if (ctx.chat.type === 'private' && ctx.message?.text?.startsWith('/start')) {
        await ctx.reply(
          `This bot is private.\nYour Telegram user id is <code>${uid}</code>.\nIf this is your bot, add that id to <code>TELEGRAM_ALLOWED_USER_IDS</code> on the server, restart it, then send /start again.`,
          { parse_mode: 'HTML' },
        );
      }
      return; // nothing else is answered for unknown users
    }
    if (ctx.chat.type !== 'private') {
      if (ctx.message?.text?.startsWith('/')) await ctx.reply('Use me in a private chat — alerts are personal.');
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    await prisma.telegramSubscriber.upsert({
      where: { chatId: BigInt(ctx.chat.id) },
      create: { chatId: BigInt(ctx.chat.id), userId: BigInt(ctx.from!.id), username: ctx.from?.username ?? null, prefs: DEFAULT_ALERT_PREFS as unknown as Prisma.InputJsonValue },
      update: { active: true, username: ctx.from?.username ?? null },
    });
    await ctx.reply(`👋 <b>Welcome to OUTIS RADAR.</b> You're subscribed.\n\n${HELP}`, { parse_mode: 'HTML' });
  });

  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  // Everything below needs a subscription.
  const needSub = async (ctx: Context) => {
    const s = await subscriberFor(ctx);
    if (!s) await ctx.reply('Send /start first.');
    return s;
  };

  bot.command('prefs', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const p = readPrefs(s.prefs);
    await ctx.reply(describePrefs(p, s.active), { parse_mode: 'HTML', reply_markup: kindsKeyboard(p) });
  });

  bot.callbackQuery(/^toggle:(alpha|sweep|followup|recap|discovery|launchpad|risk|wallet|watch)$/, async (ctx) => {
    const s = await subscriberFor(ctx);
    if (!s) return ctx.answerCallbackQuery({ text: 'Send /start first.' });
    const kind = ctx.match[1] as AlertKind;
    const p = readPrefs(s.prefs);
    p.kinds[kind] = !p.kinds[kind];
    await savePrefs(ctx.chat!.id, p);
    await ctx.answerCallbackQuery({ text: `${KIND_LABEL[kind]}: ${p.kinds[kind] ? 'on' : 'off'}` });
    await ctx.editMessageText(describePrefs(p, s.active), { parse_mode: 'HTML', reply_markup: kindsKeyboard(p) }).catch(() => undefined);
  });

  bot.command('set', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const [key, value] = ctx.match.trim().split(/\s+/);
    if (!key || value === undefined) {
      return ctx.reply(`Usage: /set &lt;key&gt; &lt;value&gt;\n${Object.entries(PREF_SETTERS).map(([k, v]) => `<code>${k}</code> — ${esc(v.label)}`).join('\n')}`, { parse_mode: 'HTML' });
    }
    const r = applyPrefSetting(readPrefs(s.prefs), key, value);
    if (!r.ok) return ctx.reply(`❌ ${esc(r.error)}`, { parse_mode: 'HTML' });
    await savePrefs(ctx.chat.id, r.prefs);
    await ctx.reply(`✅ ${esc(PREF_SETTERS[key.toLowerCase()].label)} updated.\n\n${describePrefs(r.prefs, s.active)}`, { parse_mode: 'HTML' });
  });

  bot.command('chains', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    const p = readPrefs(s.prefs);
    if (!arg) {
      return ctx.reply(
        `Current: ${p.chains.length ? p.chains.join(', ') : 'all'}\nAvailable: ${CHAINS.map((c) => `<code>${c.id}</code>`).join(' ')}\nExample: <code>/chains solana,base,robinhood</code> or <code>/chains all</code>`,
        { parse_mode: 'HTML' },
      );
    }
    const ids = arg === 'all' ? [] : arg.split(/[\s,]+/).filter(Boolean);
    const unknown = ids.filter((id) => !getChain(id));
    if (unknown.length) return ctx.reply(`Unknown chain(s): ${unknown.join(', ')}`);
    p.chains = ids;
    await savePrefs(ctx.chat.id, p);
    await ctx.reply(`✅ Chains: ${ids.length ? ids.join(', ') : 'all scanned'}`);
  });

  bot.command('launchpads', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const arg = ctx.match.trim().toLowerCase();
    const p = readPrefs(s.prefs);
    if (!arg) {
      return ctx.reply(
        `Current: ${p.launchpad.ids.length ? p.launchpad.ids.join(', ') : 'all'}\nAvailable: ${LAUNCHPADS.map((l) => `<code>${l.id}</code> (${esc(l.name)})`).join(' ')}\nExample: <code>/launchpads pumpfun,fourmeme</code> or <code>/launchpads all</code>`,
        { parse_mode: 'HTML' },
      );
    }
    const ids = arg === 'all' ? [] : arg.split(/[\s,]+/).filter(Boolean);
    const unknown = ids.filter((id) => !getLaunchpad(id));
    if (unknown.length) return ctx.reply(`Unknown launchpad(s): ${unknown.join(', ')}`);
    p.launchpad.ids = ids;
    await savePrefs(ctx.chat.id, p);
    await ctx.reply(`✅ Graduation alerts from: ${ids.length ? ids.join(', ') : 'all known launchpads'}`);
  });

  bot.command(['pause', 'resume'], async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const active = ctx.message?.text?.startsWith('/resume') ?? false;
    await prisma.telegramSubscriber.update({ where: { id: s.id }, data: { active } });
    await ctx.reply(active ? '▶️ Alerts resumed.' : '⏸ Alerts paused. /resume to start again.');
  });

  bot.command('watch', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const [chainId, address] = ctx.match.trim().split(/\s+/);
    const chain = chainId ? getChain(chainId.toLowerCase()) : undefined;
    if (!chain || !address) return ctx.reply('Usage: /watch <chain> <address>  e.g. /watch solana So1…');
    if (!isPlausibleAddress(chain, address)) return ctx.reply(`That is not a ${chain.displayName} address.`);
    const list = await prisma.watchlist.upsert({ where: { name: 'Telegram' }, create: { name: 'Telegram' }, update: {} });
    const addr = normalizeAddress(chain, address);
    await prisma.watchlistItem.upsert({
      where: { watchlistId_kind_chainId_address: { watchlistId: list.id, kind: 'token', chainId: chain.id, address: addr } },
      create: { watchlistId: list.id, kind: 'token', chainId: chain.id, address: addr },
      update: {},
    });
    const t = await prisma.token.findUnique({ where: { chainId_address: { chainId: chain.id, address: addr } } });
    await ctx.reply(`👁 Watching ${esc(t?.symbol ?? addr)} on ${esc(chain.displayName)}${t ? '' : ' (not in discovery data yet — alerts start once it is)'}.`, { parse_mode: 'HTML' });
  });

  bot.command('unwatch', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const address = ctx.match.trim();
    if (!address) return ctx.reply('Usage: /unwatch <address>');
    const r = await prisma.watchlistItem.deleteMany({ where: { kind: 'token', OR: [{ address }, { address: address.toLowerCase() }] } });
    await ctx.reply(r.count ? `Removed from ${r.count} watchlist(s).` : 'Not on any watchlist.');
  });

  bot.command('wallets', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const ws = await prisma.trackedWallet.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    if (!ws.length) return ctx.reply('No tracked wallets. Add them on the dashboard’s Wallets page.');
    await ctx.reply(
      ws
        .map((w) => `• <b>${esc(w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`)}</b> · ${esc(getChain(w.chainId)?.displayName ?? w.chainId)} · ${esc(w.lastSyncStatus ?? 'queued')}`)
        .join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const day = new Date(Date.now() - 24 * 60 * 60_000);
    const [lastScan, tokens, sent, pending, suppressed] = await Promise.all([
      prisma.scanRun.findFirst({ where: { job: 'discovery-scan', status: { not: 'skipped' } }, orderBy: { startedAt: 'desc' } }),
      prisma.token.count(),
      prisma.alertEvent.count({ where: { subscriberId: s.id, status: 'sent', sentAt: { gte: day } } }),
      prisma.alertEvent.count({ where: { subscriberId: s.id, status: 'pending' } }),
      prisma.alertEvent.count({ where: { subscriberId: s.id, status: 'suppressed', createdAt: { gte: day } } }),
    ]);
    const mins = lastScan ? Math.round((Date.now() - (lastScan.finishedAt ?? lastScan.startedAt).getTime()) / 60_000) : null;
    await ctx.reply(
      [
        `<b>Status</b>`,
        `Last scan: ${lastScan ? `${esc(lastScan.status)}, ${mins} min ago` : 'never'}`,
        `Tokens tracked: ${tokens.toLocaleString('en-US')}`,
        `Your alerts (24h): ${sent} sent · ${pending} pending · ${suppressed} held back by the hourly cap`,
        `Alerts are ${s.active ? 'ON' : 'PAUSED'}.`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('test', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    await prisma.alertEvent.create({
      data: { subscriberId: s.id, kind: 'discovery', dedupKey: `test:${Date.now()}`, text: '🧪 <b>TEST ALERT</b>\nIf you can read this, scheduled delivery works. Real alerts look the same, with live data.', status: 'pending' },
    });
    await ctx.reply('Queued a test alert. It arrives with the next alert run (within a minute locally, up to 15 min when deployed).');
  });

  // ── Paste a contract address (or a DEX Screener / pump.fun link) → token card ──
  const recentLookups = new Map<number, number[]>();
  const lookupReply = async (ctx: Context, text: string) => {
    const uid = ctx.from!.id;
    const now = Date.now();
    const recent = (recentLookups.get(uid) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) return ctx.reply('Slow down a little — 10 lookups a minute.');
    recentLookups.set(uid, [...recent, now]);
    const note = await ctx.reply('🔎 Looking it up…');
    const r = await lookupToken(prisma, text, { contractChecks: true });
    const edit = (html: string) =>
      ctx.api.editMessageText(ctx.chat!.id, note.message_id, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }).catch(() => ctx.reply(html, { parse_mode: 'HTML' }));
    if (r.hits.length === 0) {
      return edit(
        r.errors.length
          ? 'Could not reach the data providers just now — try again in a minute.'
          : 'No trading pool found for that address on any chain we cover. It may not be trading yet, or it is a wallet rather than a token.',
      );
    }
    const card = await analysisCard(prisma, r.hits[0].tokenId, { dashboardUrl: deps.dashboardUrl, otherChains: r.hits.slice(1).map((h) => h.chainId) });
    if (!card) return edit('Found it, but could not build the card.');
    return ctx.api
      .editMessageText(ctx.chat!.id, note.message_id, card.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard(card.buttons) })
      .catch(() => ctx.reply(card.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard(card.buttons) }));
  };

  // ── Card buttons: watch, mute, refresh ──────────────────────────────────
  bot.callbackQuery(/^w:(.+)$/, async (ctx) => {
    const t = await prisma.token.findUnique({ where: { id: ctx.match[1] } });
    if (!t) return ctx.answerCallbackQuery({ text: 'Token no longer tracked.' });
    const list = await prisma.watchlist.upsert({ where: { name: 'Telegram' }, create: { name: 'Telegram' }, update: {} });
    await prisma.watchlistItem.upsert({
      where: { watchlistId_kind_chainId_address: { watchlistId: list.id, kind: 'token', chainId: t.chainId, address: t.address } },
      create: { watchlistId: list.id, kind: 'token', chainId: t.chainId, address: t.address },
      update: {},
    });
    await ctx.answerCallbackQuery({ text: `👀 Watching ${t.symbol ?? 'it'} — you'll hear about big moves.` });
  });

  bot.callbackQuery(/^m:(.+)$/, async (ctx) => {
    const s = await subscriberFor(ctx);
    if (!s) return ctx.answerCallbackQuery({ text: 'Send /start first.' });
    const p = readPrefs(s.prefs);
    if (!p.mutedTokens.includes(ctx.match[1])) p.mutedTokens = [...p.mutedTokens.slice(-499), ctx.match[1]];
    await savePrefs(ctx.chat!.id, p);
    await ctx.answerCallbackQuery({ text: '🔕 Muted — no more alerts or follow-ups for this token.' });
  });

  bot.callbackQuery(/^r:(.+)$/, async (ctx) => {
    const t = await prisma.token.findUnique({ where: { id: ctx.match[1] } });
    if (!t) return ctx.answerCallbackQuery({ text: 'Token no longer tracked.' });
    await ctx.answerCallbackQuery({ text: 'Refreshing…' });
    await lookupToken(prisma, t.address, { contractChecks: true });
    const card = await analysisCard(prisma, t.id, { dashboardUrl: deps.dashboardUrl });
    if (card) await ctx.editMessageText(card.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard(card.buttons) }).catch(() => undefined);
  });

  bot.command('recap', async (ctx) => {
    const s = await needSub(ctx);
    if (!s) return;
    const r = await recapDraft(prisma, s.id, new Date());
    await ctx.reply(r?.text ?? 'Nothing to report yet.', { parse_mode: 'HTML' });
  });

  bot.command('check', async (ctx) => {
    const arg = ctx.match.trim();
    if (!extractAddress(arg) && !/dexscreener\.com\//i.test(arg)) return ctx.reply('Usage: /check <contract address>  — or just paste the address.');
    await lookupReply(ctx, arg);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return ctx.reply('Unknown command. /help lists them.');
    if (extractAddress(text) || /dexscreener\.com\//i.test(text)) return lookupReply(ctx, text);
    return ctx.reply('Paste a token contract address (or a DEX Screener link) and I will look it up. /help lists the commands.');
  });

  bot.catch((err) => {
    // Never log the update payload (it can contain user text) or the token.
    console.error(`bot handler error: ${err.error instanceof Error ? err.error.message : String(err.error)}`.slice(0, 300));
  });

  return bot;
}

/** Telegram sender for the outbox. Maps Telegram errors to retry / give up. */
/** Inline keyboard from plain rows (URL buttons or callback data). */
export function keyboard(rows: Array<Array<{ text: string; url?: string; data?: string }>> | undefined): InlineKeyboard | undefined {
  if (!rows?.length) return undefined;
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) {
      if (b.url) kb.url(b.text, b.url);
      else if (b.data) kb.text(b.text, b.data);
    }
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export function telegramSender(bot: Bot): Sender {
  return async (chatId, html, opts) => {
    try {
      const m = await bot.api.sendMessage(Number(chatId), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard(opts?.buttons),
        // A deleted original must not block the follow-up.
        ...(opts?.replyToMessageId && { reply_parameters: { message_id: opts.replyToMessageId, allow_sending_without_reply: true } }),
      });
      return { ok: true, messageId: m.message_id };
    } catch (err) {
      if (err instanceof GrammyError) {
        if (err.error_code === 429) return { ok: false, retryAfterMs: (err.parameters.retry_after ?? 5) * 1000, error: 'rate limited by Telegram' };
        if (err.error_code === 403 || /chat not found|user is deactivated/i.test(err.description)) {
          return { ok: false, permanent: true, error: err.description };
        }
        return { ok: false, error: `Telegram ${err.error_code}: ${err.description}` };
      }
      return { ok: false, error: `network: ${(err as Error).message}`.slice(0, 200) };
    }
  };
}
