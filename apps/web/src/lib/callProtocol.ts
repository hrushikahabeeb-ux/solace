/**
 * Types and helpers shared by the call signaling client and the call session.
 *
 * Everything the two peers exchange to set up a call (SDP offers/answers, ICE candidates,
 * mute/camera state) travels as a `SignalMessage` inside a `call.signal` frame, END-TO-END
 * ENCRYPTED with the same engine that protects chat messages (see CallProvider). The server
 * relays the ciphertext and cannot read it. That matters for two reasons:
 *
 *  1. The SDP contains the DTLS fingerprint that authenticates the media connection. If the
 *     server could edit it, it could sit in the middle of a call. Encrypted under the peer's
 *     device identity key, it cannot.
 *  2. The SDP and ICE candidates contain IP addresses. Encrypted, the server never sees them.
 */

export type CallMedia = 'audio' | 'video';

/** A random RFC 4122 v4 UUID. `crypto.randomUUID` only exists in secure contexts, and this
 *  runs inside a provider that wraps the whole app, so it must never throw. The server
 *  validates call ids as UUIDs, hence a real v4 rather than an arbitrary string. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export type SignalMessage =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidates: RTCIceCandidateInit[] }
  | { t: 'state'; audio: boolean; video: boolean };

export type CallEndReason = 'hangup' | 'declined' | 'cancelled' | 'missed';
export type CallRejectReason = 'busy' | 'self_busy' | 'unavailable' | 'not_allowed' | 'rate_limited';

/** Frames the server sends to the client for calls. */
export type CallServerEvent =
  | {
      type: 'call.incoming';
      callId: string;
      conversationId: string;
      media: CallMedia;
      from: { id: string; username: string; displayName: string };
      callerClient: string;
    }
  | { type: 'call.ringing'; callId: string }
  | { type: 'call.accepted'; callId: string; by: string }
  | { type: 'call.signal'; callId: string; from: string; payload: string }
  | { type: 'call.ended'; callId: string; reason: CallEndReason; by: string | null }
  | { type: 'call.rejected'; callId: string; reason: CallRejectReason };

/** Frames the client sends to the server for calls. */
export type CallClientFrame =
  | { type: 'call.invite'; callId: string; conversationId: string; media: CallMedia; clientId: string }
  | { type: 'call.accept'; callId: string; clientId: string }
  | { type: 'call.decline'; callId: string }
  | { type: 'call.end'; callId: string }
  | { type: 'call.keepalive'; callId: string }
  | { type: 'call.signal'; callId: string; payload: string };

const MAX_SDP_LENGTH = 64 * 1024;
const MAX_CANDIDATES_PER_MESSAGE = 64;
const MAX_CANDIDATE_LENGTH = 1024;

/** What actually gets encrypted. `callId` is bound in so a signal recorded from one call
 *  cannot be replayed into another. */
interface SignalEnvelope {
  v: 1;
  callId: string;
  msg: SignalMessage;
}

export function encodeSignal(callId: string, msg: SignalMessage): string {
  const envelope: SignalEnvelope = { v: 1, callId, msg };
  return JSON.stringify(envelope);
}

function isCandidateInit(value: unknown): value is RTCIceCandidateInit {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE_LENGTH) return false;
  if (c.sdpMid !== undefined && c.sdpMid !== null && typeof c.sdpMid !== 'string') return false;
  if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null && typeof c.sdpMLineIndex !== 'number') return false;
  if (c.usernameFragment !== undefined && c.usernameFragment !== null && typeof c.usernameFragment !== 'string') return false;
  return true;
}

/** Parses and strictly validates a decrypted signal. Returns null for anything that is not
 *  exactly a well-formed message for THIS call. The peer controls this content, so nothing
 *  is trusted until it has been checked. */
export function decodeSignal(raw: string, expectedCallId: string): SignalMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Partial<SignalEnvelope>;
  if (envelope.v !== 1 || envelope.callId !== expectedCallId) return null;

  const msg = envelope.msg as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') return null;

  switch (msg.t) {
    case 'offer':
    case 'answer':
      if (typeof msg.sdp !== 'string' || msg.sdp.length === 0 || msg.sdp.length > MAX_SDP_LENGTH) return null;
      return { t: msg.t, sdp: msg.sdp };
    case 'ice': {
      const candidates = msg.candidates;
      if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES_PER_MESSAGE) return null;
      if (!candidates.every(isCandidateInit)) return null;
      return { t: 'ice', candidates };
    }
    case 'state':
      if (typeof msg.audio !== 'boolean' || typeof msg.video !== 'boolean') return null;
      return { t: 'state', audio: msg.audio, video: msg.video };
    default:
      return null;
  }
}
