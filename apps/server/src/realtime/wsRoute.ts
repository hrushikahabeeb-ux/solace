import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { registerConnection, publishToUser } from './hub.js';
import { callService } from './callsRuntime.js';

const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('typing'), conversationId: z.string().uuid(), state: z.enum(['start', 'stop']) }),
]);

export async function realtimeRoutes(app: FastifyInstance) {
  // @fastify/websocket v10's handler receives the raw WebSocket as the first
  // argument directly — earlier versions wrapped it in a `{ socket }` object, which
  // is a common stale-pattern mistake to carry over from older examples/docs.
  app.get('/ws', { websocket: true }, async (socket, request) => {
    const token = (request.query as Record<string, string | undefined>).token;
    if (!token) {
      socket.close(4001, 'missing_token');
      return;
    }

    let userId: string;
    try {
      userId = verifyAccessToken(token).sub;
    } catch {
      socket.close(4001, 'invalid_token');
      return;
    }

    registerConnection(userId, socket);
    socket.send(JSON.stringify({ type: 'ready' }));

    socket.on('message', async (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames rather than dropping the connection
      }
      // Call signaling frames are validated and handled by the call service, which owns
      // its own protocol (see calls.ts). Everything else falls through unchanged.
      const frameType = (parsed as { type?: unknown } | null)?.type;
      if (typeof frameType === 'string' && frameType.startsWith('call.')) {
        await callService.handleFrame(userId, parsed).catch((err) => request.log.error(err, 'call frame failed'));
        return;
      }

      const frame = clientFrameSchema.safeParse(parsed);
      if (!frame.success) return;

      if (frame.data.type === 'typing') {
        const members = await prisma.conversationMember.findMany({
          where: { conversationId: frame.data.conversationId, userId: { not: userId } },
          select: { userId: true },
        });
        await Promise.all(
          members.map((m) =>
            publishToUser(m.userId, {
              type: 'typing',
              conversationId: frame.data.conversationId,
              userId,
              state: frame.data.state,
            }),
          ),
        );
      }
    });
  });
}
