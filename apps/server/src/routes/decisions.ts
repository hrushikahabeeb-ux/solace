import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { prisma } from '../lib/prisma.js';
import { getCollection, Collections } from '../lib/mongo.js';
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

// A decisions log is append-only by design — this is meant to be a durable record of
// "what did we decide and when", not a document people keep rewriting. No update
// endpoint on purpose; delete exists only to fix genuine mistakes.
export async function decisionRoutes(app: FastifyInstance) {
  const createSchema = z.object({
    titleCiphertext: z.string().min(1),
    descriptionCiphertext: z.string().optional(),
    sessionRef: z.string().min(1),
    sourceMessageId: z.string().uuid().optional(),
  });

  app.post('/workspaces/:id/decisions', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const decisions = await getCollection(Collections.decisions);
    const doc = {
      workspaceId: workspace.id,
      titleCiphertext: body.data.titleCiphertext,
      descriptionCiphertext: body.data.descriptionCiphertext,
      sessionRef: body.data.sessionRef,
      sourceMessageId: body.data.sourceMessageId,
      decidedById: request.auth!.userId,
      createdAt: new Date(),
    };
    const result = await decisions.insertOne(doc);
    const decision = { ...doc, _id: result.insertedId };

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'decision.created', workspaceId: workspace.id, decision });
    return reply.status(201).send({ decision });
  });

  app.get('/workspaces/:id/decisions', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const decisions = await getCollection(Collections.decisions);
    const results = await decisions.find({ workspaceId: workspace.id }).sort({ createdAt: -1 }).toArray();
    return reply.send({ decisions: results });
  });

  app.delete('/decisions/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const decisions = await getCollection(Collections.decisions);
    const existing = await decisions.findOne({ _id: new ObjectId(params.data.id) });
    if (!existing) return reply.status(404).send({ error: 'decision_not_found' });
    const { workspace, membership } = await workspaceMembership(existing.workspaceId as string, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await decisions.deleteOne({ _id: existing._id });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'decision.deleted', workspaceId: workspace.id, decisionId: params.data.id });
    return reply.status(204).send();
  });
}
