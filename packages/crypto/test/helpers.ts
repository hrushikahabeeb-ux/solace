import {
  E2EEEngine,
  createCachingDirectory,
  generateDeviceIdentity,
  DirectoryUnavailableError,
  type DeviceRecord,
  type DeviceIdentity,
  type DirectoryFetcher,
} from '../src/index.js';

/** An in-memory stand-in for the server's device directory. */
export class FakeServer {
  devices: DeviceRecord[] = [];
  identities = new Map<string, DeviceIdentity>();
  down = false;
  userLookups = 0;
  deviceLookups = 0;

  async addDevice(userId: string, deviceId: string): Promise<DeviceIdentity> {
    const identity = await generateDeviceIdentity();
    this.devices.push({ userId, deviceId, publicKey: identity.publicKey });
    this.identities.set(deviceId, identity);
    return identity;
  }

  fetcher(): DirectoryFetcher {
    return {
      byUsers: async (userIds) => {
        this.userLookups++;
        if (this.down) throw new Error('network down');
        return this.devices.filter((d) => userIds.includes(d.userId));
      },
      byDeviceIds: async (deviceIds) => {
        this.deviceLookups++;
        if (this.down) throw new Error('network down');
        return this.devices.filter((d) => deviceIds.includes(d.deviceId));
      },
    };
  }

  engine(userId: string, deviceId: string, opts: { listTtlMs?: number } = {}): E2EEEngine {
    const identity = this.identities.get(deviceId);
    if (!identity) throw new Error(`unknown device ${deviceId}`);
    return new E2EEEngine({
      userId,
      deviceId,
      identity,
      directory: createCachingDirectory(this.fetcher(), { listTtlMs: opts.listTtlMs ?? 0 }),
    });
  }
}

export { DirectoryUnavailableError };
export const CONV = '11111111-1111-4111-8111-111111111111';
export const OTHER_CONV = '22222222-2222-4222-8222-222222222222';
