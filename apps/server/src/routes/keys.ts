import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

// This file only ever reads PUBLIC key material. There is no code path here that could
// accept or return a private key; the schema has no column for one.
//
// Encryption is stateless (see packages/crypto/src/engine.ts): to send a message a
// client needs the current device list and public keys of every recipient, and to read
// a message it needs the public key of the device that sent it. This directory is the
// only key-related thing the server has to provide. There are no one-time keys to hand
// out, nothing is consumed on read, and no key-delivery queue.

/** A raw uncompressed P-256 point (65 bytes) in base64. Anything else, notably a key
 *  registered by the earlier Olm-based client, is not usable for encryption. */
const P256_PUBLIC_KEY_B64 = /^[A-Za-z0-9+/]{87}=$/;

/** Devices not seen for this long are left out of the recipient list of new messages,
 *  so abandoned browsers do not accumulate forever. Logging in or refreshing a session
 *  marks a device as seen again. */
const DEVICE_ACTIVE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_DEVICES_PER_USER = 10;

export function isUsablePublicKey(publicKey: string): boolean {
  return P256_PUBLIC_KEY_B64.test(publicKey);
}

const lookupSchema = z
  .object({
    userIds: z.array(z.string().uuid()).max(100).optional(),
    deviceIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .refine((v) => (v.userIds?.length ?? 0) + (v.deviceIds?.length ?? 0) > 0, { message: 'nothing_to_look_up' });

interface DeviceRow {
  id: string;
  userId: string;
  identityKeyPublic: string;
}

export async function keyRoutes(app: FastifyInstance) {
  // Batch directory lookup.
  //  - userIds:   the ACTIVE devices of those users (recipients for a new message).
  //  - deviceIds: those exact devices regardless of age (to verify the sender of an
  //               old message, which may have been written by a long-idle device).
  app.post('/keys/lookup', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = lookupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const { userIds, deviceIds } = parsed.data;

    const found = new Map<string, { userId: string; deviceId: string; identityKeyPublic: string }>();

    if (userIds && userIds.length > 0) {
      const cutoff = new Date(Date.now() - DEVICE_ACTIVE_WINDOW_MS);
      const rows: DeviceRow[] = await prisma.device.findMany({
        where: { userId: { in: userIds }, lastSeenAt: { gte: cutoff } },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, userId: true, identityKeyPublic: true },
      });
      const perUser = new Map<string, number>();
      for (const row of rows) {
        if (!isUsablePublicKey(row.identityKeyPublic)) continue;
        const count = perUser.get(row.userId) ?? 0;
        if (count >= MAX_ACTIVE_DEVICES_PER_USER) continue;
        perUser.set(row.userId, count + 1);
        found.set(row.id, { userId: row.userId, deviceId: row.id, identityKeyPublic: row.identityKeyPublic });
      }
    }

    if (deviceIds && deviceIds.length > 0) {
      const rows: DeviceRow[] = await prisma.device.findMany({
        where: { id: { in: deviceIds } },
        select: { id: true, userId: true, identityKeyPublic: true },
      });
      for (const row of rows) {
        if (!isUsablePublicKey(row.identityKeyPublic)) continue;
        found.set(row.id, { userId: row.userId, deviceId: row.id, identityKeyPublic: row.identityKeyPublic });
      }
    }

    return reply.send({ devices: [...found.values()] });
  });
}
