import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';

// Long enough to cover the longest call the signaling layer allows to stay alive, since a
// TURN allocation cannot be refreshed once the credential that created it has expired.
const TURN_CREDENTIAL_TTL_SECONDS = 8 * 60 * 60;

// Used only when neither STUN_URLS nor TURN_URLS is configured, so local development works
// out of the box. A public STUN server learns each client's public IP address, so a real
// deployment should run its own (coturn answers STUN too); see DEPLOYMENT.md.
const DEFAULT_DEV_STUN = 'stun:stun.l.google.com:19302';

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Builds the ICE server list handed to one authenticated user. Exported for testing. */
export function buildIceServers(userId: string, env: NodeJS.ProcessEnv, nowMs = Date.now()): {
  iceServers: IceServerConfig[];
  relayAvailable: boolean;
  ttlSeconds: number;
} {
  const turnUrls = splitList(env.TURN_URLS);
  const stunUrls = splitList(env.STUN_URLS);
  const turnSecret = env.TURN_SECRET;

  const iceServers: IceServerConfig[] = [];

  if (stunUrls.length > 0) iceServers.push({ urls: stunUrls });

  const turnUsername = env.TURN_USERNAME;
  const turnPassword = env.TURN_PASSWORD;

  let relayAvailable = false;
  if (turnUrls.length > 0 && !turnSecret && turnUsername && turnPassword) {
    // Static credentials from a hosted TURN provider.
    iceServers.push({ urls: turnUrls, username: turnUsername, credential: turnPassword });
    relayAvailable = true;
  } else if (turnUrls.length > 0 && turnSecret) {
    // TURN REST API credentials (draft-uberti-behave-turn-rest): the username carries its
    // own expiry, and the password is an HMAC of it under the secret shared with coturn.
    // Nothing long-lived is ever sent to a client, and the secret never leaves the server.
    const expiry = Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
    relayAvailable = true;
  }

  // Nothing usable configured (or TURN_URLS set without its secret): fall back to the dev
  // STUN server rather than handing clients an empty list, which would break every call
  // that is not on the same network.
  if (iceServers.length === 0) iceServers.push({ urls: [DEFAULT_DEV_STUN] });

  return { iceServers, relayAvailable, ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS };
}

export async function callRoutes(app: FastifyInstance) {
  app.get('/calls/ice-servers', { preHandler: app.requireAuth }, async (request, reply) => {
    return reply.send(buildIceServers(request.auth!.userId, process.env));
  });
}
