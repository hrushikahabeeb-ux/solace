import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

export async function moderationRoutes(app: FastifyInstance) {
  app.post('/users/:id/block', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });
    if (params.data.id === request.auth!.userId) return reply.status(400).send({ error: 'cannot_block_self' });

    await prisma.block.upsert({
      where: { blockerId_blockedUserId: { blockerId: request.auth!.userId, blockedUserId: params.data.id } },
      create: { blockerId: request.auth!.userId, blockedUserId: params.data.id },
      update: {},
    });
    return reply.status(201).send();
  });

  app.delete('/users/:id/block', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    await prisma.block
      .delete({ where: { blockerId_blockedUserId: { blockerId: request.auth!.userId, blockedUserId: params.data.id } } })
      .catch(() => undefined);
    return reply.status(204).send();
  });

  app.get('/me/blocked', { preHandler: app.requireAuth }, async (request, reply) => {
    const blocks = await prisma.block.findMany({
      where: { blockerId: request.auth!.userId },
      include: { blockedUser: true },
    });
    return reply.send({
      blocked: blocks.map((b) => ({ id: b.blockedUser.id, username: b.blockedUser.username, displayName: b.blockedUser.displayName })),
    });
  });

  const reportSchema = z.object({ reason: z.string().min(1).max(500) });

  // The server can't see message content, so a report carries only what the reporter
  // chooses to type here — never a re-decrypted copy of the flagged message.
  app.post('/messages/:id/report', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = reportSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const message = await prisma.message.findUnique({ where: { id: params.data.id } });
    if (!message) return reply.status(404).send({ error: 'message_not_found' });

    await prisma.report.create({
      data: { messageId: params.data.id, reporterId: request.auth!.userId, reason: body.data.reason },
    });
    return reply.status(201).send();
  });
}
