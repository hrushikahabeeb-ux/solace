import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// Privacy note: this endpoint deliberately does NOT log which user/conversation asked
// for which URL beyond the request itself, and it strips the destination response down
// to a few display fields before returning it. The destination site sees our server's
// IP, not the requester's, and never learns this URL came from an encrypted message.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024; // don't pull an entire video down to read 40 bytes of <head>

function extractMeta(html: string, property: string): string | null {
  const patternA = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
  const patternB = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
  return html.match(patternA)?.[1] ?? html.match(patternB)?.[1] ?? null;
}

export async function linkPreviewRoutes(app: FastifyInstance) {
  app.get('/link-preview', { preHandler: app.requireAuth }, async (request, reply) => {
    const query = z.object({ url: z.string().url() }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_request' });

    let target: URL;
    try {
      target = new URL(query.data.url);
    } catch {
      return reply.status(400).send({ error: 'invalid_url' });
    }
    if (!ALLOWED_PROTOCOLS.has(target.protocol)) return reply.status(400).send({ error: 'unsupported_protocol' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'SolaceLinkPreview/1.0 (+privacy-preserving fetch)' },
      });
      const reader = res.body?.getReader();
      let html = '';
      let bytesRead = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (bytesRead < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          html += decoder.decode(value, { stream: true });
        }
        reader.cancel().catch(() => undefined);
      }

      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const preview = {
        url: target.toString(),
        title: extractMeta(html, 'og:title') ?? titleMatch?.[1]?.trim() ?? target.hostname,
        description: extractMeta(html, 'og:description') ?? extractMeta(html, 'description'),
        image: extractMeta(html, 'og:image'),
      };
      return reply.send(preview);
    } catch {
      return reply.status(502).send({ error: 'fetch_failed' });
    } finally {
      clearTimeout(timeout);
    }
  });
}
