import './lib/env.js'; // must stay first: loads .env before any module reads configuration
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import authenticatePlugin from './plugins/authenticate.js';
import { authRoutes } from './routes/auth.js';
import { keyRoutes } from './routes/keys.js';
import { conversationRoutes } from './routes/conversations.js';
import { groupRoutes } from './routes/groups.js';
import { moderationRoutes } from './routes/moderation.js';
import { gifRoutes } from './routes/gifs.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { taskRoutes } from './routes/tasks.js';
import { eventRoutes } from './routes/events.js';
import { noteRoutes } from './routes/notes.js';
import { decisionRoutes } from './routes/decisions.js';
import { pollRoutes } from './routes/polls.js';
import { fileRoutes } from './routes/files.js';
import { messageActionRoutes } from './routes/messageActions.js';
import { linkPreviewRoutes } from './routes/linkPreview.js';
import { mediaRoutes } from './routes/media.js';
import { callRoutes } from './routes/calls.js';
import { realtimeRoutes } from './realtime/wsRoute.js';
import { startBackgroundSweeps } from './jobs/sweeps.js';
import { startRealtimeHub, stopRealtimeHub } from './realtime/hub.js';
import { prisma } from './lib/prisma.js';
import { pingMongo, closeMongo } from './lib/mongo.js';

const app = Fastify({ logger: true, trustProxy: true });

// Fastify's default JSON body parser rejects an empty body outright whenever
// Content-Type: application/json is set, even for routes that never expected a body
// (POST /auth/refresh, POST /auth/logout, several DELETE endpoints). The client is
// now careful not to send that header without an actual body, but this is the
// belt-and-suspenders fix: treat an empty body as "no payload" rather than a parse
// error, so any bodyless request degrades gracefully regardless of client behavior.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  if (!body) {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  credentials: true,
});
await app.register(cookie);
await app.register(compress); // gzip/brotli API responses — cheap win, no code changes needed elsewhere
await app.register(rateLimit, {
  max: 120, // per-IP requests per window — generous for normal use, blunts basic abuse/scraping
  timeWindow: '1 minute',
});
await app.register(websocket);
await app.register(authenticatePlugin);

// Tighter limits on the endpoints most worth protecting specifically: auth (brute
// force) and message sends (spam). These stack on top of the global limit above.
await app.register(authRoutes);
await app.register(keyRoutes);
await app.register(conversationRoutes);
await app.register(groupRoutes);
await app.register(moderationRoutes);
await app.register(gifRoutes);
await app.register(workspaceRoutes);
await app.register(taskRoutes);
await app.register(eventRoutes);
await app.register(noteRoutes);
await app.register(decisionRoutes);
await app.register(pollRoutes);
await app.register(fileRoutes);
await app.register(messageActionRoutes);
await app.register(linkPreviewRoutes);
await app.register(mediaRoutes);
await app.register(callRoutes);
await app.register(realtimeRoutes);

startBackgroundSweeps();
startRealtimeHub();

app.get('/health', async () => ({ status: 'ok' }));

// A separate readiness check from /health: this one actually touches MongoDB through
// both clients (Prisma and the native driver), so a load balancer or orchestrator can
// tell "process is up" (/health) apart from "process can actually serve traffic"
// (/ready) — the standard k8s-style split.
app.get('/ready', async (_request, reply) => {
  try {
    await Promise.all([prisma.$runCommandRaw({ ping: 1 }), pingMongo()]);
    return { status: 'ready' };
  } catch (err) {
    app.log.error(err);
    return reply.status(503).send({ status: 'not_ready' });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Close every connection cleanly on shutdown (Ctrl+C in dev, or a process
// manager's SIGTERM in production) instead of leaving sockets dangling.
async function shutdown() {
  app.log.info('Shutting down...');
  await app.close();
  await stopRealtimeHub();
  await prisma.$disconnect();
  await closeMongo();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
