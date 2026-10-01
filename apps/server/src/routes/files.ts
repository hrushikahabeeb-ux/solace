import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

type Category = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';

function categoryFor(mimeType: string | null): Category {
  if (!mimeType) return 'other';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('application/msword') ||
    mimeType.startsWith('application/vnd.openxmlformats') ||
    mimeType.startsWith('application/vnd.ms-') ||
    mimeType === 'text/plain' ||
    mimeType === 'text/csv'
  ) {
    return 'document';
  }
  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-rar-compressed' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/x-tar' ||
    mimeType === 'application/gzip'
  ) {
    return 'archive';
  }
  return 'other';
}

async function workspaceMembership(workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { workspace: null, membership: null };
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId: workspace.conversationId, userId } },
  });
  return { workspace, membership };
}

/**
 * Files aren't a separate storage system — every "file" here is just a MEDIA message
 * that already exists in the conversation (Phase 4's pipeline). This dashboard is a
 * different LENS on the same data: grouped by category, searchable by the metadata
 * the server can actually see (sender, date, size, sender-declared mime type), never
 * by filename — the server never learns filenames, those live inside the encrypted
 * envelope and are decrypted client-side, same as message text.
 */
export async function fileRoutes(app: FastifyInstance) {
  const listQuerySchema = z.object({
    category: z.enum(['image', 'video', 'audio', 'document', 'archive', 'other']).optional(),
    senderId: z.string().uuid().optional(),
    folderId: z.string().uuid().optional(),
    unfiled: z.coerce.boolean().optional(),
  });

  app.get('/workspaces/:id/files', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const mediaObjects = await prisma.mediaObject.findMany({
      where: {
        message: { conversationId: workspace.conversationId, deletedAt: null },
        ...(query.data.senderId ? { message: { senderId: query.data.senderId } } : {}),
        ...(query.data.folderId ? { folderId: query.data.folderId } : {}),
        ...(query.data.unfiled ? { folderId: null } : {}),
      },
      include: { message: true },
      orderBy: { createdAt: 'desc' },
    });

    const filtered = query.data.category
      ? mediaObjects.filter((m) => categoryFor(m.mimeTypeGuess) === query.data.category)
      : mediaObjects;

    const files = filtered.map((m) => ({
      messageId: m.messageId,
      senderId: m.message.senderId,
      sizeBytes: m.sizeBytes,
      mimeTypeGuess: m.mimeTypeGuess,
      category: categoryFor(m.mimeTypeGuess),
      folderId: m.folderId,
      createdAt: m.createdAt,
      ciphertext: m.message.ciphertext,
      olmMessageType: m.message.olmMessageType,
      sessionRef: m.message.sessionRef,
    }));

    return reply.send({ files });
  });

  app.get('/workspaces/:id/storage', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const mediaObjects = await prisma.mediaObject.findMany({
      where: { message: { conversationId: workspace.conversationId, deletedAt: null } },
      select: { sizeBytes: true, mimeTypeGuess: true },
    });

    const byCategory: Record<Category, number> = { image: 0, video: 0, audio: 0, document: 0, archive: 0, other: 0 };
    let total = 0;
    for (const m of mediaObjects) {
      const cat = categoryFor(m.mimeTypeGuess);
      byCategory[cat] += m.sizeBytes;
      total += m.sizeBytes;
    }

    return reply.send({ totalBytes: total, byCategory, fileCount: mediaObjects.length });
  });

  app.patch('/media/:messageId/folder', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ messageId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ folderId: z.string().uuid().nullable() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const media = await prisma.mediaObject.findFirst({ where: { messageId: params.data.messageId }, include: { message: true } });
    if (!media) return reply.status(404).send({ error: 'media_not_found' });
    const membership = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: media.message.conversationId, userId: request.auth!.userId } },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const updated = await prisma.mediaObject.update({ where: { id: media.id }, data: { folderId: body.data.folderId } });
    return reply.send({ media: updated });
  });

  // --- Folders -----------------------------------------------------------------
  const createFolderSchema = z.object({
    nameCiphertext: z.string().min(1),
    sessionRef: z.string().min(1),
    parentId: z.string().uuid().optional(),
  });

  app.post('/workspaces/:id/folders', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = createFolderSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const folder = await prisma.folder.create({
      data: { workspaceId: workspace.id, nameCiphertext: body.data.nameCiphertext, sessionRef: body.data.sessionRef, parentId: body.data.parentId },
    });
    return reply.status(201).send({ folder });
  });

  app.get('/workspaces/:id/folders', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const { workspace, membership } = await workspaceMembership(params.data.id, request.auth!.userId);
    if (!workspace) return reply.status(404).send({ error: 'workspace_not_found' });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const folders = await prisma.folder.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: 'asc' } });
    return reply.send({ folders });
  });

  app.patch('/folders/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z
      .object({ nameCiphertext: z.string().optional(), sessionRef: z.string().optional(), parentId: z.string().uuid().nullable().optional() })
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });

    const folder = await prisma.folder.findUnique({ where: { id: params.data.id } });
    if (!folder) return reply.status(404).send({ error: 'folder_not_found' });
    const { workspace, membership } = await workspaceMembership(folder.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    const updated = await prisma.folder.update({ where: { id: folder.id }, data: body.data });
    return reply.send({ folder: updated });
  });

  app.delete('/folders/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const folder = await prisma.folder.findUnique({ where: { id: params.data.id } });
    if (!folder) return reply.status(404).send({ error: 'folder_not_found' });
    const { workspace, membership } = await workspaceMembership(folder.workspaceId, request.auth!.userId);
    if (!workspace || !membership) return reply.status(403).send({ error: 'not_a_member' });

    // Files inside stay put, just unfiled — deleting a folder must never delete content.
    await prisma.mediaObject.updateMany({ where: { folderId: folder.id }, data: { folderId: null } });
    await prisma.folder.updateMany({ where: { parentId: folder.id }, data: { parentId: null } });
    await prisma.folder.delete({ where: { id: folder.id } });

    return reply.status(204).send();
  });
}
