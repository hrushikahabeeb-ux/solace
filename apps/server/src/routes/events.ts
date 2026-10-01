import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { publishToUser } from '../realtime/hub.js';

async function workspaceMembership(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { workspace: null, membership: null };
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: workspace.conversationId, userId } },
  });
  return { workspace, membership };
}

async function broadcastToWorkspace(conversationId: string, excludingUserId: string | null, payload: unknown) {
  const members = await prisma.conversationMember.findMany({
    where: { conversationId, ...(excludingUserId ? { userId: { not: excludingUserId } } : {}) },
    select: { userId: true },
  });
  await Promise.all(members.map((m) => publishToUser(m.userId, payload)));
}

export async function eventRoutes(app: FastifyInstance) {
  const createEventSchema = z.object({
    titleCiphertext: z.string().min(1),
    descriptionCiphertext: z.string().optional(),
    locationCiphertext: z.string().optional(),
    onlineLinkCiphertext: z.string().optional(),
    sessionRef: z.string().min(1),
    startAt: z.string().datetime(),
    endAt: z.string().datetime().optional(),
    timezone: z.string().min(1).max(64),
    recurrenceRule: z.string().max(200).optional(),
    sourceMessageId: z.string().uuid().optional(),
  });

  app.post('/workspaces/:id/events', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createEventSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    // Every current workspace member is invited by default — matches the spec's
    // "Every workspace should have an optional shared calendar" framing: an event on
    // it is a workspace event, not something you have to hand-pick attendees for.
    const allMembers = await prisma.conversationMember.findMany({ where: { conversationId: workspace.conversationId } });

    const event = await prisma.event.create({
      data: {
        workspaceId: workspace.id,
        titleCiphertext: body.data.titleCiphertext,
        descriptionCiphertext: body.data.descriptionCiphertext,
        locationCiphertext: body.data.locationCiphertext,
        onlineLinkCiphertext: body.data.onlineLinkCiphertext,
        sessionRef: body.data.sessionRef,
        startAt: new Date(body.data.startAt),
        endAt: body.data.endAt ? new Date(body.data.endAt) : undefined,
        timezone: body.data.timezone,
        recurrenceRule: body.data.recurrenceRule,
        sourceMessageId: body.data.sourceMessageId,
        createdById: request.auth!.userId,
        participants: {
          create: allMembers.map((m) => ({
            userId: m.userId,
            rsvp: m.userId === request.auth!.userId ? 'GOING' : 'PENDING',
            respondedAt: m.userId === request.auth!.userId ? new Date() : undefined,
          })),
        },
      },
      include: { participants: true },
    });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'event.created',
      workspaceId: workspace.id,
      event,
    });

    return reply.status(201).send({ event });
  });

  app.get('/workspaces/:id/events', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const events = await prisma.event.findMany({
      where: {
        workspaceId: workspace.id,
        ...(query.data.from ? { startAt: { gte: new Date(query.data.from) } } : {}),
        ...(query.data.to ? { startAt: { lte: new Date(query.data.to) } } : {}),
      },
      include: { participants: true },
      orderBy: { startAt: 'asc' },
    });
    return reply.send({ events });
  });

  app.get('/events/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const event = await prisma.event.findUnique({ where: { id: params.data.id }, include: { participants: true } });
    if (!event) return reply.status(404).send({ error: 'event_not_found' });
    const { membership } = await workspaceMembership(event.workspaceId, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    return reply.send({ event });
  });

  const updateEventSchema = z.object({
    titleCiphertext: z.string().optional(),
    descriptionCiphertext: z.string().nullable().optional(),
    locationCiphertext: z.string().nullable().optional(),
    onlineLinkCiphertext: z.string().nullable().optional(),
    sessionRef: z.string().optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().nullable().optional(),
    timezone: z.string().optional(),
    recurrenceRule: z.string().nullable().optional(),
  });

  app.patch('/events/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = updateEventSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const event = await prisma.event.findUnique({ where: { id: params.data.id } });
    if (!event) return reply.status(404).send({ error: 'event_not_found' });
    const { workspace, membership } = await workspaceMembership(event.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        ...body.data,
        startAt: body.data.startAt ? new Date(body.data.startAt) : undefined,
        endAt: body.data.endAt === undefined ? undefined : body.data.endAt ? new Date(body.data.endAt) : null,
      },
      include: { participants: true },
    });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'event.updated', workspaceId: workspace.id, event: updated });
    return reply.send({ event: updated });
  });

  app.delete('/events/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const event = await prisma.event.findUnique({ where: { id: params.data.id } });
    if (!event) return reply.status(404).send({ error: 'event_not_found' });
    const { workspace, membership } = await workspaceMembership(event.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await prisma.eventParticipant.deleteMany({ where: { eventId: event.id } });
    await prisma.event.delete({ where: { id: event.id } });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'event.deleted', workspaceId: workspace.id, eventId: event.id });
    return reply.status(204).send();
  });

  app.post('/events/:id/rsvp', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ status: z.enum(['GOING', 'MAYBE', 'DECLINED']) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const event = await prisma.event.findUnique({ where: { id: params.data.id } });
    if (!event) return reply.status(404).send({ error: 'event_not_found' });
    const { workspace, membership } = await workspaceMembership(event.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const participant = await prisma.eventParticipant.upsert({
      where: { eventId_userId: { eventId: event.id, userId: request.auth!.userId } },
      create: { eventId: event.id, userId: request.auth!.userId, rsvp: body.data.status, respondedAt: new Date() },
      update: { rsvp: body.data.status, respondedAt: new Date() },
    });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'event.rsvp',
      workspaceId: workspace.id,
      eventId: event.id,
      participant,
    });

    return reply.send({ participant });
  });
}
