import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { prisma } from '../lib/prisma.js';
import { getCollection, Collections } from '../lib/mongo.js';
import { publishToUser } from '../realtime/hub.js';

interface PollVote {
  userId: string;
  optionId: string;
  votedAt: Date;
}

interface PollDocument {
  workspaceId: string;
  questionCiphertext: string;
  sessionRef: string;
  options: { id: string; textCiphertext: string }[];
  votes: PollVote[];
  sourceMessageId?: string;
  createdById: string;
  createdAt: Date;
}

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

/**
 * Polls are single-choice only in this pass (voting again replaces your previous
 * vote, rather than supporting multi-select) — a deliberate scope trim, not an
 * oversight. Each option has a plain, opaque `id` (a random string, not a sequence
 * number that would leak how many options exist across polls) alongside its
 * end-to-end encrypted `textCiphertext`. This split is what lets the server compute vote
 * TALLIES — genuinely useful, not sensitive information about the poll's outcome
 * shape — without ever learning what any option actually says.
 */
export async function pollRoutes(app: FastifyInstance) {
  const createSchema = z.object({
    questionCiphertext: z.string().min(1),
    sessionRef: z.string().min(1),
    options: z.array(z.object({ textCiphertext: z.string().min(1) })).min(2).max(10),
    sourceMessageId: z.string().uuid().optional(),
  });

  app.post('/workspaces/:id/polls', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const polls = await getCollection<PollDocument>(Collections.polls);
    const doc = {
      workspaceId: workspace.id,
      questionCiphertext: body.data.questionCiphertext,
      sessionRef: body.data.sessionRef,
      options: body.data.options.map((o) => ({ id: randomUUID(), textCiphertext: o.textCiphertext })),
      votes: [] as { userId: string; optionId: string; votedAt: Date }[],
      sourceMessageId: body.data.sourceMessageId,
      createdById: request.auth!.userId,
      createdAt: new Date(),
    };
    const result = await polls.insertOne(doc);
    const poll = { ...doc, _id: result.insertedId };

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'poll.created', workspaceId: workspace.id, poll });
    return reply.status(201).send({ poll });
  });

  app.get('/workspaces/:id/polls', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const polls = await getCollection<PollDocument>(Collections.polls);
    const results = await polls.find({ workspaceId: workspace.id }).sort({ createdAt: -1 }).toArray();
    return reply.send({ polls: results });
  });

  app.post('/polls/:id/vote', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ optionId: z.string().min(1) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const polls = await getCollection<PollDocument>(Collections.polls);
    const poll = await polls.findOne({ _id: new ObjectId(params.data.id) });
    if (!poll) return reply.status(404).send({ error: 'poll_not_found' });
    const { workspace, membership } = await workspaceMembership(poll.workspaceId as string, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });
    if (!poll.options.some((o: { id: string }) => o.id === body.data.optionId)) {
      return reply.status(400).send({ error: 'invalid_option' });
    }

    // Single-choice: drop any previous vote by this user, then add the new one.
    await polls.updateOne({ _id: poll._id }, { $pull: { votes: { userId: request.auth!.userId } } });
    await polls.updateOne(
      { _id: poll._id },
      { $push: { votes: { userId: request.auth!.userId, optionId: body.data.optionId, votedAt: new Date() } } },
    );
    const updated = await polls.findOne({ _id: poll._id });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'poll.voted', workspaceId: workspace.id, poll: updated });
    return reply.send({ poll: updated });
  });

  app.delete('/polls/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const polls = await getCollection<PollDocument>(Collections.polls);
    const existing = await polls.findOne({ _id: new ObjectId(params.data.id) });
    if (!existing) return reply.status(404).send({ error: 'poll_not_found' });
    const { workspace, membership } = await workspaceMembership(existing.workspaceId as string, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await polls.deleteOne({ _id: existing._id });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'poll.deleted', workspaceId: workspace.id, pollId: params.data.id });
    return reply.status(204).send();
  });
}
