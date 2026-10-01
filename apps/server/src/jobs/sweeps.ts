import { prisma } from '../lib/prisma.js';
import { publishToUser } from '../realtime/hub.js';

/**
 * Two small background sweeps, since neither scheduled sends nor disappearing
 * messages can be driven by a client that might not be online at the right moment:
 *
 * 1. Fire due scheduled messages: the ciphertext was already produced by the sender's
 *    client at schedule time (using their session state then) — the server only ever
 *    holds and times the delivery, it never touches plaintext. Firing sets createdAt
 *    to "now" so the message takes its place in the timeline at actual send time, and
 *    only then computes `expiresAt` from the conversation's disappearing-message
 *    setting (a message shouldn't start its countdown before anyone could read it).
 * 2. Expire disappearing messages: scrub ciphertext and tombstone the row, then tell
 *    every member so their client can drop it from view — mirrors the manual-delete
 *    path in messageActions.ts exactly, just triggered by a timer instead of a user.
 */

async function fireDueScheduledMessages(): Promise<void> {
  const due = await prisma.message.findMany({
      where: { scheduledFor: { not: null, lte: new Date() } },
    include: { media: true },
  });
  for (const message of due) {
    const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId } });
    const expiresAt = conversation?.disappearingSeconds
      ? new Date(Date.now() + conversation.disappearingSeconds * 1000)
      : null;

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { createdAt: new Date(), scheduledFor: null, expiresAt },
      include: { media: true },
    });

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: message.conversationId, userId: { not: message.senderId } },
      select: { userId: true },
    });
    await Promise.all(
      members.map((m) => publishToUser(m.userId, { type: 'message.new', conversationId: message.conversationId, message: updated })),
    );
  }
}

async function expireDisappearingMessages(): Promise<void> {
  const expired = await prisma.message.findMany({
      where: { expiresAt: { not: null, lte: new Date() }, deletedAt: null },
  });
  for (const message of expired) {
    await prisma.message.update({
      where: { id: message.id },
      data: { deletedAt: new Date(), ciphertext: '', sessionRef: '' },
    });
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: message.conversationId },
      select: { userId: true },
    });
    await Promise.all(
      members.map((m) => publishToUser(m.userId, { type: 'message.deleted', conversationId: message.conversationId, messageId: message.id })),
    );
  }
}

export function startBackgroundSweeps(): void {
  setInterval(() => void fireDueScheduledMessages().catch((err) => console.error('scheduled-send sweep failed', err)), 15_000);
  setInterval(() => void expireDisappearingMessages().catch((err) => console.error('disappearing-message sweep failed', err)), 30_000);
}
