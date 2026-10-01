import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCachingDirectory, DirectoryUnavailableError } from '../src/index.js';
import { FakeServer } from './helpers.js';

test('concurrent lookups for the same user share one request', async () => {
  const server = new FakeServer();
  await server.addDevice('bob', 'bob-1');
  const dir = createCachingDirectory(server.fetcher(), { listTtlMs: 60_000 });
  await Promise.all(Array.from({ length: 25 }, () => dir.listDevices(['bob'])));
  assert.equal(server.userLookups, 1);
  await dir.listDevices(['bob']);
  assert.equal(server.userLookups, 1); // still cached
});

test('device lists expire so a newly registered device is picked up', async () => {
  const server = new FakeServer();
  await server.addDevice('bob', 'bob-1');
  let clock = 0;
  const dir = createCachingDirectory(server.fetcher(), { listTtlMs: 1_000, now: () => clock });
  assert.equal((await dir.listDevices(['bob'])).length, 1);
  await server.addDevice('bob', 'bob-2');
  assert.equal((await dir.listDevices(['bob'])).length, 1); // within TTL
  clock = 1_500;
  assert.equal((await dir.listDevices(['bob'])).length, 2); // expired
});

test('device-by-id lookups are cached and de-duplicated; misses are not cached', async () => {
  const server = new FakeServer();
  await server.addDevice('bob', 'bob-1');
  const dir = createCachingDirectory(server.fetcher());
  await Promise.all(Array.from({ length: 30 }, () => dir.getDevice('bob-1')));
  assert.equal(server.deviceLookups, 1);
  assert.equal(await dir.getDevice('nope'), null);
  assert.equal(await dir.getDevice('nope'), null);
  assert.equal(server.deviceLookups, 3);
});

test('failures surface as DirectoryUnavailableError and are not cached', async () => {
  const server = new FakeServer();
  await server.addDevice('bob', 'bob-1');
  const dir = createCachingDirectory(server.fetcher(), { listTtlMs: 60_000 });
  server.down = true;
  await assert.rejects(() => dir.listDevices(['bob']), DirectoryUnavailableError);
  await assert.rejects(() => dir.getDevice('bob-1'), DirectoryUnavailableError);
  server.down = false;
  assert.equal((await dir.listDevices(['bob'])).length, 1);
  assert.equal((await dir.getDevice('bob-1'))?.userId, 'bob');
});

test('a DirectoryUnavailableError from a duplicate copy of the module is still recognised', async () => {
  const { isDirectoryUnavailable } = await import('../src/index.js');
  class Foreign extends Error {
    constructor() {
      super('other copy');
      this.name = 'DirectoryUnavailableError';
    }
  }
  assert.equal(isDirectoryUnavailable(new Foreign()), true);
  assert.equal(isDirectoryUnavailable(new Error('nope')), false);
  const dir = createCachingDirectory({
    byUsers: async () => {
      throw new Foreign();
    },
    byDeviceIds: async () => [],
  });
  await assert.rejects(() => dir.listDevices(['x']), (err: unknown) => isDirectoryUnavailable(err));
});
