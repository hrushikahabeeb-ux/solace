import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { publishToUser } from '../realtime/hub.js';

async function primaryDeviceId(userId: string): Promise<string | null> {
  const device = await prisma.device.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return device?.id ?? null;
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/users/lookup', { preHandler: app.requireAuth }, async (request, reply) => {
    const query = z.object({ username: z.string().min(1) }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_request' });

    const user = await prisma.user.findUnique({ where: { username: query.data.username } });
    if (!user) return reply.status(404).send({ error: 'user_not_found' });

    return reply.send({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      primaryDeviceId: await primaryDeviceId(user.id),
    });
  });

  const createDirectSchema = z.object({ peerUsername: z.string().min(1) });

  app.post('/conversations/direct', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = createDirectSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const peer = await prisma.user.findUnique({ where: { username: parsed.data.peerUsername } });
    if (!peer) return reply.status(404).send({ error: 'user_not_found' });
    if (peer.id === me) return reply.status(400).send({ error: 'cannot_message_self' });

    const blocked = await prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: me, blockedUserId: peer.id },
          { blockerId: peer.id, blockedUserId: me },
        ],
      },
    });
    if (blocked) return reply.status(403).send({ error: 'blocked' });

    // Reuse an existing DIRECT conversation between exactly these two users if one exists.
    const existing = await prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [{ members: { some: { userId: me } } }, { members: { some: { userId: peer.id } } }],
      },
      include: { members: true },
    });
    const conversation =
      existing ??
      (await prisma.conversation.create({
        data: {
          type: 'DIRECT',
          members: { create: [{ userId: me }, { userId: peer.id }] },
        },
        include: { members: true },
      }));

    return reply.status(existing ? 200 : 201).send({
      id: conversation.id,
      type: conversation.type,
      peer: {
        id: peer.id,
        username: peer.username,
        displayName: peer.displayName,
        role: 'MEMBER',
        primaryDeviceId: await primaryDeviceId(peer.id),
      },
    });
  });

  app.get('/conversations', { preHandler: app.requireAuth }, async (request, reply) => {
    const me = request.auth!.userId;
    const memberships = await prisma.conversationMember.findMany({
      where: { userId: me },
      include: {
        conversation: {
          include: {
            members: { include: { user: true } },
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    const conversations = await Promise.all(
      memberships.map(async (m) => {
        const otherMembers = m.conversation.members.filter((member) => member.userId !== me);
        return {
          id: m.conversation.id,
          type: m.conversation.type,
          title: m.conversation.title,
          myRole: m.role,
          disappearingSeconds: m.conversation.disappearingSeconds,
          members: await Promise.all(
            otherMembers.map(async (member) => ({
              id: member.user.id,
              username: member.user.username,
              displayName: member.user.displayName,
              role: member.role,
              primaryDeviceId: await primaryDeviceId(member.user.id),
            })),
          ),
          lastMessage: m.conversation.messages[0]
            ? {
                id: m.conversation.messages[0].id,
                senderId: m.conversation.messages[0].senderId,
                createdAt: m.conversation.messages[0].createdAt,
              }
            : null,
        };
      }),
    );

    return reply.send({ conversations });
  });

  app.get('/conversations/:id/messages', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const query = z
      .object({ before: z.string().datetime().optional(), limit: z.coerce.number().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'invalid_request' });

    const member = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: request.auth!.userId } },
    });
    if (!member) return reply.status(403).send({ error: 'not_a_member' });

    const messages = await prisma.message.findMany({
      where: {
        conversationId: params.data.id,
        deletedAt: null,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          { OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }] },
        ],
        ...(query.data.before ? { createdAt: { lt: new Date(query.data.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.data.limit,
    });

    return reply.send({ messages: messages.reverse() });
  });

  const sendMessageSchema = z.object({
    type: z.enum(['TEXT', 'MEDIA']),
    ciphertext: z.string().min(1),
    olmMessageType: z.number().int().min(0).max(1),
    sessionRef: z.string().min(1),
    replyToId: z.string().uuid().optional(),
    media: z
      .object({
        storageKey: z.string().min(1),
        sizeBytes: z.number().int().positive(),
        contentHash: z.string().min(1),
        mimeTypeGuess: z.string().optional(),
      })
      .optional(),
  });

  app.post('/conversations/:id/messages', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: me } },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const conversation = await prisma.conversation.findUnique({
      where: { id: params.data.id },
      include: { members: true },
    });
    if (conversation?.type === 'DIRECT') {
      const otherId = conversation.members.find((m) => m.userId !== me)?.userId;
      if (otherId) {
        const blocked = await prisma.block.findFirst({
          where: {
            OR: [
              { blockerId: me, blockedUserId: otherId },
              { blockerId: otherId, blockedUserId: me },
            ],
          },
        });
        if (blocked) return reply.status(403).send({ error: 'blocked' });
      }
    }

    const expiresAt = conversation?.disappearingSeconds
      ? new Date(Date.now() + conversation.disappearingSeconds * 1000)
      : undefined;

    const message = await prisma.message.create({
      data: {
        conversationId: params.data.id,
        senderId: me,
        type: body.data.type,
        ciphertext: body.data.ciphertext,
        olmMessageType: body.data.olmMessageType,
        sessionRef: body.data.sessionRef,
        replyToId: body.data.replyToId,
        expiresAt,
        ...(body.data.media
          ? {
              media: {
                create: {
                  storageKey: body.data.media.storageKey,
                  sizeBytes: body.data.media.sizeBytes,
                  contentHash: body.data.media.contentHash,
                  mimeTypeGuess: body.data.media.mimeTypeGuess,
                },
              },
            }
          : {}),
      },
      include: { media: true },
    });

    const otherMembers = await prisma.conversationMember.findMany({
      where: { conversationId: params.data.id, userId: { not: me } },
      select: { userId: true },
    });

    await Promise.all(
      otherMembers.map((m) =>
        publishToUser(m.userId, { type: 'message.new', conversationId: params.data.id, message }),
      ),
    );

    return reply.status(201).send({ message });
  });

  const scheduleSchema = sendMessageSchema.extend({ scheduledFor: z.string().datetime() });

  // Encryption already happened client-side at call time — the server only holds the
  // ciphertext and times its delivery. The envelope is wrapped for the devices that
  // were conversation members at schedule time; a member added afterwards will not be
  // able to read a message scheduled before they joined.
  app.post('/conversations/:id/messages/schedule', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = scheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: me } },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const message = await prisma.message.create({
      data: {
        conversationId: params.data.id,
        senderId: me,
        type: body.data.type,
        ciphertext: body.data.ciphertext,
        olmMessageType: body.data.olmMessageType,
        sessionRef: body.data.sessionRef,
        replyToId: body.data.replyToId,
        scheduledFor: new Date(body.data.scheduledFor),
      },
    });

    // Deliberately NOT broadcast here — jobs/sweeps.ts delivers it when due.
    return reply.status(201).send({ message });
  });

  const disappearingSchema = z.object({ seconds: z.number().int().positive().nullable() });

  app.patch('/conversations/:id/disappearing', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = disappearingSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: request.auth!.userId } },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    await prisma.conversation.update({
      where: { id: params.data.id },
      data: { disappearingSeconds: body.data.seconds },
    });

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: params.data.id },
      select: { userId: true },
    });
    await Promise.all(
      members.map((m) =>
        publishToUser(m.userId, { type: 'disappearing.changed', conversationId: params.data.id, seconds: body.data.seconds }),
      ),
    );

    return reply.status(204).send();
  });

  const receiptSchema = z.object({ status: z.enum(['DELIVERED', 'READ']) });

  app.post(
    '/conversations/:id/messages/:messageId/receipt',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const params = z.object({ id: z.string().uuid(), messageId: z.string().uuid() }).safeParse(request.params);
      const body = receiptSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

      const me = request.auth!.userId;
      const message = await prisma.message.findUnique({ where: { id: params.data.messageId } });
      if (!message || message.conversationId !== params.data.id) {
        return reply.status(404).send({ error: 'message_not_found' });
      }
      if (message.senderId === me) return reply.status(400).send({ error: 'cannot_receipt_own_message' });

      const now = new Date();
      const receipt = await prisma.messageReceipt.upsert({
        where: { messageId_userId: { messageId: message.id, userId: me } },
        create: {
          messageId: message.id,
          userId: me,
          deliveredAt: now,
          readAt: body.data.status === 'READ' ? now : null,
        },
        update: body.data.status === 'READ' ? { readAt: now } : { deliveredAt: now },
      });

      await publishToUser(message.senderId, {
        type: 'message.receipt',
        conversationId: params.data.id,
        messageId: message.id,
        userId: me,
        status: body.data.status,
        at: now,
      });

      return reply.send({ receipt });
    },
  );
}
