/**
 * Media/file encryption for images, videos, and arbitrary files.
 * Uses WebCrypto's AES-256-GCM exclusively — a standard, browser-native, audited AEAD
 * primitive. Key + IV are generated fresh per file and never reused.
 *
 * The resulting `MediaKeyMaterial` is the ONLY thing that travels through the E2EE
 * messaging channel (as JSON inside an end-to-end encrypted message body (see engine.ts)). It must
 * never be placed in a URL, query string, or unencrypted API response.
 */

export interface MediaKeyMaterial {
  keyRaw: string; // base64 AES-256 key
  iv: string; // base64 96-bit IV, required by GCM
  contentHash: string; // base64 SHA-256 of the CIPHERTEXT, for integrity verification after download
}

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB — encrypt/upload in chunks so large videos don't need to fit in memory

export async function generateMediaKey(): Promise<{ key: CryptoKey; keyRaw: ArrayBuffer; iv: Uint8Array }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const keyRaw = await crypto.subtle.exportKey('raw', key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { key, keyRaw, iv };
}

/**
 * Encrypts a File/Blob in fixed-size chunks. Each chunk is its own AES-GCM operation
 * with a counter appended to the IV, so chunks can be decrypted independently once
 * downloaded (needed to support pause/resume without buffering the whole file).
 */
export async function* encryptFileChunks(
  file: Blob,
  key: CryptoKey,
  baseIv: Uint8Array,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let chunkIndex = 0;
  while (offset < file.size) {
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    const iv = ivForChunk(baseIv, chunkIndex);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, chunk);
    yield new Uint8Array(ciphertext);
    offset += CHUNK_SIZE;
    chunkIndex += 1;
  }
}

export async function decryptFileChunk(
  ciphertextChunk: ArrayBuffer,
  key: CryptoKey,
  baseIv: Uint8Array,
  chunkIndex: number,
): Promise<ArrayBuffer> {
  const iv = ivForChunk(baseIv, chunkIndex);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertextChunk);
}

/** Derives a per-chunk IV by XOR-ing the chunk index into the low bytes of the base IV.
 *  This keeps every (key, iv) pair used with AES-GCM unique, which is the one hard
 *  requirement for GCM's security. */
function ivForChunk(baseIv: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(baseIv);
  const view = new DataView(iv.buffer, iv.byteOffset + 8, 4);
  view.setUint32(0, view.getUint32(0) ^ chunkIndex, false);
  return iv;
}

export async function hashCiphertext(chunks: Uint8Array[]): Promise<string> {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', merged);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export function keyMaterialToJson(keyRaw: ArrayBuffer, iv: Uint8Array, contentHash: string): MediaKeyMaterial {
  return {
    keyRaw: btoa(String.fromCharCode(...new Uint8Array(keyRaw))),
    iv: btoa(String.fromCharCode(...iv)),
    contentHash,
  };
}

export async function importMediaKey(material: MediaKeyMaterial): Promise<{ key: CryptoKey; iv: Uint8Array }> {
  const keyRaw = Uint8Array.from(atob(material.keyRaw), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(material.iv), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['decrypt']);
  return { key, iv };
}

/**
 * Single-shot whole-file AES-GCM encrypt/decrypt, used by the Phase 4 upload/download
 * pipeline. This is simpler and easier to get correct than reconstructing chunk
 * boundaries on download, and WebCrypto's native AES-GCM handles files of a few
 * hundred MB without issue. True chunked streaming (so a multi-GB video never needs
 * to fully fit in memory, and so pause/resume can resume mid-file rather than
 * restarting the whole transfer) is real, additional work — `encryptFileChunks` /
 * `decryptFileChunk` above are left in place as the basis for that follow-up.
 */
export async function encryptBlob(file: Blob, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  const plaintext = await file.arrayBuffer();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);
  return new Uint8Array(ciphertext);
}

export async function decryptBlob(ciphertext: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ciphertext);
}
