import { createHmac, timingSafeEqual } from 'node:crypto';
import { GridFSBucket, type GridFSFile, type ObjectId } from 'mongodb';
import { getDb, MEDIA_BUCKET_NAME } from './mongo.js';

/**
 * Encrypted media storage in MongoDB GridFS, plus the signed, expiring URLs that stand
 * in for S3 pre-signed URLs.
 *
 * The client still uploads and downloads with a plain PUT/GET to a URL it was handed,
 * exactly as it did against S3/MinIO. Those URLs now point at this API, and carry an
 * HMAC-signed token that binds the storage key, the operation, the exact byte length
 * (for uploads) and an expiry. Only ciphertext ever passes through; the media key and
 * IV stay inside the end-to-end encrypted message body, as before.
 */

export type MediaUrlAction = 'put' | 'get';

export interface MediaUrlClaims {
  /** Storage key (GridFS filename). */
  k: string;
  /** Operation this URL authorizes. */
  a: MediaUrlAction;
  /** Exact ciphertext size in bytes (uploads only). */
  s?: number;
  /** Expiry, seconds since the Unix epoch. */
  e: number;
}

let signingKey: Buffer | null = null;

/** MEDIA_URL_SECRET if set; otherwise a key derived from JWT_ACCESS_SECRET, so no new
 *  required setting is introduced. Derivation keeps the two keys independent. */
function getSigningKey(): Buffer {
  if (signingKey) return signingKey;
  const explicit = process.env.MEDIA_URL_SECRET;
  if (explicit) {
    signingKey = Buffer.from(explicit, 'utf8');
    return signingKey;
  }
  const jwtSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtSecret) throw new Error('JWT_ACCESS_SECRET (or MEDIA_URL_SECRET) must be set to sign media URLs');
  signingKey = createHmac('sha256', jwtSecret).update('solace-media-url-v1').digest();
  return signingKey;
}

function sign(encodedClaims: string): string {
  return createHmac('sha256', getSigningKey()).update(encodedClaims).digest('base64url');
}

export function createMediaToken(claims: MediaUrlClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/** Returns the claims if the token is authentic, unexpired and for `action`; else null. */
export function verifyMediaToken(token: unknown, action: MediaUrlAction, nowMs = Date.now()): MediaUrlClaims | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(encoded), 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let claims: MediaUrlClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as MediaUrlClaims;
  } catch {
    return null;
  }
  if (typeof claims.k !== 'string' || claims.k.length === 0) return null;
  if (claims.a !== action) return null;
  if (typeof claims.e !== 'number' || claims.e * 1000 <= nowMs) return null;
  if (action === 'put' && (typeof claims.s !== 'number' || !Number.isInteger(claims.s) || claims.s <= 0)) return null;
  return claims;
}

let bucket: GridFSBucket | null = null;

export async function getMediaBucket(): Promise<GridFSBucket> {
  if (!bucket) bucket = new GridFSBucket(await getDb(), { bucketName: MEDIA_BUCKET_NAME });
  return bucket;
}

/** Latest stored revision for a storage key, or null. */
export async function findMediaFile(storageKey: string): Promise<GridFSFile | null> {
  const media = await getMediaBucket();
  return media.find({ filename: storageKey }).sort({ uploadDate: -1 }).limit(1).next();
}

/** Removes every revision of a storage key except `keep` (S3 "last write wins"). */
export async function deleteOtherRevisions(storageKey: string, keep: ObjectId): Promise<void> {
  const media = await getMediaBucket();
  const stale = await media.find({ filename: storageKey, _id: { $ne: keep } }).toArray();
  await Promise.all(stale.map((file) => media.delete(file._id).catch(() => undefined)));
}
