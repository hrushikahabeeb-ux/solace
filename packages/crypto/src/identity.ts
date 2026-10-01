/**
 * Device identity: one ECDH P-256 key pair per browser profile.
 *
 * P-256 is used because it is the one elliptic curve every current browser and every
 * supported Node version implements in WebCrypto. (X25519 would be preferable on paper
 * but is still missing from parts of the installed browser base.)
 *
 * The private key is generated as NON-EXTRACTABLE. WebCrypto guarantees that no script,
 * including an injected one, can ever read its raw bytes; the key can only be used
 * through `deriveBits` while the page is running. Because a non-extractable CryptoKey
 * is structured-cloneable, it can be stored in IndexedDB directly (see vault.ts) and
 * survives page reloads without any passphrase being held in memory.
 */
import { fromBase64, toBase64, asBufferSource } from './bytes.js';

export const CURVE = 'P-256';

/** Raw uncompressed P-256 public key: 0x04 || X(32) || Y(32) = 65 bytes = 88 base64 chars. */
const RAW_PUBLIC_KEY_BYTES = 65;
const PUBLIC_KEY_B64 = /^[A-Za-z0-9+/]{87}=$/;

export interface DeviceIdentity {
  /** Non-extractable; usable only for ECDH `deriveBits`. */
  privateKey: CryptoKey;
  /** Base64 of the raw uncompressed public key. Safe to upload to the server. */
  publicKey: string;
}

export async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, false, ['deriveBits']);
  // The public half of a generated pair is always exportable, even when the private
  // half was requested as non-extractable.
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64(raw) };
}

/** Cheap structural check used both before uploading and when reading the directory. */
export function isWellFormedPublicKey(publicKey: string): boolean {
  if (!PUBLIC_KEY_B64.test(publicKey)) return false;
  try {
    const raw = fromBase64(publicKey);
    return raw.length === RAW_PUBLIC_KEY_BYTES && raw[0] === 0x04;
  } catch {
    return false;
  }
}

/** Imports a peer's public key. Throws if the bytes are not a valid point on the curve. */
export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    asBufferSource(fromBase64(publicKey)),
    { name: 'ECDH', namedCurve: CURVE },
    false,
    [],
  );
}
