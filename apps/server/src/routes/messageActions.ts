import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { publishToUser } from '../realtime/hub.js';

async function otherMemberIds(conversationId: string, excludingUserId: string): Promise<string[]> {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { not: excludingUserId } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

async function broadcastToConversation(conversationId: string, excludingUserId: string, payload: unknown) {
  const ids = await otherMemberIds(conversationId, excludingUserId);
  await Promise.all(ids.map((userId) => publishToUser(userId, payload)));
}

export async function messageActionRoutes(app: FastifyInstance) {
  // --- Edit -----------------------------------------------------------------
  const editSchema = z.object({ ciphertext: z.string().min(1), olmMessageType: z.number().int().min(0).max(1) });

  app.patch('/messages/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = editSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message || message.deletedAt) return reply.status(404).send({ error: 'message_not_found' });
    if (message.senderId !== request.auth!.userId) return reply.status(403).send({ error: 'not_your_message' });

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { ciphertext: body.data.ciphertext, olmMessageType: body.data.olmMessageType, editedAt: new Date() },
    });

    await broadcastToConversation(message.conversationId, request.auth!.userId, {
      type: 'message.edited',
      conversationId: message.conversationId,
      message: updated,
    });

    return reply.send({ message: updated });
  });

  // --- Delete (soft — ciphertext is scrubbed, the row stays as a tombstone) ---
  app.delete('/messages/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message || message.deletedAt) return reply.status(404).send({ error: 'message_not_found' });
    if (message.senderId !== request.auth!.userId) return reply.status(403).send({ error: 'not_your_message' });

    await prisma.message.update({
      where: { id: message.id },
      data: { deletedAt: new Date(), ciphertext: '', sessionRef: '' },
    });

    await broadcastToConversation(message.conversationId, request.auth!.userId, {
      type: 'message.deleted',
      conversationId: message.conversationId,
      messageId: message.id,
    });

    return reply.status(204).send();
  });

  // --- Reactions (toggle: reacting again with the same emoji removes it) -----
  const reactionSchema = z.object({ emoji: z.string().min(1).max(8) });

  app.post('/messages/:id/reactions', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = reactionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message) return reply.status(404).send({ error: 'message_not_found' });

    const existing = await prisma.reaction.findUnique({
      where: { messageId_userId_emoji: { messageId: message.id, userId: me, emoji: body.data.emoji } },
    });

    let action: 'added' | 'removed';
    if (existing) {
      await prisma.reaction.delete({ where: { id: existing.id } });
      action = 'removed';
    } else {
      await prisma.reaction.create({ data: { messageId: message.id, userId: me, emoji: body.data.emoji } });
      action = 'added';
    }

    await broadcastToConversation(message.conversationId, me, {
      type: 'message.reaction',
      conversationId: message.conversationId,
      messageId: message.id,
      userId: me,
      emoji: body.data.emoji,
      action,
    });

    return reply.send({ action });
  });

  // --- Pin / unpin (conversation-wide) ---------------------------------------
  app.post('/messages/:id/pin', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message) return reply.status(404).send({ error: 'message_not_found' });

    const pin = await prisma.pinnedMessage.upsert({
      where: { conversationId_messageId: { conversationId: message.conversationId, messageId: message.id } },
      create: { conversationId: message.conversationId, messageId: message.id, pinnedById: me },
      update: {},
    });

    await broadcastToConversation(message.conversationId, me, {
      type: 'message.pinned',
      conversationId: message.conversationId,
      messageId: message.id,
    });

    return reply.status(201).send({ pin });
  });

  app.delete('/messages/:id/pin', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message) return reply.status(404).send({ error: 'message_not_found' });

    await prisma.pinnedMessage
      .delete({
        where: { conversationId_messageId: { conversationId: message.conversationId, messageId: message.id } },
      })
      .catch(() => undefined); // already unpinned — idempotent

    await broadcastToConversation(message.conversationId, request.auth!.userId, {
      type: 'message.unpinned',
      conversationId: message.conversationId,
      messageId: message.id,
    });

    return reply.status(204).send();
  });

  app.get('/conversations/:id/pins', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const pins = await prisma.pinnedMessage.findMany({
      where: { conversationId: params.data.id },
      include: { message: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ pins });
  });

  // --- Starring (personal — no broadcast, nobody else can see your stars) ----
  app.post('/messages/:id/star', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    await prisma.starredMessage.upsert({
      where: { userId_messageId: { userId: me, messageId: params.data.id } },
      create: { userId: me, messageId: params.data.id },
      update: {},
    });
    return reply.status(201).send();
  });

  app.delete('/messages/:id/star', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    await prisma.starredMessage
      .delete({ where: { userId_messageId: { userId: request.auth!.userId, messageId: params.data.id } } })
      .catch(() => undefined);
    return reply.status(204).send();
  });

  app.get('/me/starred', { preHandler: app.requireAuth }, async (request, reply) => {
    const starred = await prisma.starredMessage.findMany({
      where: { userId: request.auth!.userId },
      include: { message: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ starred });
  });
}
