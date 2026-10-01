/**
 * Browser persistence for the device identity.
 *
 * What is stored: the device's non-extractable ECDH private key (as a CryptoKey object,
 * which IndexedDB can hold via structured clone) plus its public key. Nothing here is
 * derived from, or protected by, the user's password, so a page reload never leaves the
 * app in a "logged in but locked" state.
 *
 * What is NOT stored: message plaintext, session state, or any ratchet position. The
 * protocol is stateless (see engine.ts), so there is nothing else that can drift out of
 * sync or be lost.
 *
 * Threat-model note: a non-extractable key cannot be copied out by JavaScript, including
 * injected scripts, but a person with access to the unlocked browser profile on disk can
 * use it. That is the same trust boundary browser-based messengers such as Element Web
 * operate within.
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { DeviceIdentity } from './identity.js';

const DB_NAME = 'solace-e2ee';
const DB_VERSION = 1;
const STORE_IDENTITIES = 'identities';
const STORE_META = 'meta';

interface StoredIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
  createdAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_IDENTITIES)) db.createObjectStore(STORE_IDENTITIES);
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      },
    }).catch((err) => {
      // Do not cache a failed open; the next call gets a fresh attempt.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export async function saveIdentity(deviceId: string, identity: DeviceIdentity): Promise<void> {
  const db = await getDb();
  const record: StoredIdentity = {
    deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAt: Date.now(),
  };
  await db.put(STORE_IDENTITIES, record, deviceId);
}

export async function loadIdentity(deviceId: string): Promise<DeviceIdentity | null> {
  const db = await getDb();
  const record = (await db.get(STORE_IDENTITIES, deviceId)) as StoredIdentity | undefined;
  if (!record || !record.privateKey || typeof record.publicKey !== 'string') return null;
  return { privateKey: record.privateKey, publicKey: record.publicKey };
}

/** Remembers which device belongs to which username in this browser, so logging in
 *  again reuses the same identity instead of creating a new device every time. */
export async function setCurrentDeviceId(username: string, deviceId: string): Promise<void> {
  const db = await getDb();
  await db.put(STORE_META, deviceId, `currentDevice:${username}`);
}

export async function getCurrentDeviceId(username: string): Promise<string | null> {
  const db = await getDb();
  return ((await db.get(STORE_META, `currentDevice:${username}`)) as string | undefined) ?? null;
}

const LEGACY_LOCAL_STORAGE_PREFIXES = ['solace:decrypted:', 'solace:sent:', 'solace:currentDeviceId:'];
const LEGACY_DB_NAME = 'solace-vault';

/**
 * Removes everything the previous Olm-based implementation left behind: the Olm account
 * and session pickles in IndexedDB, and the plaintext caches it kept in localStorage.
 * None of it is usable by this version, and the plaintext caches are a needless
 * confidentiality risk. Best-effort and safe to call on every start.
 */
export async function purgeLegacyStorage(): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && LEGACY_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
          localStorage.removeItem(key);
        }
      }
    }
  } catch {
    // Storage may be unavailable (privacy mode); nothing to clean in that case.
  }
  try {
    if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    // Same reasoning as above.
  }
}
