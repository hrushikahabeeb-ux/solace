import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  createMediaToken,
  deleteOtherRevisions,
  findMediaFile,
  getMediaBucket,
  verifyMediaToken,
} from '../lib/mediaStore.js';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB ceiling for this project's scope
const UPLOAD_URL_TTL_SECONDS = 10 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** Base URL clients use to reach this API. PUBLIC_API_URL wins when set (useful behind
 *  unusual proxies); otherwise it is derived from the request, honoring the
 *  X-Forwarded-Proto/-Host headers a reverse proxy sets (trustProxy is enabled). */
function publicApiBase(request: FastifyRequest): string {
  const configured = process.env.PUBLIC_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${request.protocol}://${request.hostname}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

class SizeLimitExceeded extends Error {
  constructor() {
    super('upload exceeds the size this URL was issued for');
  }
}

/** Counts bytes flowing through and fails once more than `limit` have been seen. */
function byteCounter(limit: number): Transform & { bytes: number } {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > limit) {
        callback(new SizeLimitExceeded());
        return;
      }
      callback(null, chunk);
    },
  }) as Transform & { bytes: number };
  counter.bytes = 0;
  return counter;
}

export async function mediaRoutes(app: FastifyInstance) {
  // Raw ciphertext uploads: hand the request stream straight to the route instead of
  // buffering it, so a 500 MiB upload never sits in memory. Scoped to this plugin only.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  const uploadUrlSchema = z.object({
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  });

  // Issues a signed, expiring PUT URL. The client uploads ciphertext to it exactly as
  // it did to a pre-signed S3 URL. storageKey is just an opaque path; it carries no
  // information about the file's content.
  app.post('/media/upload-url', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = uploadUrlSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });

    const storageKey = `uploads/${request.auth!.userId}/${randomUUID()}`;
    const token = createMediaToken({
      k: storageKey,
      a: 'put',
      s: parsed.data.sizeBytes,
      e: nowSeconds() + UPLOAD_URL_TTL_SECONDS,
    });
    const uploadUrl = `${publicApiBase(request)}/media/object?t=${encodeURIComponent(token)}`;

    return reply.send({ storageKey, uploadUrl, expiresInSeconds: UPLOAD_URL_TTL_SECONDS });
  });

  // Issues a signed GET URL for a specific message's attachment, after checking the
  // requester is actually a member of the conversation that message belongs to.
  app.get('/media/:messageId/download-url', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = z.object({ messageId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_request' });

    const media = await prisma.mediaObject.findFirst({
      where: { messageId: params.data.messageId },
      include: { message: true },
    });
    if (!media) return reply.status(404).send({ error: 'media_not_found' });

    const membership = await prisma.conversationMember.findUnique({
      where: {
        conversationId_userId: { conversationId: media.message.conversationId, userId: request.auth!.userId },
      },
    });
    if (!membership) return reply.status(403).send({ error: 'not_a_member' });

    const token = createMediaToken({ k: media.storageKey, a: 'get', e: nowSeconds() + DOWNLOAD_URL_TTL_SECONDS });
    const downloadUrl = `${publicApiBase(request)}/media/object?t=${encodeURIComponent(token)}`;

    return reply.send({ downloadUrl, sizeBytes: media.sizeBytes, contentHash: media.contentHash });
  });

  const objectQuerySchema = z.object({ t: z.string().min(1).max(4096) });

  // Receives the ciphertext for a signed upload URL and stores it in GridFS. Like an S3
  // pre-signed PUT, the URL itself is the credential, and it only accepts exactly the
  // byte length it was issued for. Excluded from the per-IP API rate limit because the
  // S3 endpoint it replaces never counted against it either.
  app.put(
    '/media/object',
    { config: { rateLimit: false } },
    async (request, reply) => {
      const query = objectQuerySchema.safeParse(request.query);
      const claims = query.success ? verifyMediaToken(query.data.t, 'put') : null;
      if (!claims || claims.s === undefined) return reply.status(403).send({ error: 'invalid_or_expired_url' });

      const declaredLength = Number(request.headers['content-length']);
      if (!Number.isInteger(declaredLength) || declaredLength !== claims.s) {
        return reply.status(400).send({ error: 'size_mismatch' });
      }
      const body = request.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        return reply.status(415).send({ error: 'expected_octet_stream' });
      }

      const bucket = await getMediaBucket();
      const upload = bucket.openUploadStream(claims.k, { metadata: { sizeBytes: claims.s } });
      const counter = byteCounter(claims.s);
      try {
        await pipeline(body, counter, upload);
      } catch (err) {
        await upload.abort().catch(() => undefined);
        if (err instanceof SizeLimitExceeded) return reply.status(400).send({ error: 'size_mismatch' });
        request.log.error(err, 'media upload failed');
        return reply.status(500).send({ error: 'upload_failed' });
      }

      if (counter.bytes !== claims.s) {
        await bucket.delete(upload.id).catch(() => undefined);
        return reply.status(400).send({ error: 'size_mismatch' });
      }

      await deleteOtherRevisions(claims.k, upload.id);
      return reply.status(200).send();
    },
  );

  // Streams stored ciphertext for a signed download URL. Compression is disabled so
  // Content-Length (which the client uses for download progress) is always present.
  app.get(
    '/media/object',
    { config: { rateLimit: false }, compress: false },
    async (request, reply) => {
      const query = objectQuerySchema.safeParse(request.query);
      const claims = query.success ? verifyMediaToken(query.data.t, 'get') : null;
      if (!claims) return reply.status(403).send({ error: 'invalid_or_expired_url' });

      const file = await findMediaFile(claims.k);
      if (!file) return reply.status(404).send({ error: 'media_not_found' });

      const bucket = await getMediaBucket();
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(file.length))
        .header('cache-control', 'private, max-age=300')
        .send(bucket.openDownloadStream(file._id));
    },
  );
}
