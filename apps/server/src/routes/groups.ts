import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

async function primaryDeviceId(userId: string): Promise<string | null> {
  const device = await prisma.device.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return device?.id ?? null;
}

async function requireRole(conversationId: string, userId: string, roles: Array<'OWNER' | 'ADMIN'>) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  return member && roles.includes(member.role as 'OWNER' | 'ADMIN') ? member : null;
}

export async function groupRoutes(app: FastifyInstance) {
  const createGroupSchema = z.object({
    title: z.string().min(1).max(100),
    memberUsernames: z.array(z.string().min(1)).min(1).max(50),
  });

  app.post('/conversations/group', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const members = await prisma.user.findMany({ where: { username: { in: parsed.data.memberUsernames } } });
    const foundUsernames = new Set(members.map((m) => m.username));
    const missing = parsed.data.memberUsernames.filter((u) => !foundUsernames.has(u));
    if (missing.length > 0) return reply.status(404).send({ error: 'users_not_found', missing });

    const conversation = await prisma.conversation.create({
      data: {
        type: 'GROUP',
        title: parsed.data.title,
        members: {
          create: [
            { userId: me, role: 'OWNER' },
            ...members.filter((m) => m.id !== me).map((m) => ({ userId: m.id, role: 'MEMBER' as const })),
          ],
        },
      },
      include: { members: { include: { user: true } } },
    });

    const membersOut = await Promise.all(
      conversation.members.map(async (m) => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.user.displayName,
        role: m.role,
        primaryDeviceId: await primaryDeviceId(m.user.id),
      })),
    );

    return reply.status(201).send({ id: conversation.id, type: conversation.type, title: conversation.title, members: membersOut });
  });

  app.get('/conversations/:id/members', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: request.auth!.userId } },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: params.data.id },
      include: { user: true },
    });
    const membersOut = await Promise.all(
      members.map(async (m) => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.user.displayName,
        role: m.role,
        primaryDeviceId: await primaryDeviceId(m.user.id),
      })),
    );
    return reply.send({ members: membersOut });
  });

  const addMemberSchema = z.object({ username: z.string().min(1) });

  app.post('/conversations/:id/members', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = addMemberSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const actor = await requireRole(params.data.id, request.auth!.userId, ['OWNER', 'ADMIN']);
    if (!actor) return reply.status(403).send({ error: 'not_authorized' });

    const user = await prisma.user.findUnique({ where: { username: body.data.username } });
    if (!user) return reply.status(404).send({ error: 'user_not_found' });

    const existing = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: user.id } },
    });
    if (existing) return reply.status(409).send({ error: 'already_a_member' });

    await prisma.conversationMember.create({ data: { conversationId: params.data.id, userId: user.id, role: 'MEMBER' } });

    return reply.status(201).send({
      member: { id: user.id, username: user.username, displayName: user.displayName, role: 'MEMBER', primaryDeviceId: await primaryDeviceId(user.id) },
    });
  });

  app.delete('/conversations/:id/members/:userId', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const me = request.auth!.userId;
    const isSelf = params.data.userId === me;
    if (!isSelf) {
      const actor = await requireRole(params.data.id, me, ['OWNER', 'ADMIN']);
      if (!actor) return reply.status(403).send({ error: 'not_authorized' });
    }

    const target = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: params.data.userId } },
    });
    if (!target) return reply.status(404).send({ error: 'not_a_member' });
    if (target.role === 'OWNER') return reply.status(400).send({ error: 'cannot_remove_owner' });

    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: params.data.id, userId: params.data.userId } },
    });

    return reply.status(204).send();
  });

  const roleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

  app.patch('/conversations/:id/members/:userId', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).safeParse(request.params);
    const body = roleSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const actor = await requireRole(params.data.id, request.auth!.userId, ['OWNER']);
    if (!actor) return reply.status(403).send({ error: 'not_authorized' });

    const target = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: params.data.id, userId: params.data.userId } },
    });
    if (!target || target.role === 'OWNER') return reply.status(400).send({ error: 'cannot_change_owner' });

    const updated = await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: params.data.id, userId: params.data.userId } },
      data: { role: body.data.role },
    });

    return reply.send({ role: updated.role });
  });
}
