import type { MediaKeyMaterial } from '@solace/crypto';

/**
 * What actually gets encrypted for a message is always JSON matching this
 * shape, never a raw string. For media, this is also the ONLY place the AES key/IV
 * ever travels — end-to-end, inside the same channel as ordinary text, never as a URL
 * or a plain API field (see mediaPipeline.ts).
 */
export type MessageEnvelope =
  | { kind: 'text'; text: string; forwardedFromDisplayName?: string }
  | {
      kind: 'media';
      mediaType: 'image' | 'file' | 'voice';
      filename: string;
      mimeType: string;
      sizeBytes: number;
      keyMaterial: MediaKeyMaterial;
      thumbnailBase64?: string; // small, so it's embedded directly — no second fetch needed to show a preview
      durationSeconds?: number; // voice messages only
      forwardedFromDisplayName?: string;
    }
  | { kind: 'sticker'; emoji: string; forwardedFromDisplayName?: string }
  | { kind: 'gif'; url: string; previewUrl: string; forwardedFromDisplayName?: string }
  // A finished call, posted by the caller's client (see lib/callLog.ts).
  | { kind: 'call'; media: 'audio' | 'video'; outcome: 'completed' | 'missed' | 'declined' | 'failed'; durationSeconds?: number };

export function encodeEnvelope(envelope: MessageEnvelope): string {
  return JSON.stringify(envelope);
}

const CALL_OUTCOMES = ['completed', 'missed', 'declined', 'failed'] as const;

function parseCallEnvelope(value: Record<string, unknown>): Extract<MessageEnvelope, { kind: 'call' }> | null {
  const { media, outcome, durationSeconds } = value;
  if (media !== 'audio' && media !== 'video') return null;
  if (!CALL_OUTCOMES.includes(outcome as (typeof CALL_OUTCOMES)[number])) return null;
  if (durationSeconds !== undefined) {
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  }
  return {
    kind: 'call',
    media,
    outcome: outcome as (typeof CALL_OUTCOMES)[number],
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

export function decodeEnvelope(raw: string): MessageEnvelope {
  try {
    const parsed = JSON.parse(raw);
    const validKinds = ['text', 'media', 'sticker', 'gif'];
    if (parsed && typeof parsed === 'object') {
      if (parsed.kind === 'call') {
        // The sender controls this content, so rebuild it from checked fields only.
        const call = parseCallEnvelope(parsed as Record<string, unknown>);
        if (call) return call;
      } else if (validKinds.includes(parsed.kind)) {
        return parsed as MessageEnvelope;
      }
    }
  } catch {
    // fall through — legacy/plain-text payload from before this envelope format existed
  }
  return { kind: 'text', text: raw };
}
