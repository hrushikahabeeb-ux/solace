/**
 * The device directory is how a client learns which devices a user currently has and
 * what their public keys are. It is deliberately an interface: the crypto package has no
 * knowledge of HTTP, so the web app supplies a fetcher and this module adds the caching
 * and request de-duplication that keeps message sending and history loading cheap.
 */

export interface DeviceRecord {
  userId: string;
  deviceId: string;
  /** Base64 raw P-256 public key (see identity.ts). */
  publicKey: string;
}

export interface DeviceDirectory {
  /** The devices that should receive new messages addressed to these users. */
  listDevices(userIds: string[]): Promise<DeviceRecord[]>;
  /** Looks up one device by id regardless of how old it is (needed to verify senders of
   *  historical messages). Resolves to null when the server does not know the device. */
  getDevice(deviceId: string): Promise<DeviceRecord | null>;
}

/** Thrown when the directory could not be reached. Callers treat this as retryable,
 *  unlike a definitive "device does not exist" answer. */
export class DirectoryUnavailableError extends Error {
  constructor(message = 'Device directory is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DirectoryUnavailableError';
  }
}

/** Recognises the error by name as well as by class. Bundlers and test runners can end
 *  up with two copies of this module, and `instanceof` silently fails across copies. */
export function isDirectoryUnavailable(err: unknown): err is DirectoryUnavailableError {
  return err instanceof DirectoryUnavailableError || (err instanceof Error && err.name === 'DirectoryUnavailableError');
}

export interface DirectoryFetcher {
  byUsers(userIds: string[]): Promise<DeviceRecord[]>;
  byDeviceIds(deviceIds: string[]): Promise<DeviceRecord[]>;
}

export interface CachingDirectoryOptions {
  /** How long a user's device list is reused. Kept short on purpose: a device that
   *  registered a moment ago must be picked up by the very next message. */
  listTtlMs?: number;
  now?: () => number;
}

async function asDirectoryError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isDirectoryUnavailable(err)) throw err;
    throw new DirectoryUnavailableError('Device directory request failed', { cause: err });
  }
}

export function createCachingDirectory(fetcher: DirectoryFetcher, options: CachingDirectoryOptions = {}): DeviceDirectory {
  const listTtlMs = options.listTtlMs ?? 15_000;
  const now = options.now ?? Date.now;

  const userCache = new Map<string, { at: number; devices: DeviceRecord[] }>();
  const userInflight = new Map<string, Promise<DeviceRecord[]>>();
  // A device id maps to one public key for its whole life, so positive lookups never expire.
  const deviceCache = new Map<string, DeviceRecord>();
  const deviceInflight = new Map<string, Promise<DeviceRecord | null>>();

  async function listDevices(userIds: string[]): Promise<DeviceRecord[]> {
    const unique = [...new Set(userIds)];
    const pending: Promise<DeviceRecord[]>[] = [];
    const toFetch: string[] = [];

    for (const userId of unique) {
      const cached = userCache.get(userId);
      if (cached && now() - cached.at < listTtlMs) {
        pending.push(Promise.resolve(cached.devices));
        continue;
      }
      const inflight = userInflight.get(userId);
      if (inflight) {
        pending.push(inflight);
        continue;
      }
      toFetch.push(userId);
    }

    if (toFetch.length > 0) {
      const batch = asDirectoryError(fetcher.byUsers(toFetch));
      for (const userId of toFetch) {
        const promise = batch
          .then((all) => {
            const devices = all.filter((d) => d.userId === userId);
            userCache.set(userId, { at: now(), devices });
            for (const device of devices) deviceCache.set(device.deviceId, device);
            return devices;
          })
          .finally(() => userInflight.delete(userId));
        userInflight.set(userId, promise);
        pending.push(promise);
      }
    }

    return (await Promise.all(pending)).flat();
  }

  async function getDevice(deviceId: string): Promise<DeviceRecord | null> {
    const cached = deviceCache.get(deviceId);
    if (cached) return cached;
    const inflight = deviceInflight.get(deviceId);
    if (inflight) return inflight;

    const promise = asDirectoryError(fetcher.byDeviceIds([deviceId]))
      .then((all) => {
        const found = all.find((d) => d.deviceId === deviceId) ?? null;
        if (found) deviceCache.set(deviceId, found);
        return found;
      })
      .finally(() => deviceInflight.delete(deviceId));
    deviceInflight.set(deviceId, promise);
    return promise;
  }

  return { listDevices, getDevice };
}
