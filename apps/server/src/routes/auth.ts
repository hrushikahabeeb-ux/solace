import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/auth.js';
import { isUsablePublicKey } from './keys.js';

// A device is identified to other users by a single public key: an ECDH P-256 identity
// key generated in the browser (see packages/crypto/src/identity.ts). The matching
// private key is non-extractable and never leaves the browser. Only the public key
// appears in this schema; there is no field here that could hold a private key.
//
// The database still has the columns and tables the earlier Olm-based design used
// (signedPreKeyPublic, signedPreKeySig, OneTimePreKey, ToDeviceMessage). They are no
// longer read or written with meaningful data; new devices store an empty string in
// the two legacy columns so the schema did not have to change.
const deviceSchema = z.object({
  label: z.string().min(1).max(64),
  identityKeyPublic: z.string().refine(isUsablePublicKey, { message: 'invalid_public_key' }),
});

const registerSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-z0-9_.]+$/i),
  displayName: z.string().min(1).max(64),
  password: z.string().min(12).max(256), // enforce a real passphrase length, not "8 chars"
  device: deviceSchema,
});

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
  // Present when this browser already holds the private key for one of the account's
  // devices (see lib/authSession.tsx): reuse that exact device instead of minting a
  // new one, so messages sent to it stay readable across logins.
  existingDeviceId: z.string().uuid().optional(),
  // Only required when there is no existing device to reuse (a genuinely new
  // browser), since creating a device needs its public key.
  device: deviceSchema.optional(),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const { username, displayName, password, device } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return reply.status(409).send({ error: 'username_taken' });
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        username,
        displayName,
        passwordHash,
        devices: {
          create: {
            label: device.label,
            identityKeyPublic: device.identityKeyPublic,
            signedPreKeyPublic: '', // legacy column, unused (see comment at top of file)
            signedPreKeySig: '', // legacy column, unused
          },
        },
      },
      include: { devices: true },
    });

    const deviceId = user.devices[0].id;
    const accessToken = signAccessToken({ sub: user.id, deviceId });
    const refreshToken = signRefreshToken({ sub: user.id, deviceId });

    reply.setCookie('solace_refresh', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 60 * 60 * 24 * 30,
    });

    return reply.status(201).send({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      deviceId,
      accessToken,
    });
  });

  app.post(
    '/auth/login',
    // Tighter than the global limit set in index.ts — login is the endpoint a
    // credential-stuffing / brute-force attempt would actually hit.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    const { username, password, device, existingDeviceId } = parsed.data;

    const user = await prisma.user.findUnique({ where: { username } });
    // Constant-shape response whether the user exists or the password is wrong —
    // do not leak which one failed.
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      return reply.status(401).send({ error: 'invalid_credentials' });
    }

    let deviceId: string;
    if (existingDeviceId) {
      // Reusing a device the client already holds the private key for. Verify it
      // actually belongs to this user before trusting it — a deviceId is not a
      // secret, so this must never be trusted on its own.
      const existing = await prisma.device.findFirst({ where: { id: existingDeviceId, userId: user.id } });
      if (!existing) return reply.status(401).send({ error: 'invalid_device' });
      deviceId = existing.id;
      await prisma.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
    } else {
      if (!device) return reply.status(400).send({ error: 'invalid_request' });
      const newDevice = await prisma.device.create({
        data: {
          userId: user.id,
          label: device.label,
          identityKeyPublic: device.identityKeyPublic,
          signedPreKeyPublic: '', // legacy column, unused (see comment at top of file)
          signedPreKeySig: '', // legacy column, unused
        },
      });
      deviceId = newDevice.id;
    }

    const accessToken = signAccessToken({ sub: user.id, deviceId });
    const refreshToken = signRefreshToken({ sub: user.id, deviceId });

    reply.setCookie('solace_refresh', refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/auth/refresh',
      maxAge: 60 * 60 * 24 * 30,
    });

    return reply.send({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      deviceId,
      accessToken,
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies['solace_refresh'];
    if (!token) return reply.status(401).send({ error: 'no_refresh_token' });

    try {
      const payload = verifyRefreshToken(token);
      const accessToken = signAccessToken({ sub: payload.sub, deviceId: payload.deviceId });
      // Keeps an in-use device in other users' recipient lists (see routes/keys.ts).
      await prisma.device
        .updateMany({ where: { id: payload.deviceId, userId: payload.sub }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
      return reply.send({ accessToken });
    } catch {
      return reply.status(401).send({ error: 'invalid_refresh_token' });
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    reply.clearCookie('solace_refresh', { path: '/auth/refresh' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: app.requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
    if (!user) return reply.status(404).send({ error: 'user_not_found' });
    return reply.send({
      user: { id: user.id, username: user.username, displayName: user.displayName },
      deviceId: request.auth!.deviceId,
    });
  });
}
