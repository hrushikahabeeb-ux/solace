import { prisma } from '../lib/prisma.js';
import { getMongoClient } from '../lib/mongo.js';
import { publishToUser } from './hub.js';
import { createCallService, createMongoCallStore, type CallService } from './calls.js';

/** The single call service for this process, wired to the real backing stores. Kept apart
 *  from calls.ts so that module can be exercised in tests without the Prisma-backed lookups. */
export const callService: CallService = createCallService({
  store: createMongoCallStore(getMongoClient),
  publish: publishToUser,

  async getConversation(conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true, members: { select: { userId: true } } },
    });
    if (!conversation) return null;
    return {
      type: conversation.type,
      memberIds: conversation.members.map((member: { userId: string }) => member.userId),
    };
  },

  async isBlocked(userIdA, userIdB) {
    const block = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: userIdA, blockedUserId: userIdB },
          { blockerId: userIdB, blockedUserId: userIdA },
        ],
      },
      select: { blockerId: true },
    });
    return Boolean(block);
  },

  async getUser(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });
  },
});
