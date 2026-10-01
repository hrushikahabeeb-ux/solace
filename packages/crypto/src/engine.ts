/**
 * Solace end-to-end encryption, protocol v2.
 *
 * DESIGN GOAL: a message must be decryptable by every intended device, at any later time,
 * any number of times, in any order, with no per-conversation state kept on the client.
 * The previous Olm/Megolm design could not offer that: a ratchet advances on every decrypt,
 * so two concurrent decrypts, a lost write, a reload, or a cleared cache made a message
 * permanently unreadable. Here nothing advances, so none of those failures can occur.
 *
 * HOW IT WORKS (a multi-recipient hybrid envelope, the same shape as age / PGP / JWE):
 *
 *   1. The sender draws a fresh random 256-bit content key (CEK) for each message and
 *      encrypts the plaintext with AES-256-GCM under it.
 *   2. For every recipient DEVICE (all devices of every conversation member, including
 *      the sender's own devices) the sender wraps the CEK under a key-encryption key
 *      derived from static-static ECDH between the two devices' identity keys:
 *
 *          KEK(S->R) = HKDF-SHA256( ECDH(privS, pubR), info = "wrap" | S | R )
 *
 *      ECDH is symmetric, so R re-derives the same KEK from (privR, pubS) without any
 *      handshake, prior session, or server-stored state.
 *   3. The wire message is the ciphertext plus one small wrap per recipient device.
 *
 * PROPERTIES
 *   - Stateless: nothing is written on decrypt, so retries and concurrency are safe.
 *   - Multi-device: every device listed at send time gets its own wrap. A device that
 *     joins later cannot read earlier messages (no history leak).
 *   - Membership changes need no key distribution: recipients are computed per message,
 *     so a removed member simply stops being wrapped for.
 *   - Sender authentication: a wrap only opens under KEK(S->R), which needs S's or R's
 *     private key, so a successful unwrap proves the message came from device S.
 *   - Context binding: conversation id, sender device and recipient device are bound
 *     into the AEAD associated data, so a ciphertext cannot be replayed into another
 *     conversation or under another sender.
 *   - Private keys are non-extractable WebCrypto keys; only audited browser primitives
 *     (ECDH P-256, HKDF-SHA256, AES-256-GCM) are used. No cryptography is hand-rolled.
 *
 * TRADE-OFF (documented in README): static device keys mean no per-message forward
 * secrecy and no post-compromise recovery, which the Double Ratchet provided. An
 * attacker who both records ciphertext and later extracts a device private key can read
 * that device's history. Non-extractable storage makes the extraction step hard, and the
 * server never holds any private key.
 */
