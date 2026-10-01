import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../lib/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; deviceId: string };
  }
}

export default fp(async function authenticatePlugin(app: FastifyInstance) {
  app.decorateRequest('auth', undefined);

  app.decorate('requireAuth', async function (request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing_token' });
    }
    try {
      const payload = verifyAccessToken(header.slice('Bearer '.length));
      request.auth = { userId: payload.sub, deviceId: payload.deviceId };
    } catch {
      return reply.status(401).send({ error: 'invalid_token' });
    }
  });
});
