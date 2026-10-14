/**
 * Alert delivery from the outbox, transport-agnostic (the bot passes in a
 * Telegram sender). Respects Telegram's limits: about one message per second
 * per chat, and whatever retry-after Telegram asks for on a 429.
 */
import type { PrismaClient } from '@outis/db';

export type SendResult =
  | { ok: true }
  /** Temporary: try again later (rate limited, network). */
  | { ok: false; retryAfterMs?: number; permanent?: false; error: string }
  /** The chat is gone or blocked the bot: stop sending to it. */
  | { ok: false; permanent: true; error: string };

export type Sender = (chatId: bigint, html: string) => Promise<SendResult>;

export interface DeliverStats {
  sent: number;
  failed: number;
  deferred: number;
  deactivated: number;
}

const MAX_ATTEMPTS = 3;
const PER_CHAT_GAP_MS = 1_100;

export async function deliverPending(
  prisma: PrismaClient,
  send: Sender,
  opts: { limit?: number; deadline?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DeliverStats> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const stats: DeliverStats = { sent: 0, failed: 0, deferred: 0, deactivated: 0 };
  const pending = await prisma.alertEvent.findMany({
    where: { status: 'pending', subscriber: { active: true } },
    include: { subscriber: { select: { id: true, chatId: true } } },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 100,
  });
  const lastSentAt = new Map<string, number>();
  const blocked = new Set<string>();

  for (const ev of pending) {
    if (opts.deadline && Date.now() >= opts.deadline) break;
    if (blocked.has(ev.subscriberId)) continue;
    const wait = (lastSentAt.get(ev.subscriberId) ?? 0) + PER_CHAT_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const r = await send(ev.subscriber.chatId, ev.text);
    lastSentAt.set(ev.subscriberId, Date.now());
    if (r.ok) {
      await prisma.alertEvent.update({ where: { id: ev.id }, data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, error: null } });
      stats.sent++;
      continue;
    }
    if (r.permanent) {
      // Blocked or deleted chat: pause the subscriber instead of retrying forever.
      await prisma.telegramSubscriber.update({ where: { id: ev.subscriberId }, data: { active: false } });
      await prisma.alertEvent.update({ where: { id: ev.id }, data: { status: 'failed', attempts: { increment: 1 }, error: r.error.slice(0, 300) } });
      blocked.add(ev.subscriberId);
      stats.deactivated++;
      continue;
    }
    const attempts = ev.attempts + 1;
    await prisma.alertEvent.update({
      where: { id: ev.id },
      data: { attempts, error: r.error.slice(0, 300), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending' },
    });
    if (attempts >= MAX_ATTEMPTS) stats.failed++;
    else stats.deferred++;
    if (r.retryAfterMs) {
      // Telegram asked us to slow down: stop this round; the rest goes next tick.
      break;
    }
  }
  return stats;
}
