import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

// Argon2id parameters chosen per OWASP's current minimum recommendation for
// interactive login (memory-hard, tuned for a web request budget, not a batch job).
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  return argon2.verify(hash, plaintext);
}

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';

interface AccessTokenPayload {
  sub: string; // userId
  deviceId: string;
}

function requireSecret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Generate one with: openssl rand -base64 48`);
  }
  return value;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, requireSecret('JWT_ACCESS_SECRET'), { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, requireSecret('JWT_ACCESS_SECRET')) as AccessTokenPayload;
}

export function signRefreshToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, requireSecret('JWT_REFRESH_SECRET'), { expiresIn: REFRESH_TOKEN_TTL });
}

export function verifyRefreshToken(token: string): AccessTokenPayload {
  return jwt.verify(token, requireSecret('JWT_REFRESH_SECRET')) as AccessTokenPayload;
}
