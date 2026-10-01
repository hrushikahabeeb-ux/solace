import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

export async function taskRoutes(app: FastifyInstance) {
  const createTaskSchema = z.object({
    titleCiphertext: z.string().min(1),
    descriptionCiphertext: z.string().optional(),
    sessionRef: z.string().min(1),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
    dueDate: z.string().datetime().optional(),
    labels: z.array(z.string().max(24)).max(10).default([]),
    assigneeId: z.string().uuid().optional(),
    sourceMessageId: z.string().uuid().optional(),
  });

  app.post('/workspaces/:id/tasks', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createTaskSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const task = await prisma.task.create({
      data: {
        workspaceId: workspace.id,
        titleCiphertext: body.data.titleCiphertext,
        descriptionCiphertext: body.data.descriptionCiphertext,
        sessionRef: body.data.sessionRef,
        priority: body.data.priority,
        dueDate: body.data.dueDate ? new Date(body.data.dueDate) : undefined,
        labels: body.data.labels,
        assigneeId: body.data.assigneeId,
        sourceMessageId: body.data.sourceMessageId,
        createdById: request.auth!.userId,
      },
      // A brand-new task has none yet, but the client's WireTaskWithDetails type
      // always expects these arrays to be present (every other task endpoint
      // includes them) — a bare Task here would leave `subtasks`/`attachments`
      // undefined and crash the first `.filter()`/`.map()` the UI does over them.
      include: { subtasks: true, attachments: true },
    });

    const activity = await getCollection(Collections.taskActivity);
    await activity.insertOne({
      taskId: task.id,
      workspaceId: workspace.id,
      type: 'activity',
      authorId: request.auth!.userId,
      createdAt: new Date(),
      activity: { kind: 'created' },
    });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'task.created', workspaceId: workspace.id, task });

    return reply.status(201).send({ task });
  });

  app.get('/workspaces/:id/tasks', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional() }).safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const tasks = await prisma.task.findMany({
      where: { workspaceId: workspace.id, ...(query.data.status ? { status: query.data.status } : {}) },
      include: { subtasks: true, attachments: true },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send({ tasks });
  });

  app.get('/tasks/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id }, include: { subtasks: true, attachments: true } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    return reply.send({ task });
  });

  const updateTaskSchema = z.object({
    titleCiphertext: z.string().optional(),
    descriptionCiphertext: z.string().nullable().optional(),
    sessionRef: z.string().optional(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    labels: z.array(z.string().max(24)).max(10).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
  });

  app.patch('/tasks/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = updateTaskSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const wasDone = task.status === 'DONE';
    const willBeDone = body.data.status === 'DONE';

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: {
        ...body.data,
        dueDate: body.data.dueDate === undefined ? undefined : body.data.dueDate ? new Date(body.data.dueDate) : null,
        completedAt: !wasDone && willBeDone ? new Date() : body.data.status && body.data.status !== 'DONE' ? null : undefined,
      },
      include: { subtasks: true, attachments: true },
    });

    const activity = await getCollection(Collections.taskActivity);
    const logEntries: Record<string, unknown>[] = [];
    if (body.data.status && body.data.status !== task.status) {
      logEntries.push({ kind: 'status_change', from: task.status, to: body.data.status });
    }
    if (body.data.assigneeId !== undefined && body.data.assigneeId !== task.assigneeId) {
      logEntries.push({ kind: 'assignee_change', from: task.assigneeId, to: body.data.assigneeId });
    }
    await Promise.all(
      logEntries.map((entry) =>
        activity.insertOne({
          taskId: task.id,
          workspaceId: workspace.id,
          type: 'activity',
          authorId: request.auth!.userId,
          createdAt: new Date(),
          activity: entry,
        }),
      ),
    );

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'task.updated', workspaceId: workspace.id, task: updated });

    return reply.send({ task: updated });
  });

  app.delete('/tasks/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await prisma.subtask.deleteMany({ where: { taskId: task.id } });
    await prisma.taskAttachment.deleteMany({ where: { taskId: task.id } });
    await prisma.task.delete({ where: { id: task.id } });

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, { type: 'task.deleted', workspaceId: workspace.id, taskId: task.id });
    return reply.status(204).send();
  });

  // --- Subtasks --------------------------------------------------------------
  const createSubtaskSchema = z.object({ titleCiphertext: z.string().min(1), sessionRef: z.string().min(1) });

  app.post('/tasks/:id/subtasks', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createSubtaskSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const subtask = await prisma.subtask.create({
      data: { taskId: task.id, titleCiphertext: body.data.titleCiphertext, sessionRef: body.data.sessionRef },
    });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'subtask.created',
      workspaceId: workspace.id,
      taskId: task.id,
      subtask,
    });
    return reply.status(201).send({ subtask });
  });

  app.patch('/subtasks/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ done: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const subtask = await prisma.subtask.findUnique({ where: { id: params.data.id } });
    if (!subtask) return reply.status(404).send({ error: 'subtask_not_found' });
    const task = await prisma.task.findUnique({ where: { id: subtask.taskId } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const updated = await prisma.subtask.update({ where: { id: subtask.id }, data: { done: body.data.done } });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'subtask.updated',
      workspaceId: workspace.id,
      taskId: task.id,
      subtask: updated,
    });
    return reply.send({ subtask: updated });
  });

  app.delete('/subtasks/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const subtask = await prisma.subtask.findUnique({ where: { id: params.data.id } });
    if (!subtask) return reply.status(404).send({ error: 'subtask_not_found' });
    const task = await prisma.task.findUnique({ where: { id: subtask.taskId } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    await prisma.subtask.delete({ where: { id: subtask.id } });
    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'subtask.deleted',
      workspaceId: workspace.id,
      taskId: task.id,
      subtaskId: subtask.id,
    });
    return reply.status(204).send();
  });

  // --- Attachments (link an existing MEDIA message to a task) ----------------
  app.post('/tasks/:id/attachments', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ messageId: z.string().uuid() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const attachment = await prisma.taskAttachment.create({ data: { taskId: task.id, messageId: body.data.messageId } });
    return reply.status(201).send({ attachment });
  });

  // --- Comments (MongoDB, ciphertext) -----------------------------------------
  app.get('/tasks/:id/activity', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const activity = await getCollection(Collections.taskActivity);
    const entries = await activity.find({ taskId: task.id }).sort({ createdAt: 1 }).toArray();
    return reply.send({ entries });
  });

  app.post('/tasks/:id/comments', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ ciphertext: z.string().min(1), sessionRef: z.string().min(1) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const task = await prisma.task.findUnique({ where: { id: params.data.id } });
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const { workspace, membership } = await workspaceMembership(task.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const activity = await getCollection(Collections.taskActivity);
    const doc = {
      taskId: task.id,
      workspaceId: workspace.id,
      type: 'comment' as const,
      authorId: request.auth!.userId,
      createdAt: new Date(),
      ciphertext: body.data.ciphertext,
      sessionRef: body.data.sessionRef,
    };
    const result = await activity.insertOne(doc);

    await broadcastToWorkspace(workspace.conversationId, request.auth!.userId, {
      type: 'task.comment',
      workspaceId: workspace.id,
      taskId: task.id,
      entry: { ...doc, _id: result.insertedId },
    });

    return reply.status(201).send({ entry: { ...doc, _id: result.insertedId } });
  });
}
