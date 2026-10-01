/**
 * Small, dependency-free byte helpers shared by the crypto package. Everything here
 * relies only on APIs that exist identically in browsers and Node 18+ (btoa/atob,
 * TextEncoder, crypto.getRandomValues), so the same code path is exercised by the unit
 * tests and by the production bundle. In particular there is no use of Node's `Buffer`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/**
 * TypeScript 5.7+ types `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which is not
 * assignable to WebCrypto's `BufferSource` parameter even though every runtime accepts
 * it. This is the single place where that mismatch is bridged.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
