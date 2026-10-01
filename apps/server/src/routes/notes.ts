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

// Notes are plain shared documents, so unlike Tasks/Events they don't need the
// relational Prisma models (filtering by status, sorting a board, etc.) — a native
// MongoDB collection is the right fit, exactly as ARCHITECTURE.md scoped it. Every field carrying actual
// content is still E2EE ciphertext, same rule as everywhere else.
export async function noteRoutes(app: FastifyInstance) {
  const createSchema = z.object({
    titleCiphertext: z.string().min(1),
    bodyCiphertext: z.string().min(1),
    sessionRef: z.string().min(1),
  });

  app.post('/workspaces/:id/notes', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const notes = await getCollection(Collections.notes);
    const doc = {
      workspaceId: workspace.id,
      titleCiphertext: body.data.titleCiphertext,
      bodyCiphertext: body.data.bodyCiphertext,
      sessionRef: body.data.sessionRef,
      createdById: request.auth!.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await notes.insertOne(doc);
    const note = { ...doc, _id: result.insertedId };

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'note.created', workspaceId: workspace.id, note });
    return reply.status(201).send({ note });
  });

  app.get('/workspaces/:id/notes', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const notes = await getCollection(Collections.notes);
    const results = await notes.find({ workspaceId: workspace.id }).sort({ updatedAt: -1 }).toArray();
    return reply.send({ notes: results });
  });

  const updateSchema = z.object({
    titleCiphertext: z.string().min(1),
    bodyCiphertext: z.string().min(1),
    sessionRef: z.string().min(1),
  });

  app.patch('/notes/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const notes = await getCollection(Collections.notes);
    const existing = await notes.findOne({ _id: new ObjectId(params.data.id) });
    if (!existing) return reply.status(404).send({ error: 'note_not_found' });
    const { workspace, membership } = await workspaceMembership(existing.workspaceId as string, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await notes.updateOne(
      { _id: existing._id },
      { $set: { titleCiphertext: body.data.titleCiphertext, bodyCiphertext: body.data.bodyCiphertext, sessionRef: body.data.sessionRef, updatedAt: new Date() } },
    );
    const updated = await notes.findOne({ _id: existing._id });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'note.updated', workspaceId: workspace.id, note: updated });
    return reply.send({ note: updated });
  });

  app.delete('/notes/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const notes = await getCollection(Collections.notes);
    const existing = await notes.findOne({ _id: new ObjectId(params.data.id) });
    if (!existing) return reply.status(404).send({ error: 'note_not_found' });
    const { workspace, membership } = await workspaceMembership(existing.workspaceId as string, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await notes.deleteOne({ _id: existing._id });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'note.deleted', workspaceId: workspace.id, noteId: params.data.id });
    return reply.status(204).send();
  });
}
