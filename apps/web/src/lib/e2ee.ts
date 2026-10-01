'use client';

/**
 * The web app's single entry point to end-to-end encryption. It wires the framework-free
 * engine in @solace/crypto to the HTTP API and adds the two behaviours that only make
 * sense in the browser: retrying transient directory failures, and turning failure
 * reasons into text a person can read.
 *
 * Every function here is stateless with respect to conversations. There is no session to
 * establish, no key to wait for, and no ordering requirement, so callers may decrypt
 * whatever they like, whenever they like, as often as they like, in parallel.
 */
import {
  createCachingDirectory,
  DirectoryUnavailableError,
  isDirectoryUnavailable,
  parseSessionRef,
  type DecryptFailure,
  type DeviceDirectory,
  type E2EEEngine,
} from '@solace/crypto';
import { api } from './api';

export type { E2EEEngine };
export { parseSessionRef };

/** Builds the device directory the engine uses, always reading the CURRENT access token
 *  (it changes every few minutes as the session refreshes). */
export function createDeviceDirectory(getAccessToken: () => string | null): DeviceDirectory {
  async function fetchDevices(query: { userIds?: string[]; deviceIds?: string[] }) {
    const token = getAccessToken();
    if (!token) throw new DirectoryUnavailableError('Not signed in');
    const { devices } = await api.lookupDevices(query, token);
    return devices.map((d) => ({ userId: d.userId, deviceId: d.deviceId, publicKey: d.identityKeyPublic }));
  }
  return createCachingDirectory({
    byUsers: (userIds) => fetchDevices({ userIds }),
    byDeviceIds: (deviceIds) => fetchDevices({ deviceIds }),
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RETRY_DELAYS_MS = [400, 1200, 3000];

export type DecryptOutcome = { ok: true; plaintext: string } | { ok: false; reason: DecryptFailure };

/** Decrypts one ciphertext, retrying only the failures that can heal by themselves
 *  (the directory being briefly unreachable). Everything else is final. */
export async function decryptMessage(
  engine: E2EEEngine,
  params: { conversationId: string; ciphertext: string; senderUserId?: string },
): Promise<DecryptOutcome> {
  for (let attempt = 0; ; attempt++) {
    const result = await engine.decrypt(params);
    if (result.ok) return { ok: true, plaintext: result.plaintext };
    if (!result.retryable || attempt >= RETRY_DELAYS_MS.length) return { ok: false, reason: result.reason };
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

/** Text shown in place of a message that cannot be displayed. */
export function describeDecryptFailure(reason: DecryptFailure): string {
  switch (reason) {
    case 'legacy':
      return '\uD83D\uDD12 Sent with the previous encryption version \u2014 not available after the upgrade';
    case 'not_for_this_device':
      return '\uD83D\uDD12 Sent before this device was set up \u2014 not available here';
    case 'directory_unavailable':
      return '\uD83D\uDD12 Could not reach the server to verify the sender \u2014 reopen the chat to retry';
    case 'unknown_sender':
    case 'sender_mismatch':
    case 'authentication_failed':
    case 'malformed':
    default:
      return '\u26A0\uFE0F Could not verify or decrypt this message';
  }
}

/** Encrypts one string for a conversation. `memberUserIds` are the OTHER members; the
 *  sender's own devices are always included so the sender can read it back. */
export async function encryptForConversation(
  engine: E2EEEngine,
  params: { conversationId: string; memberUserIds: string[]; plaintext: string },
): Promise<{ ciphertext: string; olmMessageType: number; sessionRef: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await engine.encrypt({
        conversationId: params.conversationId,
        recipientUserIds: params.memberUserIds,
        plaintext: params.plaintext,
      });
      // `olmMessageType` is a leftover column from the Olm-based protocol. The API and
      // database still require it, so it is sent as a constant.
      return { ciphertext: result.ciphertext, olmMessageType: 0, sessionRef: result.sessionRef };
    } catch (err) {
      lastError = err;
      if (!isDirectoryUnavailable(err)) throw err;
      await sleep(500);
    }
  }
  throw lastError;
}

/** Encrypts workspace content (task titles, event fields, notes, poll options, folder
 *  names, ...). Identical to chat encryption; the two share one code path. */
export const encryptForWorkspace = encryptForConversation;

/** The read-side counterpart: the conversation and sender device are recorded in the
 *  `sessionRef` stored next to every encrypted workspace field. Resolves to null when
 *  the field cannot be shown, matching what the UI components already expect. */
export async function decryptWorkspaceField(
  ciphertext: string,
  sessionRef: string,
  engine: E2EEEngine,
): Promise<string | null> {
  const parsed = parseSessionRef(sessionRef);
  if (!parsed) return null;
  const result = await decryptMessage(engine, { conversationId: parsed.conversationId, ciphertext });
  return result.ok ? result.plaintext : null;
}
