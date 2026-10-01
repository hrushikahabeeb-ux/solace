import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// Proxies GIF search to Giphy so the client never calls a third-party API directly
// with its own IP/session. Requires the operator's own GIPHY_API_KEY (free tier
// available at developers.giphy.com) — this project ships no key of its own. Without
// one configured, the endpoint degrades to "not configured" rather than failing
// confusingly, and the client hides the GIF picker entirely in that case.
export async function gifRoutes(app: FastifyInstance) {
  app.get('/gifs/search', { preHandler: app.requireAuth }, async (request, reply) => {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return reply.status(501).send({ error: 'not_configured' });

    const query = z.object({ q: z.string().min(1).max(100) }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'invalid_request' });

    try {
      const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query.data.q)}&limit=16&rating=pg`;
      const res = await fetch(url);
      if (!res.ok) return reply.status(502).send({ error: 'giphy_error' });
      const data = (await res.json()) as { data: Array<{ id: string; images: Record<string, { url: string }> }> };

      const results = data.data.map((gif) => ({
        id: gif.id,
        previewUrl: gif.images.fixed_width_small?.url ?? gif.images.fixed_width?.url,
        url: gif.images.original?.url,
      }));
      return reply.send({ results });
    } catch {
      return reply.status(502).send({ error: 'giphy_error' });
    }
  });
}