import { asBufferSource, fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from './bytes.js';
import { isDirectoryUnavailable, type DeviceDirectory } from './directory.js';
import { importPublicKey, isWellFormedPublicKey, type DeviceIdentity } from './identity.js';

export const WIRE_PREFIX = 's2.';
const PROTOCOL = 'solace/e2ee/v2';
const CEK_BYTES = 32;
const IV_BYTES = 12;
const MAX_FIELD_LENGTH = 64;
/** Upper bound on wraps per message; protects against a directory returning a huge list. */
export const MAX_RECIPIENT_DEVICES = 256;

interface WireEnvelope {
  v: 2;
  /** Sender device id. */
  s: string;
  /** Base64 AES-GCM IV for the body. */
  i: string;
  /** Base64 AES-GCM ciphertext (includes the tag). */
  c: string;
  /** Recipient device id -> base64( wrapIv || AES-GCM(KEK, CEK) ). */
  w: Record<string, string>;
}

export interface EncryptParams {
  conversationId: string;
  /** Every OTHER member of the conversation. The sender's own user is always added. */
  recipientUserIds: string[];
  plaintext: string;
}

export interface EncryptResult {
  ciphertext: string;
  sessionRef: string;
  /** Number of devices that can read this message (including the sender's own). */
  deviceCount: number;
  /** Requested users that had no usable device and therefore cannot read this message. */
  missingUserIds: string[];
}

export interface DecryptParams {
  conversationId: string;
  ciphertext: string;
  /** The user id the server claims sent this. When given, it must match the sender device's owner. */
  senderUserId?: string;
}

export type DecryptFailure =
  /** Produced by the previous Olm-based implementation; cannot be read any more. */
  | 'legacy'
  | 'malformed'
  /** Sent before this device existed, or before the sender's client learned about it. */
  | 'not_for_this_device'
  | 'unknown_sender'
  | 'sender_mismatch'
  | 'authentication_failed'
  | 'directory_unavailable';

export type DecryptResult =
  | { ok: true; plaintext: string; senderDeviceId: string; senderUserId: string }
  | { ok: false; reason: DecryptFailure; retryable: boolean };

/** Thrown by encrypt() when nobody except the sender could read the message. */
export class RecipientsUnavailableError extends Error {
  constructor(public readonly missingUserIds: string[]) {
    super('None of the recipients has a device that can receive encrypted messages yet');
    this.name = 'RecipientsUnavailableError';
  }
}

export function formatSessionRef(conversationId: string, senderDeviceId: string): string {
  return `e2:${conversationId}:${senderDeviceId}`;
}

export function parseSessionRef(sessionRef: string): { conversationId: string; senderDeviceId: string } | null {
  const match = /^e2:([^:]+):(.+)$/.exec(sessionRef);
  return match ? { conversationId: match[1], senderDeviceId: match[2] } : null;
}

function fail(reason: DecryptFailure, retryable = false): DecryptResult {
  return { ok: false, reason, retryable };
}

function bodyAad(conversationId: string, senderDeviceId: string): Uint8Array {
  return utf8(`${PROTOCOL}|body|${conversationId}|${senderDeviceId}`);
}

function wrapAad(conversationId: string, senderDeviceId: string, recipientDeviceId: string): Uint8Array {
  return utf8(`${PROTOCOL}|wrap|${conversationId}|${senderDeviceId}|${recipientDeviceId}`);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function parseEnvelope(ciphertext: string): WireEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(ciphertext.slice(WIRE_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return null;
    const env = parsed as Partial<WireEnvelope>;
    if (env.v !== 2) return null;
    if (typeof env.s !== 'string' || env.s.length === 0 || env.s.length > MAX_FIELD_LENGTH) return null;
    if (typeof env.i !== 'string' || typeof env.c !== 'string') return null;
    if (!env.w || typeof env.w !== 'object' || Array.isArray(env.w)) return null;
    return env as WireEnvelope;
  } catch {
    return null;
  }
}

export interface EngineConfig {
  userId: string;
  deviceId: string;
  identity: DeviceIdentity;
  directory: DeviceDirectory;
}

export class E2EEEngine {
  readonly userId: string;
  readonly deviceId: string;
  private readonly identity: DeviceIdentity;
  private readonly directory: DeviceDirectory;
  // Derived keys are pure functions of (own private key, peer public key, device ids),
  // so caching them is only an optimisation. It removes the one expensive operation
  // (ECDH) from every message after the first between a pair of devices.
  private readonly kekCache = new Map<string, Promise<CryptoKey>>();
  private readonly peerKeyCache = new Map<string, Promise<CryptoKey>>();

  constructor(config: EngineConfig) {
    this.userId = config.userId;
    this.deviceId = config.deviceId;
    this.identity = config.identity;
    this.directory = config.directory;
  }

  private peerKey(publicKey: string): Promise<CryptoKey> {
    let promise = this.peerKeyCache.get(publicKey);
    if (!promise) {
      promise = importPublicKey(publicKey);
      this.peerKeyCache.set(publicKey, promise);
      promise.catch(() => this.peerKeyCache.delete(publicKey));
    }
    return promise;
  }

  /** The wrapping key for messages travelling from `senderDeviceId` to `recipientDeviceId`.
   *  `peerPublicKey` is the OTHER party's key (the recipient's when sending, the
   *  sender's when receiving); either way ECDH yields the same shared secret. */
  private kekFor(senderDeviceId: string, recipientDeviceId: string, peerPublicKey: string): Promise<CryptoKey> {
    const cacheKey = `${senderDeviceId}>${recipientDeviceId}|${peerPublicKey}`;
    let promise = this.kekCache.get(cacheKey);
    if (!promise) {
      promise = (async () => {
        const peer = await this.peerKey(peerPublicKey);
        const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, this.identity.privateKey, 256);
        const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: asBufferSource(utf8(PROTOCOL)),
            info: asBufferSource(utf8(`wrap|${senderDeviceId}|${recipientDeviceId}`)),
          },
          hkdfKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        );
      })();
      this.kekCache.set(cacheKey, promise);
      promise.catch(() => this.kekCache.delete(cacheKey));
    }
    return promise;
  }

  async encrypt(params: EncryptParams): Promise<EncryptResult> {
    const { conversationId, plaintext } = params;
    const otherUserIds = [...new Set(params.recipientUserIds)].filter((id) => id !== this.userId);
    const wantedUserIds = [this.userId, ...otherUserIds];

    // Fetching the directory can fail (network); that propagates so the caller can show
    // a send error instead of silently sending a message that nobody else can read.
    const listed = await this.directory.listDevices(wantedUserIds);

    const targets = new Map<string, { userId: string; publicKey: string }>();
    for (const device of listed) {
      if (!wantedUserIds.includes(device.userId)) continue;
      if (!isWellFormedPublicKey(device.publicKey)) continue; // e.g. a device from the Olm era
      targets.set(device.deviceId, { userId: device.userId, publicKey: device.publicKey });
    }
    // This device must always be able to read what it sends, even if the directory
    // cache has not caught up with a device that registered seconds ago.
    targets.set(this.deviceId, { userId: this.userId, publicKey: this.identity.publicKey });

    if (targets.size > MAX_RECIPIENT_DEVICES) {
      throw new Error(`Refusing to encrypt for ${targets.size} devices (limit ${MAX_RECIPIENT_DEVICES})`);
    }

    const cekRaw = randomBytes(CEK_BYTES);
    const cek = await crypto.subtle.importKey('raw', asBufferSource(cekRaw), 'AES-GCM', false, ['encrypt']);
    const bodyIv = randomBytes(IV_BYTES);
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(bodyIv),
          additionalData: asBufferSource(bodyAad(conversationId, this.deviceId)),
        },
        cek,
        asBufferSource(utf8(plaintext)),
      ),
    );

    const wraps: Record<string, string> = {};
    const reachableUsers = new Set<string>([this.userId]);
    await Promise.all(
      [...targets.entries()].map(async ([recipientDeviceId, target]) => {
        try {
          const kek = await this.kekFor(this.deviceId, recipientDeviceId, target.publicKey);
          const wrapIv = randomBytes(IV_BYTES);
          const wrapped = new Uint8Array(
            await crypto.subtle.encrypt(
              {
                name: 'AES-GCM',
                iv: asBufferSource(wrapIv),
                additionalData: asBufferSource(wrapAad(conversationId, this.deviceId, recipientDeviceId)),
              },
              kek,
              asBufferSource(cekRaw),
            ),
          );
          wraps[recipientDeviceId] = toBase64(concat(wrapIv, wrapped));
          reachableUsers.add(target.userId);
        } catch {
          // One device with an unusable key (invalid curve point, etc.) must never
          // prevent the message from reaching everybody else.
        }
      }),
    );

    const missingUserIds = otherUserIds.filter((id) => !reachableUsers.has(id));
    if (otherUserIds.length > 0 && missingUserIds.length === otherUserIds.length) {
      throw new RecipientsUnavailableError(missingUserIds);
    }

    const envelope: WireEnvelope = { v: 2, s: this.deviceId, i: toBase64(bodyIv), c: toBase64(body), w: wraps };
    return {
      ciphertext: WIRE_PREFIX + JSON.stringify(envelope),
      sessionRef: formatSessionRef(conversationId, this.deviceId),
      deviceCount: Object.keys(wraps).length,
      missingUserIds,
    };
  }

  async decrypt(params: DecryptParams): Promise<DecryptResult> {
    const { conversationId, ciphertext, senderUserId } = params;

    if (!ciphertext.startsWith(WIRE_PREFIX)) {
      // Olm bodies are plain base64; anything else is simply not one of ours.
      return /^[A-Za-z0-9+/=_-]{16,}$/.test(ciphertext) ? fail('legacy') : fail('malformed');
    }
    const envelope = parseEnvelope(ciphertext);
    if (!envelope) return fail('malformed');

    const wrapB64 = envelope.w[this.deviceId];
    if (typeof wrapB64 !== 'string') return fail('not_for_this_device');

    let senderPublicKey: string;
    let resolvedSenderUserId: string;
    if (envelope.s === this.deviceId) {
      senderPublicKey = this.identity.publicKey;
      resolvedSenderUserId = this.userId;
    } else {
      let record;
      try {
        record = await this.directory.getDevice(envelope.s);
      } catch (err) {
        if (isDirectoryUnavailable(err)) return fail('directory_unavailable', true);
        throw err;
      }
      if (!record || !isWellFormedPublicKey(record.publicKey)) return fail('unknown_sender');
      senderPublicKey = record.publicKey;
      resolvedSenderUserId = record.userId;
    }
    if (senderUserId !== undefined && senderUserId !== resolvedSenderUserId) return fail('sender_mismatch');

    try {
      const wrapBytes = fromBase64(wrapB64);
      if (wrapBytes.length <= IV_BYTES) return fail('malformed');
      const kek = await this.kekFor(envelope.s, this.deviceId, senderPublicKey);
      const cekRaw = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: asBufferSource(wrapBytes.subarray(0, IV_BYTES)),
            additionalData: asBufferSource(wrapAad(conversationId, envelope.s, this.deviceId)),
          },
          kek,
          asBufferSource(wrapBytes.subarray(IV_BYTES)),
        ),
      );
      const cek = await crypto.subtle.importKey('raw', asBufferSource(cekRaw), 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: asBufferSource(fromBase64(envelope.i)),
            additionalData: asBufferSource(bodyAad(conversationId, envelope.s)),
          },
          cek,
          asBufferSource(fromBase64(envelope.c)),
        ),
      );
      return { ok: true, plaintext: fromUtf8(plain), senderDeviceId: envelope.s, senderUserId: resolvedSenderUserId };
    } catch {
      // AES-GCM authentication failure (wrong key, tampered bytes, wrong conversation)
      // or undecodable base64. Deliberately indistinguishable to the caller.
      return fail('authentication_failed');
    }
  }
}
