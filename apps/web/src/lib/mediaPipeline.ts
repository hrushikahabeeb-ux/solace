'use client';

import {
  generateMediaKey,
  encryptBlob,
  decryptBlob,
  hashCiphertext,
  keyMaterialToJson,
  importMediaKey,
} from '@solace/crypto';
import { api } from './api';
import type { MessageEnvelope } from './messageEnvelope';

const MAX_DIMENSION = 1600; // for compressed sends
const THUMBNAIL_MAX_DIMENSION = 240;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

export function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
}

/**
 * Redraws an image onto a canvas at a bounded size. Canvas re-encoding is also how
 * EXIF metadata gets stripped by default — a <canvas> never carries EXIF through to
 * its output, so this single step satisfies both "compress" and "strip metadata"
 * unless the caller explicitly asks to preserve the original (see uploadEncryptedMedia).
 */
async function redrawImage(file: File, maxDimension: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))), 'image/jpeg', quality);
  });
}

async function generateThumbnailBase64(file: File): Promise<string> {
  const blob = await redrawImage(file, THUMBNAIL_MAX_DIMENSION, 0.5);
  const buffer = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return `data:image/jpeg;base64,${base64}`;
}

export interface UploadResult {
  envelope: MessageEnvelope;
  media: { storageKey: string; sizeBytes: number; contentHash: string; mimeTypeGuess: string };
}

/** Encrypts and uploads a recorded voice clip. Shares the same encrypt/upload
 *  internals as uploadEncryptedMedia but skips the image-specific compress/thumbnail
 *  steps and carries a duration instead. */
export async function uploadEncryptedVoice(
  blob: Blob,
  durationSeconds: number,
  accessToken: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const { key, keyRaw, iv } = await generateMediaKey();
  const ciphertext = await encryptBlob(blob, key, iv);
  const contentHash = await hashCiphertext([ciphertext]);

  const { storageKey, uploadUrl } = await api.getUploadUrl(ciphertext.byteLength, accessToken);
  await uploadWithProgress(uploadUrl, ciphertext, onProgress);

  const mimeType = blob.type || 'audio/webm';
  const envelope: MessageEnvelope = {
    kind: 'media',
    mediaType: 'voice',
    filename: `voice-message.${mimeType.split('/')[1] ?? 'webm'}`,
    mimeType,
    sizeBytes: blob.size,
    keyMaterial: keyMaterialToJson(keyRaw, iv, contentHash),
    durationSeconds,
  };

  return {
    envelope,
    media: { storageKey, sizeBytes: ciphertext.byteLength, contentHash, mimeTypeGuess: mimeType },
  };
}

/**
 * Encrypts and uploads a file, returning the encrypted envelope ready to send through
 * the normal message encryption path (see e2ee.ts) plus the plain metadata the server needs
 * to create the MediaObject row. The file's own bytes never touch our API process —
 * they go straight from this function to object storage via a pre-signed URL.
 */
export async function uploadEncryptedMedia(
  file: File,
  accessToken: string,
  options: { sendOriginalQuality: boolean; onProgress?: (fraction: number) => void },
): Promise<UploadResult> {
  const isImage = isImageFile(file);

  let processedBlob: Blob = file;
  let thumbnailBase64: string | undefined;
  if (isImage) {
    thumbnailBase64 = await generateThumbnailBase64(file).catch(() => undefined);
    // Original quality ALSO means "keep whatever metadata the file already has" — the
    // architecture calls for stripping EXIF by default and preserving it only on
    // explicit request, and skipping the canvas re-encode is exactly that request.
    if (!options.sendOriginalQuality) {
      processedBlob = await redrawImage(file, MAX_DIMENSION, 0.82);
    }
  }

  const { key, keyRaw, iv } = await generateMediaKey();
  const ciphertext = await encryptBlob(processedBlob, key, iv);
  const contentHash = await hashCiphertext([ciphertext]);

  const { storageKey, uploadUrl } = await api.getUploadUrl(ciphertext.byteLength, accessToken);
  await uploadWithProgress(uploadUrl, ciphertext, options.onProgress);

  const envelope: MessageEnvelope = {
    kind: 'media',
    mediaType: isImage ? 'image' : 'file',
    filename: file.name,
    mimeType: isImage ? 'image/jpeg' : file.type || 'application/octet-stream',
    sizeBytes: processedBlob.size,
    keyMaterial: keyMaterialToJson(keyRaw, iv, contentHash),
    thumbnailBase64,
  };

  return {
    envelope,
    media: { storageKey, sizeBytes: ciphertext.byteLength, contentHash, mimeTypeGuess: envelope.mimeType },
  };
}

/** XHR (not fetch) because it's the only web API that reports UPLOAD progress. */
function uploadWithProgress(url: string, body: Uint8Array, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}

/**
 * Downloads and decrypts a media message's attachment, reporting download progress
 * along the way. Returns an object URL the caller is responsible for revoking
 * (URL.revokeObjectURL) once it's no longer displayed/needed.
 */
export async function downloadAndDecryptMedia(
  messageId: string,
  envelope: Extract<MessageEnvelope, { kind: 'media' }>,
  accessToken: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const { downloadUrl, sizeBytes } = await api.getDownloadUrl(messageId, accessToken);

  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);

  const reader = res.body.getReader();
  const total = Number(res.headers.get('content-length')) || sizeBytes;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress && total) onProgress(received / total);
  }
  const ciphertext = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    ciphertext.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const { key, iv } = await importMediaKey(envelope.keyMaterial);
  const plaintext = await decryptBlob(ciphertext.buffer, key, iv);
  const blob = new Blob([plaintext], { type: envelope.mimeType });
  return URL.createObjectURL(blob);
}
