import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

async function requireMembership(conversationId: string, userId: string) {
  return prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
}

export async function workspaceRoutes(app: FastifyInstance) {
  const createSchema = z.object({
    name: z.string().min(1).max(80),
    emoji: z.string().max(8).optional(),
    description: z.string().max(280).optional(),
  });

  // "Turn this chat into a Workspace" — attaches to an EXISTING group conversation
  // rather than creating a new thing to manage. Direct (1:1) conversations can't
  // become workspaces; a workspace only makes sense where there's a group to organize.
  app.post('/conversations/:id/workspace', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const membership = await requireMembership(params.data.id, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
    if (!conversation) return reply.status(404).send({ error: 'conversation_not_found' });
    if (conversation.type === 'DIRECT') return reply.status(400).send({ error: 'direct_conversations_cannot_be_workspaces' });

    const existing = await prisma.workspace.findUnique({ where: { conversationId: params.data.id } });
    if (existing) return reply.status(409).send({ error: 'already_a_workspace' });

    const workspace = await prisma.workspace.create({
      data: {
        conversationId: params.data.id,
        name: body.data.name,
        emoji: body.data.emoji,
        description: body.data.description,
      },
    });

    return reply.status(201).send({ workspace });
  });

  app.get('/conversations/:id/workspace', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const membership = await requireMembership(params.data.id, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const workspace = await prisma.workspace.findUnique({ where: { conversationId: params.data.id } });
    return reply.send({ workspace });
  });

  // The dashboard: counts + a short "upcoming" and "recent tasks" preview. Task/event
  // TITLES here are still ciphertext — the client decrypts them locally through the
  // workspace's group session before rendering, exactly like message bodies.
  app.get('/workspaces/:id/dashboard', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const workspace = await prisma.workspace.findUnique({ where: { id: params.data.id } });
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    const membership = await requireMembership(workspace.conversationId, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const [taskCounts, upcomingEvents, recentTasks, fileCount, memberCount] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], where: { workspaceId: workspace.id }, _count: true }),
      prisma.event.findMany({
        where: { workspaceId: workspace.id, startAt: { gte: new Date() } },
        orderBy: { startAt: 'asc' },
        take: 3,
      }),
      prisma.task.findMany({
        where: { workspaceId: workspace.id, status: { not: 'DONE' } },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.mediaObject.count({
        where: { message: { conversationId: workspace.conversationId } },
      }),
      prisma.conversationMember.count({ where: { conversationId: workspace.conversationId } }),
    ]);

    const counts = { TODO: 0, IN_PROGRESS: 0, DONE: 0 } as Record<string, number>;
    taskCounts.forEach((row) => {
      counts[row.status] = row._count;
    });

    return reply.send({
      workspace,
      memberCount,
      taskCounts: counts,
      fileCount,
      upcomingEvents,
      recentTasks,
    });
  });

  app.patch('/workspaces/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSchema.partial().safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const workspace = await prisma.workspace.findUnique({ where: { id: params.data.id } });
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    const membership = await requireMembership(workspace.conversationId, request.auth!.userId);
    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return reply.status(403).send({ error: 'not_authorized' });
    }

    const updated = await prisma.workspace.update({ where: { id: params.data.id }, data: body.data });
    return reply.send({ workspace: updated });
  });
}
